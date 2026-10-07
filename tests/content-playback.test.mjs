import assert from "node:assert/strict";
import test from "node:test";
import { build } from "vite";
import { JSDOM } from "jsdom";
import { createArticleSource } from "../extension/reading-source.ts";
import { saveReading, updateReading, resumeOffset } from "../extension/reading-list-store.ts";

const [bundle] = await build({
  configFile: false,
  logLevel: "silent",
  build: {
    write: false,
    lib: { entry: "extension/content.ts", name: "Readflow", formats: ["iife"] },
  },
});
const script = bundle.output.find(output => output.type === "chunk").code;
const voices = [
  { id: "b347db033a6549378b48d00acb0d06cd", name: "Selene", languages: ["en"] },
  { id: "11111111111111111111111111111111", name: "Mira", languages: ["en"] },
];
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture({ resume = false, savedReads = [] } = {}) {
  const dom = new JSDOM(`<!doctype html><title>Playback review</title><article>
    <h1>Playback review</h1>
    <p id="first">First passage explains how reading controls work together on an article page.
    A reader can listen, pause, choose another voice, and continue without losing their place.
    The earlier paragraph must never receive a highlight or an automatic scroll meant for later text.</p>
    <p id="second">Second passage begins where this saved reading session should resume.
    Its words must stay linked to the correct paragraph after a voice change.
    Reading progress must continue to refer to the full original article, including its earlier paragraphs.</p>
    <p id="third">Third passage gives us enough article text to exercise the extraction and playback controls.
    Seeking and speed changes should reuse audio already in memory, while a new voice requests the remaining text.</p>
  </article>`, { url: "https://example.com/article", runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  const source = createArticleSource(window.document);
  const reads = structuredClone(savedReads);
  const messages = [];
  const ports = [];
  const contexts = [];
  const frames = new Map();
  const followed = [];
  const messageListeners = [];
  let frameId = 0;
  let now = 300;
  if (resume) {
    const item = saveReading(reads, { url: window.location.href, title: window.document.title, source: "article", text: source.text }, "previous");
    updateReading(reads, item.id, "previous", source.text.indexOf("Second passage") + 12, false);
  }
  Object.defineProperty(window.performance, "now", { value: () => now });
  window.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
  window.cancelAnimationFrame = id => frames.delete(id);
  window.matchMedia = () => ({ matches: true });
  window.scrollBy = () => {};
  window.Range.prototype.getClientRects = function () {
    followed.push({ paragraph: this.startContainer.parentElement.id, text: this.toString() });
    return [{ top: 900, bottom: 924, width: 100, height: 24 }];
  };
  window.Range.prototype.getBoundingClientRect = () => ({ top: 300, bottom: 324, left: 200, width: 100, height: 24 });
  window.CSS = { highlights: new Map() };
  window.Highlight = class extends Set {};
  window.AudioContext = class {
    state = "running";
    currentTime = 0;
    destination = {};
    sources = [];
    constructor() { contexts.push(this); }
    async resume() { this.state = "running"; }
    async suspend() { this.state = "suspended"; }
    async close() { this.state = "closed"; }
    getOutputTimestamp() { return { contextTime: this.currentTime }; }
    createBuffer(_channels, length, sampleRate) {
      const samples = new Float32Array(length);
      return { length, sampleRate, copyToChannel(input) { samples.set(input); }, getChannelData() { return samples; } };
    }
    createBufferSource() {
      const audio = { playbackRate: { value: 1 }, connect() {}, start() {}, stop() {} };
      this.sources.push(audio);
      return audio;
    }
  };
  window.chrome = {
    runtime: {
      id: "review",
      onMessage: { addListener(listener) { messageListeners.push(listener); } },
      async sendMessage(message) {
        messages.push(structuredClone(message));
        if (message.type === "voice_settings") return { selected: voices[0], favorites: voices };
        if (message.type === "reading_for_page") return { item: structuredClone(reads[0]) };
        if (message.type === "reading_save") return { item: structuredClone(saveReading(reads, message.item, message.sessionId)) };
        if (message.type === "reading_progress") updateReading(reads, message.id, message.sessionId, message.offset, message.completed);
        return { ok: true };
      },
      connect() {
        const listeners = [];
        const disconnectListeners = [];
        const port = {
          sent: [], disconnected: false,
          onMessage: { addListener(listener) { listeners.push(listener); } },
          onDisconnect: { addListener(listener) { disconnectListeners.push(listener); } },
          postMessage(message) { this.sent.push(structuredClone(message)); },
          disconnect() {
            if (this.disconnected) return;
            this.disconnected = true;
            for (const listener of disconnectListeners) listener();
          },
          emit(message) { for (const listener of listeners) listener(message); },
        };
        ports.push(port);
        return port;
      },
    },
  };
  window.eval(script);
  await tick();
  const shadow = window.document.getElementById("readflow-controls").shadowRoot;
  const click = async id => { shadow.getElementById(id).click(); await tick(); };
  const advance = seconds => {
    contexts.at(-1).currentTime = seconds;
    now += 300;
    const callbacks = [...frames.values()];
    frames.clear();
    for (const callback of callbacks) callback(now);
  };
  const audio = (seconds = 4, finish = false) => {
    const port = ports.at(-1);
    const start = port.sent.find(message => message.type === "start");
    port.emit({
      event: "audio", section_index: 0, section_start_frame: 0, chunk_seq: 0,
      audio_base64: Buffer.alloc(seconds * 44_100 * 2).toString("base64"),
      alignment: { segments: start.sections[0].text.trim().split(/\s+/).map((text, index) => ({ text, start: index * 0.1, end: (index + 1) * 0.1 })) },
    });
    if (finish) port.emit({ event: "finish" });
  };
  const chooseVoice = async name => {
    await click("voice-button");
    [...shadow.querySelectorAll(".voice-select")].find(button => button.textContent === name).click();
    await tick();
  };
  return { window, source, reads, messages, ports, contexts, shadow, followed, click, advance, audio, chooseVoice, messageListeners, close: () => dom.window.close() };
}

test("summoned player starts compact without audio and repeat activation keeps one player", async t => {
  const f = await fixture();
  t.after(f.close);
  assert.equal(f.shadow.getElementById("dock").dataset.compact, "true");
  assert.equal(f.shadow.getElementById("full-player").hidden, true);
  assert.equal(f.shadow.getElementById("mini-player").hidden, false);
  assert.equal(f.ports.length, 0);
  assert.equal(f.contexts.length, 0);
  let response;
  for (const listener of f.messageListeners) listener({ type: "show_readflow" }, {}, value => { response = value; });
  assert.equal(response.ok, true);
  f.window.eval(script);
  assert.equal(f.window.document.querySelectorAll("#readflow-controls").length, 1);
  assert.equal(f.messageListeners.length, 1);
  await f.click("mini-action-button");
  assert.equal(f.ports.length, 1, "only the user's play action starts audio");
});

test("saved progress, highlighting, and auto-scroll share the same source after repeated voice changes", async t => {
  const f = await fixture({ resume: true });
  t.after(f.close);
  const expectedStart = resumeOffset(f.source.text, f.reads[0].offset);
  assert.equal(f.shadow.getElementById("article-button").textContent, "Resume read");
  await f.click("article-button");
  assert.equal(f.ports[0].sent.find(message => message.type === "start").text, f.source.text.slice(expectedStart));
  f.audio();
  f.advance(0.25);
  assert.equal(f.followed.at(-1).paragraph, "second");
  const highlight = [...f.window.CSS.highlights.get("readflow-current-sentence")];
  assert.equal(highlight[0].startContainer.parentElement.id, "second");
  await f.click("pause-button");
  const checkpoint = f.reads[0].offset;
  assert.ok(checkpoint >= expectedStart);
  await f.chooseVoice("Mira");
  assert.equal(f.ports.length, 2);
  assert.equal(f.ports[0].disconnected, true);
  assert.equal(f.contexts[1].state, "suspended");
  assert.equal(f.ports[1].sent.find(message => message.type === "start").referenceId, voices[1].id);
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].text, f.source.text);
  f.audio();
  await f.click("pause-button");
  f.advance(0.25);
  assert.equal(f.followed.at(-1).paragraph, "second");
  await f.chooseVoice("Selene");
  assert.equal(f.ports.length, 3);
  f.audio();
  f.advance(0.25);
  assert.equal(f.followed.at(-1).paragraph, "second");
  await f.click("stop-button");
  assert.ok(f.reads[0].offset >= checkpoint);
  assert.equal(f.reads[0].status, "in-progress");
  assert.equal(f.window.CSS.highlights.get("readflow-current-sentence").size, 0);
});

test("save for later, player sizing, speed, pause, and seek preserve the current stream", async t => {
  const f = await fixture();
  t.after(f.close);
  await f.click("save-button");
  assert.equal(f.reads[0].status, "queued");
  assert.equal(f.shadow.getElementById("save-button").getAttribute("aria-pressed"), "true");
  assert.equal(f.shadow.getElementById("save-button").closest("#tape-heading") !== null, true);
  assert.equal(f.shadow.querySelector("#save-button svg") !== null, true);
  assert.equal(f.ports.length, 0);
  await f.click("reads-button");
  await f.click("debug-button");
  assert.ok(f.messages.some(message => message.type === "open_reading_list"));
  assert.ok(f.messages.some(message => message.type === "open_diagnostics"));
  await f.click("minimize-button");
  assert.equal(f.shadow.getElementById("full-player").hidden, true);
  await f.click("expand-button");
  assert.equal(f.shadow.getElementById("full-player").hidden, false);
  await f.click("article-button");
  f.audio();
  f.advance(0.5);
  await f.click("pause-button");
  const slider = f.shadow.getElementById("speed-slider");
  slider.value = "1.2";
  slider.dispatchEvent(new f.window.Event("input"));
  assert.equal(f.contexts[0].state, "suspended");
  assert.ok(f.ports[0].sent.some(message => message.type === "set_speed" && message.rate === 1.2));
  await f.click("forward-button");
  assert.match(f.shadow.getElementById("status").textContent, /Buffering to/);
  await f.click("rewind-button");
  assert.equal(f.ports.length, 1);
  assert.ok(f.contexts[0].sources.every(audio => audio.playbackRate.value === 1));
  await f.click("pause-button");
  assert.equal(f.contexts[0].state, "running");
  await f.click("stop-button");
  assert.equal(f.ports[0].disconnected, true);
});

test("replaying a completed listen restores progress and voice switching", async t => {
  const f = await fixture();
  t.after(f.close);
  await f.click("article-button");
  f.audio(4, true);
  f.advance(4.1);
  for (const audio of f.contexts[0].sources) audio.onended?.();
  assert.equal(f.reads[0].status, "completed");
  assert.equal(f.shadow.getElementById("dock").dataset.transport, "finished");
  await f.click("pause-button");
  assert.equal(f.reads[0].status, "in-progress");
  assert.equal(f.ports.length, 1);
  f.advance(4.4);
  await f.chooseVoice("Mira");
  assert.equal(f.ports.length, 2);
  assert.equal(f.ports[1].sent.find(message => message.type === "start").referenceId, voices[1].id);
});

test("selected text stays separate from the article and its highlights clear on stop", async t => {
  const f = await fixture();
  t.after(f.close);
  const range = f.window.document.createRange();
  range.selectNodeContents(f.window.document.getElementById("second"));
  f.window.getSelection().addRange(range);
  f.window.document.dispatchEvent(new f.window.Event("selectionchange"));
  await f.click("selection-button");
  const start = f.ports[0].sent.find(message => message.type === "start");
  assert.equal(start.source, "selection");
  assert.match(start.text, /^Second passage/);
  assert.equal(start.text.includes("First passage"), false);
  assert.equal(f.reads[0].source, "selection");
  f.audio();
  f.advance(0.25);
  assert.ok(f.window.CSS.highlights.get("readflow-selected-passage").size);
  assert.ok(f.window.CSS.highlights.get("readflow-selected-sentence").size);
  await f.click("stop-button");
  assert.equal(f.window.CSS.highlights.get("readflow-selected-passage").size, 0);
  assert.equal(f.window.CSS.highlights.get("readflow-selected-sentence").size, 0);
});

test("word seeking after a saved resume uses full article offsets and can seek backward", async t => {
  const f = await fixture({ resume: true });
  t.after(f.close);
  await f.click("article-button");
  f.audio();
  f.advance(0.25);
  await f.click("pause-button");
  const selectWord = (paragraph, start, end) => {
    const element = f.window.document.getElementById(paragraph);
    const range = f.window.document.createRange();
    range.setStart(element.firstChild, start);
    range.setEnd(element.firstChild, end);
    f.window.getSelection().removeAllRanges();
    f.window.getSelection().addRange(range);
    element.dispatchEvent(new f.window.MouseEvent("dblclick", { bubbles: true }));
  };
  selectWord("second", 7, 14);
  await tick();
  assert.equal(f.ports.length, 1, "cached word in resumed source reuses audio");
  assert.equal(f.contexts[0].state, "running");
  selectWord("first", 0, 5);
  await tick();
  assert.equal(f.ports.length, 2);
  assert.match(f.ports[1].sent.find(message => message.type === "start").text, /^First passage/);
  f.audio();
  f.advance(0.25);
  assert.equal(f.followed.at(-1).paragraph, "first");
  assert.equal(f.reads[0].text, f.source.text);
});

test("connection recovery after saved resume retains the absolute word offset and pause", async t => {
  const f = await fixture({ resume: true });
  t.after(f.close);
  await f.click("article-button");
  f.audio();
  f.advance(0.25);
  await f.click("pause-button");
  const checkpoint = f.reads[0].offset;
  f.ports[0].disconnect();
  await tick();
  assert.equal(f.ports.length, 2);
  assert.equal(f.contexts[1].state, "suspended");
  assert.equal(f.ports[1].sent.find(message => message.type === "start").text, f.source.text.slice(checkpoint));
  assert.equal(f.reads[0].text, f.source.text);
  f.audio();
  await f.click("pause-button");
  f.advance(0.25);
  assert.equal(f.followed.at(-1).paragraph, "second");
});

test("reopening a saved read starts at its current word without repeating the sentence", async t => {
  const f = await fixture({ resume: true });
  t.after(f.close);
  const wordOffset = f.source.text.indexOf("passage", f.source.text.indexOf("Second passage"));
  await f.click("article-button");
  assert.equal(f.ports[0].sent.find(message => message.type === "start").text, f.source.text.slice(wordOffset));
  await f.click("stop-button");
  assert.equal(f.reads[0].offset, wordOffset);
  await f.click("article-button");
  assert.equal(f.ports[1].sent.find(message => message.type === "start").text, f.source.text.slice(wordOffset));
});

test("rewinding to the beginning saves zero even before another word is audible", async t => {
  const f = await fixture();
  t.after(f.close);
  await f.click("article-button");
  f.audio();
  f.advance(1.25);
  await f.click("pause-button");
  assert.ok(f.reads[0].offset > 0);
  await f.click("rewind-button");
  await f.click("stop-button");
  assert.equal(f.reads[0].offset, 0);
  await f.click("article-button");
  assert.equal(f.ports[1].sent.find(message => message.type === "start").text, f.source.text);
});

test("hiding the tab saves the audible word before animation frames are throttled", async t => {
  const f = await fixture();
  t.after(f.close);
  await f.click("article-button");
  f.audio();
  f.advance(1.25);
  assert.equal(f.reads[0].offset, 0, "periodic progress has not run yet");
  Object.defineProperty(f.window.document, "visibilityState", { value: "hidden" });
  f.window.document.dispatchEvent(new f.window.Event("visibilitychange"));
  await tick();
  assert.ok(f.reads[0].offset > 0);
  const saves = f.messages.filter(message => message.type === "reading_progress").length;
  await f.click("stop-button");
  f.window.document.dispatchEvent(new f.window.Event("visibilitychange"));
  await tick();
  assert.equal(f.messages.filter(message => message.type === "reading_progress").length, saves + 1);
});

test("jumping two paragraphs ahead resumes at the audible word after reopening the article", async t => {
  const f = await fixture();
  t.after(f.close);
  await f.click("article-button");
  f.audio();
  f.advance(0.25);
  const paragraph = f.window.document.getElementById("third");
  const range = f.window.document.createRange();
  range.setStart(paragraph.firstChild, 6);
  range.setEnd(paragraph.firstChild, 13);
  f.window.getSelection().addRange(range);
  paragraph.dispatchEvent(new f.window.MouseEvent("dblclick", { bubbles: true }));
  await tick();
  const jumpedOffset = f.source.text.indexOf("passage", f.source.text.indexOf("Third passage"));
  assert.equal(f.ports[1].sent.find(message => message.type === "start").text, f.source.text.slice(jumpedOffset));
  f.audio();
  f.advance(0.36);
  await f.click("stop-button");
  const expectedOffset = f.source.text.indexOf("enough", jumpedOffset);
  assert.equal(f.reads[0].offset, expectedOffset);
  const reopened = await fixture({ savedReads: f.reads });
  t.after(reopened.close);
  assert.equal(reopened.shadow.getElementById("article-button").textContent, "Resume read");
  await reopened.click("article-button");
  assert.equal(reopened.ports[0].sent.find(message => message.type === "start").text, f.source.text.slice(expectedOffset));
  reopened.audio();
  reopened.advance(0.25);
  assert.equal(reopened.followed.at(-1).paragraph, "third");
});

test("later sections keep exact word checkpoints when earlier audio has no alignment", async t => {
  const f = await fixture();
  t.after(f.close);
  await f.click("article-button");
  const port = f.ports[0];
  const start = port.sent.find(message => message.type === "start");
  port.emit({ event: "audio", section_index: 0, section_start_frame: 0,
    audio_base64: Buffer.alloc(4 * 44_100 * 2).toString("base64") });
  const section = start.sections[1];
  const words = [...section.text.matchAll(/\S+/g)];
  port.emit({ event: "audio", section_index: 1, section_start_frame: 4 * 44_100,
    chunk_seq: 0, chunk_audio_offset_sec: 4,
    audio_base64: Buffer.alloc(4 * 44_100 * 2).toString("base64"),
    alignment: { segments: words.map((word, index) => ({ text: word[0], start: index * 0.1, end: (index + 1) * 0.1 })) } });
  f.advance(4.3);
  await f.click("pause-button");
  assert.equal(f.reads[0].offset, section.start + words[2].index);
  await f.click("stop-button");
  await f.click("article-button");
  assert.equal(f.ports[1].sent.find(message => message.type === "start").text, f.source.text.slice(section.start + words[2].index));
});
