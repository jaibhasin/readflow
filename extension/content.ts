import { resumeOffset, type ReadingItem } from "./reading-list-store";
import { mapReadingOffsets } from "./reading-progress";
import { sentenceSpans } from "./text-map";
import { mapSentenceTimings, type SentenceTiming } from "./highlight-timeline";
import { createPageHighlighter, type PageSentenceHighlighter } from "./page-highlighter";
import { createArticleSource, createSelectionSource, sliceReadingSource, sourceRanges, type ReadingSource } from "./reading-source";
import { createReadingAutoScroller } from "./auto-scroll";
import { bufferFramesForSpeed, isAudioAudible, playbackDuration, playedFrames } from "./playback-speed";
import { StreamingTimeStretch } from "./time-stretch";
import { resolveSeekTarget } from "./seek-target";
import { prepareSpokenSource } from "./spoken-text";
import { splitTextSections } from "./text-sections";
import { shortTapeTitle } from "./tape-label";
import { extensionRuntime, RECONNECT_MESSAGE, sendExtensionMessage } from "./extension-runtime";
import { createVoicePicker } from "./voice-picker";
import type { FishVoice } from "./voices";

let stopCurrentPlayback: (() => void) | null = null;
let setCurrentPlaybackSpeed: ((rate: number) => void) | null = null;
let changePlaybackVoice: ((voice: FishVoice) => void) | null = null;
let selectedPlaybackRate = 1;
const SAMPLE_RATE = 44_100;
const START_BUFFER_SECONDS = 3;
const DEFAULT_VOICE: FishVoice = {
  id: "b347db033a6549378b48d00acb0d06cd",
  name: "Selene",
  languages: ["en"],
};
const initialArticleSource = createArticleSource(document);
let pageSentenceHighlighter: PageSentenceHighlighter | null = null;
const voicePickers = new WeakMap<HTMLElement, ReturnType<typeof createVoicePicker>>();

type WordTiming = {
  text: string;
  start: number;
  end: number;
};

type ChunkAlignment = {
  offset: number;
  segments: WordTiming[];
};

type TransportState = "idle" | "connecting" | "buffering" | "playing" | "paused" | "finished" | "stopped" | "error";

if (initialArticleSource && !document.getElementById("readflow-controls")) {
  const controls = createControls();
  document.documentElement.append(controls.host);
  const voicePicker = createVoicePicker(controls.host.shadowRoot!, controls.dock, (voice) => changePlaybackVoice?.(voice));
  voicePickers.set(controls.host, voicePicker);

  let savedRead: ReadingItem | undefined;
  const readingLookup = sendExtensionMessage<{ item?: ReadingItem; error?: string }>({ type: "reading_for_page" }).then((result) => {
    savedRead = result.item;
    if (savedRead?.status === "in-progress") controls.articleButton.textContent = "Resume read";
    else if (savedRead?.source === "selection") controls.articleButton.textContent = "Listen to saved passage";
  }).catch(() => undefined);

  const saveForLater = async (): Promise<{ ok?: boolean; error?: string }> => {
    const article = createArticleSource(document);
    if (!article) return { error: "This page no longer has readable article text." };
    const result = await sendExtensionMessage<{ item?: ReadingItem; error?: string }>({
      type: "reading_save", item: { url: location.href, title: document.title, source: "article", text: article.text },
    });
    if (result.error) return { error: result.error };
    controls.saveButton.textContent = "Saved for later";
    return { ok: true };
  };
  controls.saveButton.addEventListener("click", () => {
    controls.saveButton.disabled = true;
    void saveForLater().then((result) => {
      setPlayerStatus(controls, result.error || "Saved for later");
      controls.status.hidden = false;
    }).catch(() => setPlayerStatus(controls, RECONNECT_MESSAGE)).finally(() => { controls.saveButton.disabled = false; });
  });
  controls.readsButton.addEventListener("click", () => {
    void sendExtensionMessage({ type: "open_reading_list" }).catch(() => setPlayerStatus(controls, RECONNECT_MESSAGE));
  });
  extensionRuntime().onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "save_read") return;
    void saveForLater().then(sendResponse).catch(() => sendResponse({ error: RECONNECT_MESSAGE }));
    return true;
  });

  controls.articleButton.addEventListener("click", async () => {
    await readingLookup;
    const readingSource = createArticleSource(document);
    if (readingSource) {
      const resume = savedRead;
      savedRead = undefined;
      controls.articleButton.textContent = "Listen to article";
      if (resume?.source === "selection") {
        const start = readingSource.text.indexOf(resume.text);
        const selection = start >= 0 ? sliceReadingSource(readingSource, start, start + resume.text.length)
          : { text: resume.text, spans: [], sentences: sentenceSpans(resume.text) };
        void startPlayback(controls, selection, "Selected text", undefined, {}, resume);
      } else {
        if (resume && resume.text !== readingSource.text) {
          setPlayerStatus(controls, "This article has changed. Choose Listen to article to start its current text.");
          controls.status.hidden = false;
          return;
        }
        void startPlayback(controls, readingSource, "Article", undefined, {}, resume);
      }
    } else {
      setPlayerStatus(controls, "This page no longer has readable article text.");
      controls.status.hidden = false;
    }
  });

  controls.debugButton.addEventListener("click", () => {
    void sendExtensionMessage({ type: "open_diagnostics" }).catch(() => {
      setPlayerStatus(controls, RECONNECT_MESSAGE);
    });
  });

  const closeSpeedPanel = (): void => {
    controls.speedPanel.hidden = true;
    controls.speedButton.setAttribute("aria-expanded", "false");
  };

  controls.speedButton.addEventListener("click", () => {
    voicePicker.close();
    controls.speedPanel.hidden = !controls.speedPanel.hidden;
    controls.speedButton.setAttribute("aria-expanded", String(!controls.speedPanel.hidden));
    if (!controls.speedPanel.hidden) controls.speedSlider.focus({ preventScroll: true });
  });

  controls.speedValue.addEventListener("click", closeSpeedPanel);
  document.addEventListener("pointerdown", (event) => {
    const path = event.composedPath();
    if (!path.includes(controls.speedPanel) && !path.includes(controls.speedButton)) closeSpeedPanel();
  });
  controls.speedPanel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeSpeedPanel();
      controls.speedButton.focus({ preventScroll: true });
    }
  });

  controls.speedSlider.addEventListener("input", () => {
    selectedPlaybackRate = Number(controls.speedSlider.value);
    const label = `${selectedPlaybackRate.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}×`;
    controls.speedButton.textContent = label;
    controls.speedButton.title = `Playback speed: ${selectedPlaybackRate} times`;
    controls.speedButton.setAttribute("aria-label", `Playback speed ${selectedPlaybackRate} times`);
    controls.speedValue.textContent = label;
    controls.speedSlider.setAttribute("aria-valuetext", `${selectedPlaybackRate} times`);
    setCurrentPlaybackSpeed?.(selectedPlaybackRate);
  });

  controls.minimizeButton.addEventListener("click", () => {
    voicePicker.close();
    setCompactMode(controls, true);
  });
  controls.expandButton.addEventListener("click", () => setCompactMode(controls, false));
  controls.miniActionButton.addEventListener("click", () => {
    if (controls.playerControls.hidden) {
      controls.articleButton.click();
    } else {
      controls.pauseButton.click();
    }
  });

  controls.selectionButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
  });

  controls.selectionButton.addEventListener("click", () => {
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;

    const readingSource = range ? createSelectionSource(range) : null;
    if (readingSource) {
      void startPlayback(controls, readingSource, "Selected text", range);
      controls.selectionButton.hidden = true;
    }
  });

  document.addEventListener("selectionchange", () => {
    positionSelectionButton(controls.selectionButton);
  });
  document.addEventListener("mouseup", () => {
    positionSelectionButton(controls.selectionButton);
  });
  document.addEventListener("keyup", () => {
    positionSelectionButton(controls.selectionButton);
  });
  window.addEventListener(
    "scroll",
    () => positionSelectionButton(controls.selectionButton),
    true,
  );
}

function getSelectedText(): string | null {
  const text = window.getSelection()?.toString().trim();

  return text || null;
}

function sourceAfterOffset(source: ReadingSource, offset: number): ReadingSource {
  const start = Math.max(0, Math.min(source.text.length, Math.floor(offset)));
  return {
    text: source.text.slice(start),
    spans: source.spans.flatMap((span) => {
      const first = Math.max(0, start - span.start);
      if (first >= span.offsets.length) return [];
      return [{ ...span, start: Math.max(0, span.start - start), offsets: span.offsets.slice(first) }];
    }),
    sentences: source.sentences.filter((sentence) => sentence.end > start).map((sentence) => ({
      start: Math.max(0, sentence.start - start),
      end: sentence.end - start,
    })),
  };
}

function createPageSentenceHighlighter(): PageSentenceHighlighter | null {
  pageSentenceHighlighter ??= createPageHighlighter(document);
  return pageSentenceHighlighter;
}

function createControls(): {
  host: HTMLDivElement;
  dock: HTMLDivElement;
  fullPlayer: HTMLDivElement;
  miniPlayer: HTMLDivElement;
  articleButton: HTMLButtonElement;
  debugButton: HTMLButtonElement;
  saveButton: HTMLButtonElement;
  readsButton: HTMLButtonElement;
  speedButton: HTMLButtonElement;
  speedPanel: HTMLDivElement;
  speedSlider: HTMLInputElement;
  speedValue: HTMLButtonElement;
  minimizeButton: HTMLButtonElement;
  expandButton: HTMLButtonElement;
  miniActionButton: HTMLButtonElement;
  selectionButton: HTMLButtonElement;
  playerControls: HTMLDivElement;
  rewindButton: HTMLButtonElement;
  pauseButton: HTMLButtonElement;
  forwardButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  status: HTMLDivElement;
  miniStatus: HTMLSpanElement;
  tapeTitle: HTMLElement;
} {
  const host = document.createElement("div");
  host.id = "readflow-controls";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        color: #edf0ed;
        font: 600 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .readflow-layer {
        inset: 0;
        pointer-events: none;
        position: fixed;
        z-index: 2147483647;
      }

      button {
        appearance: none;
        background: linear-gradient(180deg, #485055, #30383d);
        border: 1px solid #626c70;
        border-bottom-color: #1c2225;
        border-radius: 0 0 9px 9px;
        box-shadow: inset 0 1px rgb(255 255 255 / 12%), 0 2px 3px rgb(0 0 0 / 28%);
        color: inherit;
        cursor: pointer;
        font: inherit;
        min-height: 38px;
        padding: 0 12px;
        pointer-events: auto;
        transition: background 150ms ease, transform 150ms ease;
      }

      button:hover {
        background: linear-gradient(180deg, #596267, #3b454a);
      }

      button:active:not(:disabled) {
        transform: translateY(1px);
      }

      button:disabled {
        cursor: default;
        opacity: 0.5;
      }

      button:focus-visible {
        outline: 2px solid #d4e888;
        outline-offset: 3px;
      }

      #dock {
        background: linear-gradient(145deg, #4b5558, #283135 25%, #1c2428 72%);
        border: 1px solid #667175;
        border-bottom-color: #111719;
        border-radius: 18px;
        bottom: max(16px, env(safe-area-inset-bottom));
        box-shadow: 0 18px 44px rgb(0 0 0 / 32%), inset 0 1px rgb(255 255 255 / 16%);
        box-sizing: border-box;
        padding: 13px;
        pointer-events: auto;
        position: fixed;
        right: 16px;
        width: min(300px, calc(100vw - 32px));
      }

      #dock[data-compact="true"] {
        border-radius: 13px;
        padding: 8px;
        width: min(236px, calc(100vw - 32px));
      }

      #dock-header {
        align-items: center;
        display: flex;
        justify-content: space-between;
        margin: 0 2px 10px;
      }

      #header-actions {
        align-items: center;
        display: flex;
        gap: 7px;
      }

      #brand {
        color: #e9eeeb;
        font: 800 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: 0.19em;
      }

      #brand::before {
        background: #d6e986;
        border-radius: 50%;
        box-shadow: 0 0 9px rgb(214 233 134 / 45%);
        content: "";
        display: inline-block;
        height: 7px;
        margin-right: 9px;
        vertical-align: 1px;
        width: 7px;
      }

      #dock[data-transport="playing"] #brand::before {
        animation: power-glow 1.8s ease-in-out infinite;
      }

      #save-actions { display: flex; gap: 8px; margin-top: 12px; border-top: 1px solid #46534f; padding-top: 9px; }
      #save-actions button { flex: 1; font-size: 11px; padding: 5px 8px; min-height: 30px; border-radius: 6px; background: #273234; border-color: #53615d; box-shadow: inset 0 1px rgb(255 255 255 / 5%); color: #c6d2c8; }
      #save-actions button:hover { background: #354144; border-color: #819076; color: #e4edc0; }
      #save-button::before { content: "+"; color: #d6e986; margin-right: 6px; font: 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
      #debug-button {
        background: transparent;
        border: 0;
        box-shadow: none;
        color: #b9c4c3;
        font-size: 11px;
        min-height: 24px;
        padding: 0 2px;
      }

      #debug-button:hover {
        background: transparent;
        color: #eff5ef;
      }

      #minimize-button {
        background: transparent;
        border: 1px solid #667471;
        border-radius: 6px;
        box-shadow: none;
        color: #d6dfd6;
        font: 700 17px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        min-height: 26px;
        min-width: 26px;
        padding: 0;
      }

      #minimize-button:hover {
        background: #354144;
      }

      #speed-control {
        position: relative;
      }

      #speed-button {
        background: #20292c;
        border: 1px solid #667471;
        border-radius: 6px;
        color: #dce9ac;
        font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        min-height: 26px;
        min-width: 43px;
        padding: 0 6px;
      }

      #speed-button:hover {
        background: #354144;
      }

      #speed-panel {
        align-items: center;
        background: #20292c;
        border: 1px solid #667471;
        box-sizing: border-box;
        border-radius: 7px;
        box-shadow: 0 4px 12px rgb(0 0 0 / 38%), inset 0 1px rgb(255 255 255 / 9%);
        display: flex;
        gap: 7px;
        height: 28px;
        justify-content: space-between;
        padding: 0 8px;
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        width: 146px;
        z-index: 2;
      }

      #speed-panel[hidden] { display: none; }
      #speed-track {
        flex: 1;
        height: 22px;
        min-width: 0;
        position: relative;
      }

      #speed-track::before {
        background: #172022;
        border-radius: 4px;
        content: "";
        height: 4px;
        inset: 9px 6.5px auto;
        position: absolute;
      }

      #speed-slider {
        appearance: none;
        background: transparent;
        cursor: pointer;
        height: 22px;
        inset: 0;
        margin: 0;
        outline: none;
        position: absolute;
        width: 100%;
        z-index: 2;
      }

      #speed-slider::-webkit-slider-runnable-track {
        background: transparent;
        border-radius: 4px;
        height: 22px;
      }

      #speed-slider::-webkit-slider-thumb {
        appearance: none;
        background: #dce9ac;
        border: 2px solid #56634c;
        border-radius: 50%;
        box-shadow: 0 0 0 2px rgb(214 233 134 / 14%), 0 1px 3px rgb(0 0 0 / 60%);
        height: 13px;
        margin-top: 4px;
        width: 13px;
      }

      #speed-slider:focus-visible::-webkit-slider-thumb {
        box-shadow: 0 0 0 3px rgb(214 233 134 / 24%), 0 1px 3px rgb(0 0 0 / 60%);
      }

      .speed-tick {
        background: #78847b;
        height: 4px;
        opacity: 0.8;
        pointer-events: none;
        position: absolute;
        top: 7px;
        width: 1px;
        z-index: 1;
      }

      .speed-tick-major { background: #a5b08e; height: 8px; top: 6px; }

      #speed-value {
        background: transparent;
        border: 0;
        border-radius: 3px;
        box-shadow: none;
        color: #dce9ac;
        flex: 0 0 27px;
        font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        min-height: 22px;
        padding: 0;
        text-align: center;
      }

      #speed-value:hover { background: #354144; }

      #cassette-window {
        align-items: center;
        background: linear-gradient(180deg, #12191c, #252e30);
        border: 1px solid #0c1315;
        border-radius: 9px;
        box-shadow: inset 0 5px 13px rgb(0 0 0 / 65%), 0 1px rgb(255 255 255 / 9%);
        display: flex;
        height: 58px;
        justify-content: space-between;
        margin-bottom: 10px;
        overflow: hidden;
        padding: 0 15px;
        position: relative;
      }

      #cassette-window::before {
        background: #736a4a;
        content: "";
        height: 2px;
        left: 52px;
        opacity: 0.65;
        position: absolute;
        right: 52px;
        top: 28px;
      }

      #cassette-window::after {
        background: linear-gradient(110deg, transparent 18%, rgb(255 255 255 / 7%) 48%, transparent 64%);
        content: "";
        inset: 0;
        pointer-events: none;
        position: absolute;
      }

      .reel {
        background: #222a2a;
        border: 5px solid #89928d;
        border-radius: 50%;
        box-shadow: 0 0 0 2px #111719, inset 0 0 0 3px #111719;
        box-sizing: border-box;
        height: 44px;
        position: relative;
        width: 44px;
      }

      .reel::before {
        animation: reel-turn 4s linear infinite;
        animation-play-state: paused;
        background: repeating-conic-gradient(#bec8bc 0deg 14deg, #36423f 14deg 60deg);
        border-radius: 50%;
        content: "";
        inset: 6px;
        position: absolute;
      }

      #dock[data-transport="playing"] .reel::before {
        animation-play-state: running;
      }

      .reel::after {
        background: #1c2627;
        border: 2px solid #a4afa6;
        border-radius: 50%;
        content: "";
        height: 7px;
        left: 50%;
        position: absolute;
        top: 50%;
        transform: translate(-50%, -50%);
        width: 7px;
      }

      #tape-label {
        background: linear-gradient(180deg, #eee8d6, #d9d1ba);
        border: 1px solid #101719;
        border-bottom: 3px solid #a4ad78;
        border-radius: 8px 8px 0 0;
        color: #30382f;
        display: flex;
        flex-direction: column;
        font: 700 9px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace;
        gap: 5px;
        padding: 10px 12px;
      }

      #tape-side {
        color: #59624d;
        font-size: 8px;
        letter-spacing: 0.22em;
      }

      #tape-site {
        display: block;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #tape-footer { align-items: center; display: flex; gap: 6px; justify-content: space-between; min-width: 0; }

      #tape-title {
        color: #26312d;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
        overflow-wrap: anywhere;
        font-size: 13px;
        line-height: 1.35;
        letter-spacing: 0.01em;
      }

      #tape-site {
        color: #59624d;
        font-size: 9px;
        letter-spacing: 0.03em;
      }

      #selection-button {
        background: linear-gradient(180deg, #434d4f, #20292c);
        border: 1px solid #77827f;
        border-radius: 10px;
        box-shadow: inset 0 1px rgb(255 255 255 / 18%), 0 8px 24px rgb(0 0 0 / 30%);
        color: #f3f5ef;
        position: fixed;
        transform: translateX(-50%);
        white-space: nowrap;
      }

      #selection-button::before,
      #article-button::before {
        content: "▶";
        font-size: 11px;
        margin-right: 9px;
      }

      #selection-button::before {
        color: #dce9ac;
      }

      #status {
        background: linear-gradient(180deg, #c6d4af, #aebf99);
        border: 1px solid #111a14;
        border-radius: 7px;
        box-shadow: inset 0 2px 5px rgb(32 45 30 / 23%);
        color: #253627;
        font: 700 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
        min-height: 17px;
        overflow: hidden;
        padding: 10px 11px;
        position: relative;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #status::after {
        background: repeating-linear-gradient(180deg, transparent 0 3px, rgb(33 49 33 / 9%) 3px 4px);
        content: "";
        inset: 0;
        pointer-events: none;
        position: absolute;
      }

      #dock[data-transport="error"] #status {
        background: #dfb7ad;
        color: #4c2722;
      }

      #player-controls {
        align-items: center;
        display: grid;
        gap: 6px;
        grid-template-columns: 1fr 1.6fr 1fr 0.85fr;
        margin-top: 10px;
      }

      #player-controls button {
        min-width: 0;
        padding: 0 4px;
      }

      #stop-button::before {
        background: #d98879;
        border-radius: 2px;
        content: "";
        display: inline-block;
        height: 8px;
        margin-right: 5px;
        width: 8px;
      }

      #stop-button {
        background: #283234;
        border-color: #53605d;
        box-shadow: inset 0 1px rgb(255 255 255 / 5%);
        color: #bec7c1;
        font-size: 10px;
      }

      #pause-button {
        background: linear-gradient(180deg, #dce9ac, #abbf78);
        border-color: #d8e6a5;
        border-bottom-color: #6a7e46;
        color: #263324;
        min-height: 48px;
        font-size: 14px;
      }

      #pause-button:hover {
        background: linear-gradient(180deg, #eaf5bf, #bed38b);
      }

      #article-button {
        background: linear-gradient(180deg, #dce9ac, #afc37e);
        border-color: #e0edb1;
        border-bottom-color: #6a7e46;
        color: #243323;
        font-weight: 750;
        margin-top: 10px;
        width: 100%;
      }

      #article-button:hover {
        background: linear-gradient(180deg, #eaf5bf, #c3d690);
      }

      #mini-player {
        align-items: center;
        display: flex;
        gap: 7px;
      }

      #mini-mark {
        align-items: center;
        background: #172022;
        border: 2px solid #93a093;
        border-radius: 50%;
        box-shadow: inset 0 0 0 2px #11191b;
        color: #dce9ac;
        display: flex;
        flex: 0 0 26px;
        font: 800 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        height: 26px;
        justify-content: center;
      }

      #dock[data-transport="playing"] #mini-mark {
        box-shadow: inset 0 0 0 2px #11191b, 0 0 9px rgb(214 233 134 / 40%);
      }

      #mini-status {
        color: #d5e4c1;
        flex: 1;
        font: 700 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #mini-action-button,
      #expand-button {
        min-height: 34px;
        padding: 0;
      }

      #mini-action-button {
        background: linear-gradient(180deg, #dce9ac, #afc37e);
        border-color: #e0edb1;
        border-bottom-color: #6a7e46;
        color: #243323;
        flex: 0 0 34px;
        font-size: 16px;
      }

      #expand-button {
        flex: 0 0 26px;
        font-size: 18px;
      }

      @keyframes reel-turn {
        to { transform: rotate(360deg); }
      }

      @keyframes power-glow {
        50% { box-shadow: 0 0 15px rgb(214 233 134 / 80%); }
      }

      @media (max-width: 540px) {
        #dock {
          right: 50%;
          transform: translateX(50%);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        button { transition: none; }
        .reel::before,
        #dock[data-transport="playing"] #brand::before { animation: none; }
      }

      [hidden] {
        display: none !important;
      }
    </style>
    <div class="readflow-layer">
      <button id="selection-button" type="button" hidden>Listen to selection</button>
      <div id="dock" role="group" aria-label="Readflow player" data-transport="idle" data-compact="false">
        <div id="full-player">
        <div id="dock-header">
          <span id="brand">READFLOW</span>
          <div id="header-actions">
            <div id="speed-control">
              <button id="speed-button" type="button" title="Playback speed: 1 time" aria-label="Playback speed 1 time. Change speed" aria-controls="speed-panel" aria-expanded="false">1×</button>
              <div id="speed-panel" role="group" aria-label="Playback speed" hidden>
                <button id="speed-value" type="button" title="Close speed control" aria-label="Close speed control">1×</button>
                <div id="speed-track">
                  ${Array.from({ length: 23 }, (_, index) => {
                    const rate = (index + 8) / 10;
                    const position = (rate - 0.75) / 2.25;
                    return `<i class="speed-tick${Number.isInteger(rate * 2) ? " speed-tick-major" : ""}" aria-hidden="true" style="left:calc(${position * 100}% + ${6.5 - position * 13}px)"></i>`;
                  }).join("")}
                  <input id="speed-slider" type="range" min="0.75" max="3" step="0.05" value="1" aria-label="Playback speed" aria-valuetext="1 time" />
                </div>
              </div>
            </div>
            <button id="debug-button" type="button" title="Open Readflow diagnostics">Debug</button>
            <button id="minimize-button" type="button" title="Minimize player" aria-label="Minimize Readflow player">−</button>
          </div>
        </div>
          <div id="tape-label">
            <span id="tape-side">SIDE A · RF-01</span>
            <span id="tape-title"></span>
            <div id="tape-footer"><span id="tape-site"></span></div>
          </div>
        <div id="cassette-window" aria-hidden="true">
          <span class="reel"></span>
          <span class="reel"></span>
        </div>
        <div id="status" role="status" aria-live="polite">Ready to listen</div>
        <div id="player-controls" hidden>
          <button id="rewind-button" type="button" aria-label="Back 15 seconds" title="Back 15 seconds">−15</button>
          <button id="pause-button" type="button">Pause</button>
          <button id="forward-button" type="button" aria-label="Forward 15 seconds" title="Forward 15 seconds">+15</button>
          <button id="stop-button" type="button">Stop</button>
        </div>
        <button id="article-button" type="button">Listen to article</button>
        <div id="save-actions"><button id="save-button" type="button">Save for later</button><button id="reads-button" type="button">Reads</button></div>
        </div>
        <div id="mini-player" hidden>
          <span id="mini-mark" aria-hidden="true">RF</span>
          <span id="mini-status" role="status" aria-live="polite">Ready to listen</span>
          <button id="mini-action-button" type="button" aria-label="Listen to article" title="Listen to article">▶</button>
          <button id="expand-button" type="button" aria-label="Expand Readflow player" title="Expand player">⌃</button>
        </div>
      </div>
    </div>
  `;

  shadow.querySelector<HTMLElement>("#tape-site")!.textContent = window.location.hostname.replace(/^www\./, "") || "LOCAL PAGE";
  const tapeTitle = shadow.querySelector<HTMLElement>("#tape-title")!;
  tapeTitle.textContent = shortTapeTitle(document.title);
  tapeTitle.title = tapeTitle.textContent;

  return {
    host,
    dock: shadow.querySelector<HTMLDivElement>("#dock")!,
    fullPlayer: shadow.querySelector<HTMLDivElement>("#full-player")!,
    miniPlayer: shadow.querySelector<HTMLDivElement>("#mini-player")!,
    articleButton: shadow.querySelector<HTMLButtonElement>("#article-button")!,
    debugButton: shadow.querySelector<HTMLButtonElement>("#debug-button")!,
    saveButton: shadow.querySelector<HTMLButtonElement>("#save-button")!,
    readsButton: shadow.querySelector<HTMLButtonElement>("#reads-button")!,
    speedButton: shadow.querySelector<HTMLButtonElement>("#speed-button")!,
    speedPanel: shadow.querySelector<HTMLDivElement>("#speed-panel")!,
    speedSlider: shadow.querySelector<HTMLInputElement>("#speed-slider")!,
    speedValue: shadow.querySelector<HTMLButtonElement>("#speed-value")!,
    minimizeButton: shadow.querySelector<HTMLButtonElement>("#minimize-button")!,
    expandButton: shadow.querySelector<HTMLButtonElement>("#expand-button")!,
    miniActionButton: shadow.querySelector<HTMLButtonElement>("#mini-action-button")!,
    selectionButton: shadow.querySelector<HTMLButtonElement>("#selection-button")!,
    playerControls: shadow.querySelector<HTMLDivElement>("#player-controls")!,
    rewindButton: shadow.querySelector<HTMLButtonElement>("#rewind-button")!,
    pauseButton: shadow.querySelector<HTMLButtonElement>("#pause-button")!,
    forwardButton: shadow.querySelector<HTMLButtonElement>("#forward-button")!,
    stopButton: shadow.querySelector<HTMLButtonElement>("#stop-button")!,
    status: shadow.querySelector<HTMLDivElement>("#status")!,
    miniStatus: shadow.querySelector<HTMLSpanElement>("#mini-status")!,
    tapeTitle,
  };
}

function positionSelectionButton(button: HTMLButtonElement): void {
  if (!getSelectedText()) {
    button.hidden = true;
    return;
  }

  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const rect = range?.getBoundingClientRect();

  if (!rect || (!rect.width && !rect.height)) {
    button.hidden = true;
    return;
  }

  const horizontalCenter = rect.left + rect.width / 2;
  const boundedCenter = Math.max(92, Math.min(window.innerWidth - 92, horizontalCenter));
  const verticalPosition = rect.top >= 48 ? rect.top - 48 : rect.bottom + 10;
  button.style.left = `${boundedCenter}px`;
  button.style.top = `${Math.max(8, Math.min(window.innerHeight - 48, verticalPosition))}px`;
  button.hidden = false;
}

function setTransportState(controls: ReturnType<typeof createControls>, state: TransportState): void {
  if (controls.dock.dataset.transport === state) {
    return;
  }
  controls.dock.dataset.transport = state;
  const canPause = state === "playing" || state === "buffering";
  const canResume = state === "paused" || state === "finished";
  controls.articleButton.hidden = canPause || canResume || state === "connecting";
  const label = canPause ? "Pause audio" : canResume ? "Play audio" : "Listen to article";
  controls.miniActionButton.textContent = canPause ? "Ⅱ" : "▶";
  controls.miniActionButton.disabled = state === "connecting";
  controls.miniActionButton.setAttribute("aria-label", label);
  controls.miniActionButton.title = label;
}

function setPlayerStatus(controls: ReturnType<typeof createControls>, message: string): void {
  if (controls.status.textContent === message) {
    return;
  }
  controls.status.textContent = message;
  controls.miniStatus.textContent = message;
  controls.miniStatus.title = message;
}

function setCompactMode(controls: ReturnType<typeof createControls>, compact: boolean): void {
  controls.dock.dataset.compact = compact ? "true" : "false";
  controls.fullPlayer.hidden = compact;
  controls.miniPlayer.hidden = !compact;
  (compact ? controls.expandButton : controls.minimizeButton).focus();
}

async function startPlayback(
  controls: ReturnType<typeof createControls>,
  readingSource: ReadingSource,
  source: string,
  selectionRange?: Range,
  options: { sourceOffset?: number; elapsedSeconds?: number; voice?: FishVoice; resumePaused?: boolean; startBufferSeconds?: number } = {},
  savedRead?: ReadingItem,
): Promise<void> {
  const picker = voicePickers.get(controls.host);
  await picker?.ready;
  const voice: FishVoice = options.voice ?? picker?.selectedVoice ?? DEFAULT_VOICE;
  stopCurrentPlayback?.();
  controls.playerControls.hidden = true;
  const sessionId = crypto.randomUUID();
  const fullSource = readingSource;
  let reading: ReadingItem;
  try {
    const result = await sendExtensionMessage<{ item?: ReadingItem; error?: string }>({
      type: "reading_save", sessionId,
      item: { url: location.href, title: document.title, source: source === "Article" ? "article" : "selection", text: fullSource.text },
    });
    if (!result.item) throw new Error(result.error || "Could not save reading progress.");
    reading = result.item;
  } catch (error) {
    setPlayerStatus(controls, error instanceof Error ? error.message : "Could not save reading progress.");
    controls.status.hidden = false;
    return;
  }
  const startOffset = options.sourceOffset ?? (savedRead?.status !== "completed" ? resumeOffset(fullSource.text, reading.offset) : 0);
  const playbackSource = startOffset ? sourceAfterOffset(fullSource, startOffset) : fullSource;
  if (!playbackSource.text) return;
  let checkpoint = startOffset;
  const spoken = prepareSpokenSource(playbackSource.text);
  const spokenText = spoken.text;
  const sections = splitTextSections(spokenText);
  controls.tapeTitle.textContent = source === "Selected text" ? "Selected passage" : shortTapeTitle(document.title);
  controls.tapeTitle.title = controls.tapeTitle.textContent;
  setTransportState(controls, "connecting");
  setPlayerStatus(controls, `Connecting for ${source.toLowerCase()} audio…`);
  controls.status.hidden = false;

  let port: chrome.runtime.Port;
  try {
    port = extensionRuntime().connect({ name: "readflow-tts" });
  } catch {
    setTransportState(controls, "error");
    setPlayerStatus(controls, RECONNECT_MESSAGE);
    return;
  }

  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: SAMPLE_RATE });
  } catch {
    port.disconnect();
    setTransportState(controls, "error");
    setPlayerStatus(controls, "This browser could not create a 44.1 kHz audio stream.");
    controls.status.hidden = false;
    return;
  }
  const highlighter = createPageSentenceHighlighter();
  const autoScroller = createReadingAutoScroller(window, controls.host);
  if (highlighter && selectionRange) {
    highlighter.set([], selectionRange);
    window.getSelection()?.removeAllRanges();
  }
  const alignmentsByChunk = new Map<string, ChunkAlignment>();
  let locatedWords: SentenceTiming[] = [];
  let readingOffsets: Array<{ start: number; offset: number }> = [];
  const sectionOffsets = new Map<number, { start: number; offset: number }>();
  let currentSentenceKey = "";
  let alignmentNeedsMapping = false;
  let didReportHighlightMapping = false;
  let didReportHighlightMismatch = false;
  const sources = new Set<AudioBufferSourceNode>();
  const scheduledRanges: Array<{ start: number; end: number; firstFrame: number; rate: number }> = [];
  const audioTimeline: Array<{ buffer: AudioBuffer; firstFrame: number }> = [];
  const pendingSamples: Float32Array<ArrayBuffer>[] = [];
  let pendingFrameCount = 0;
  const pendingBytesBySection = new Map<number, Uint8Array>();
  let receivedFrames = 0;
  let seekStartFrame = 0;
  let pendingSeekFrame: number | null = null;
  let playbackRate = selectedPlaybackRate;
  let stretch = new StreamingTimeStretch(playbackRate, SAMPLE_RATE);
  let processedOutputFrames = 0;
  let stretchFinished = false;
  let processingTimer = 0;
  let processingEntry = 0;
  let processingOffset = 0;
  const bufferFrames = (): number => bufferFramesForSpeed(SAMPLE_RATE / 10, playbackRate);
  const startupBufferFrames = (): number => Math.ceil((options.startBufferSeconds ?? START_BUFFER_SECONDS) * SAMPLE_RATE * playbackRate);
  let nextStart = 0;
  let streamFinished = false;
  let playbackComplete = false;
  let stopped = false;
  let animationFrame = 0;
  let playbackStarted = false;
  let startupReady = false;
  let lastBufferStatusAt = 0;
  const sessionStarted = performance.now();
  const elapsedBeforeSession = options.elapsedSeconds ?? 0;
  let changeVoiceForSession: (voice: FishVoice) => void;
  let lastProgressAt = 0;

  const recordClientEvent = (kind: string, playbackMs?: number, value?: unknown): void => {
    try {
      port.postMessage({
        type: "client_event",
      kind,
      clientElapsedMs: performance.now() - sessionStarted,
      playbackMs,
      value,
      });
    } catch {
      // A lost connection must not prevent audio cleanup.
    }
  };
  recordClientEvent("listen_started");
  if (!highlighter) {
    recordClientEvent("highlight_api_unavailable");
  }

  const persistProgress = (completed = false): void => {
    if (alignmentNeedsMapping) { rebuildWordRanges(); alignmentNeedsMapping = false; }
    const seconds = getAudibleFrame() / SAMPLE_RATE;
    let current: { start: number; offset: number } | undefined;
    for (const word of [...sectionOffsets.values(), ...readingOffsets].sort((a, b) => a.start - b.start)) {
      if (word.start > seconds) break;
      current = word;
    }
    if (current && seconds > 0) checkpoint = startOffset + current.offset;
    void sendExtensionMessage<{ error?: string }>({ type: "reading_progress", id: reading.id, sessionId, offset: checkpoint, completed })
      .then((result) => { if (result.error) setPlayerStatus(controls, result.error); })
      .catch(() => setPlayerStatus(controls, "Reading progress could not be saved. Refresh this tab to reconnect."));
  };
  const pageHide = (): void => { cleanup(); };
  window.addEventListener("pagehide", pageHide);

  const cleanup = (recordStop = true): void => {
    if (stopped) {
      return;
    }

    if (!playbackComplete) persistProgress();
    window.removeEventListener("pagehide", pageHide);
    stopped = true;
    setCurrentPlaybackSpeed = null;
    if (changePlaybackVoice === changeVoiceForSession) changePlaybackVoice = null;
    cancelAnimationFrame(animationFrame);
    window.clearTimeout(processingTimer);
    highlighter?.clear();
    autoScroller.dispose();
    if (recordStop && !playbackComplete) {
      recordClientEvent("stopped", getAudibleFrame() / SAMPLE_RATE * 1000);
    }
    try { port.disconnect(); } catch { /* Already disconnected. */ }
    for (const audioSource of sources) {
      audioSource.stop();
    }
    void context.close().catch(() => undefined);
  };

  stopCurrentPlayback = cleanup;
  controls.playerControls.hidden = false;
  controls.rewindButton.disabled = true;
  controls.forwardButton.disabled = true;
  controls.pauseButton.textContent = options.resumePaused ? "Play" : "Pause";
  controls.pauseButton.onclick = () => {
    if (playbackComplete) {
      controls.pauseButton.disabled = true;
      void sendExtensionMessage<{ item?: ReadingItem; error?: string }>({
        type: "reading_save", sessionId,
        item: { url: location.href, title: document.title, source: reading.source, text: fullSource.text },
      }).then((result) => {
        if (stopped) return;
        if (!result.item) throw new Error(result.error || "Could not save reading progress.");
        reading = result.item;
        checkpoint = startOffset;
        playbackComplete = false;
        changePlaybackVoice = changeVoiceForSession;
        controls.pauseButton.textContent = "Pause";
        seekTo(0);
      }).catch(() => setPlayerStatus(controls, "Could not save reading progress. Try again."))
        .finally(() => { controls.pauseButton.disabled = false; });
      return;
    }

    if (context.state === "running") {
      void context.suspend().then(() => {
        if (stopped) {
          return;
        }
        controls.pauseButton.textContent = "Play";
        setTransportState(controls, "paused");
        recordClientEvent("paused", getAudibleFrame() / SAMPLE_RATE * 1000);
        persistProgress();
      }).catch(() => undefined);
    } else {
      void context.resume().then(() => {
        if (stopped) {
          return;
        }
        controls.pauseButton.textContent = "Pause";
        setTransportState(controls, "buffering");
        recordClientEvent("resumed", getAudibleFrame() / SAMPLE_RATE * 1000);
      }).catch(() => undefined);
    }
  };
  controls.rewindButton.onclick = () => seekBy(-15);
  controls.forwardButton.onclick = () => seekBy(15);
  controls.stopButton.onclick = () => {
    cleanup();
    setPlayerStatus(controls, "Stopped");
    setTransportState(controls, "stopped");
    controls.playerControls.hidden = true;
    if (stopCurrentPlayback === cleanup) {
      stopCurrentPlayback = null;
    }
  };

  const reportError = (message: string): void => {
    recordClientEvent("playback_error", getAudibleFrame() / SAMPLE_RATE * 1000, message);
    cleanup(false);
    setPlayerStatus(controls, message);
    setTransportState(controls, "error");
    controls.playerControls.hidden = true;
    if (stopCurrentPlayback === cleanup) {
      stopCurrentPlayback = null;
    }
  };

  changeVoiceForSession = (nextVoice) => {
    if (stopped) return;
    const frame = pendingSeekFrame ?? getAudibleFrame();
    const currentSeconds = frame / SAMPLE_RATE;
    let sourceOffset = startOffset;
    for (const word of locatedWords) {
      if (word.start > currentSeconds) break;
      if (word.sourceOffset !== null) sourceOffset = startOffset + word.sourceOffset;
    }
    const resumePaused = context.state === "suspended";
    cleanup(false);
    if (stopCurrentPlayback) stopCurrentPlayback = null;
    setPlayerStatus(controls, `Switching to ${nextVoice.name}…`);
    void startPlayback(controls, readingSource, source, selectionRange, {
      sourceOffset,
      elapsedSeconds: elapsedBeforeSession + currentSeconds,
      voice: nextVoice,
      resumePaused,
      startBufferSeconds: 0.5,
    });
  };
  changePlaybackVoice = changeVoiceForSession;

  port.onDisconnect.addListener(() => {
    const error = chrome.runtime?.lastError;
    if (!stopped && (!streamFinished || error)) reportError(RECONNECT_MESSAGE);
  });

  const finishIfReady = (): void => {
    if (streamFinished && stretchFinished && sources.size === 0 && pendingFrameCount === 0 && !stopped) {
      persistProgress(true);
      playbackComplete = true;
      if (changePlaybackVoice === changeVoiceForSession) changePlaybackVoice = null;
      highlighter?.clear();
      currentSentenceKey = "";
      recordClientEvent("playback_finished", getAudibleFrame() / SAMPLE_RATE * 1000);
      setPlayerStatus(controls, "Finished");
      setTransportState(controls, "finished");
      controls.pauseButton.textContent = "Play";
      cancelAnimationFrame(animationFrame);
    }
  };

  const scheduleOutput = (samples: Float32Array<ArrayBuffer>): void => {
    if (!samples.length) {
      return;
    }

    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const audioSource = context.createBufferSource();
    audioSource.buffer = buffer;
    audioSource.playbackRate.value = 1;
    audioSource.connect(context.destination);

    const schedulingLead = nextStart === 0 ? 0.05 : 0.01;
    const start = Math.max(context.currentTime + schedulingLead, nextStart);
    const end = start + playbackDuration(samples.length, SAMPLE_RATE, 1);
    scheduledRanges.push({
      start,
      end,
      firstFrame: seekStartFrame + processedOutputFrames * playbackRate,
      rate: playbackRate,
    });
    processedOutputFrames += samples.length;
    nextStart = end;
    sources.add(audioSource);
    audioSource.onended = () => {
      sources.delete(audioSource);
      finishIfReady();
    };
    audioSource.start(start);
  };

  const finishStretch = (): void => {
    if (!stretchFinished && pendingSeekFrame === null) {
      scheduleOutput(stretch.finish());
      stretchFinished = true;
    }
  };

  const processAvailableAudio = (): void => {
    processingTimer = 0;
    if (stopped || pendingSeekFrame !== null) return;
    const deadline = performance.now() + 8;
    while (processingEntry < audioTimeline.length) {
      const samples = audioTimeline[processingEntry].buffer.getChannelData(0);
      const end = Math.min(samples.length, processingOffset + 8192);
      scheduleOutput(stretch.push(samples.subarray(processingOffset, end)));
      processingOffset = end;
      if (processingOffset === samples.length) {
        processingEntry += 1;
        processingOffset = 0;
      }
      if (performance.now() >= deadline) {
        processingTimer = window.setTimeout(processAvailableAudio, 0);
        return;
      }
    }
    if (streamFinished && pendingFrameCount === 0) {
      finishStretch();
      finishIfReady();
    }
  };

  const scheduleFromFrame = (targetFrame: number): void => {
    processingEntry = 0;
    processingOffset = 0;
    while (processingEntry < audioTimeline.length) {
      const entry = audioTimeline[processingEntry];
      if (entry.firstFrame + entry.buffer.length > targetFrame) {
        processingOffset = Math.max(0, Math.floor(targetFrame - entry.firstFrame));
        break;
      }
      processingEntry += 1;
    }
    processAvailableAudio();
  };

  const startWhenBuffered = (): void => {
    if (!startupReady && (receivedFrames >= startupBufferFrames() || streamFinished)) startupReady = true;
  };

  const scheduleSamples = (samples: Float32Array<ArrayBuffer>): void => {
    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const timelineEntry = { buffer, firstFrame: receivedFrames };
    audioTimeline.push(timelineEntry);
    receivedFrames += samples.length;
    if (pendingSeekFrame !== null) {
      const seek = resolveSeekTarget(pendingSeekFrame, receivedFrames, streamFinished, startupBufferFrames());
      if (seek.waiting) {
        return;
      }
      pendingSeekFrame = null;
      seekStartFrame = seek.targetFrame;
      scheduleFromFrame(seek.targetFrame);
      return;
    }
    startWhenBuffered();
    if (startupReady && !processingTimer) processAvailableAudio();
  };

  const flushSamples = (force: boolean): void => {
    if (!force && pendingFrameCount < bufferFrames()) {
      return;
    }

    for (const samples of pendingSamples) {
      scheduleSamples(samples);
    }
    pendingSamples.length = 0;
    pendingFrameCount = 0;
  };

  const queueAudio = (audioBase64: string, sectionIndex: number): void => {
    const decoded = atob(audioBase64);
    const incoming = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const pendingByte = pendingBytesBySection.get(sectionIndex) || new Uint8Array();
    const combined = new Uint8Array(pendingByte.length + incoming.length);
    combined.set(pendingByte);
    combined.set(incoming, pendingByte.length);
    const completeLength = combined.length - (combined.length % 2);
    if (completeLength === combined.length) pendingBytesBySection.delete(sectionIndex);
    else pendingBytesBySection.set(sectionIndex, combined.slice(completeLength));

    if (completeLength === 0) {
      return;
    }

    const view = new DataView(combined.buffer, combined.byteOffset, completeLength);
    const samples = new Float32Array(completeLength / 2);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 32768;
    }
    pendingSamples.push(samples);
    pendingFrameCount += samples.length;
    flushSamples(false);
  };

  const getAudibleFrame = (): number => {
    const outputContextTime = context.getOutputTimestamp().contextTime ?? context.currentTime;
    let frame = scheduledRanges[0]?.firstFrame ?? seekStartFrame;
    for (const range of scheduledRanges) {
      if (outputContextTime < range.start) {
        break;
      }
      if (outputContextTime < range.end) {
        frame = range.firstFrame + playedFrames(outputContextTime - range.start, SAMPLE_RATE, range.rate);
        break;
      }
      frame = range.firstFrame + playedFrames(range.end - range.start, SAMPLE_RATE, range.rate);
    }
    return Math.min(receivedFrames, Math.max(0, frame));
  };

  const seekTo = (requestedFrame: number, recordSeek = true): void => {
    const { targetFrame, waiting } = resolveSeekTarget(
      requestedFrame, receivedFrames, streamFinished, startupBufferFrames(),
    );
    if (recordSeek) {
      recordClientEvent("seek", targetFrame / SAMPLE_RATE * 1000);
    }
    for (const audioSource of sources) {
      audioSource.onended = null;
      audioSource.stop();
    }
    sources.clear();
    window.clearTimeout(processingTimer);
    processingTimer = 0;
    scheduledRanges.length = 0;
    seekStartFrame = targetFrame;
    stretch = new StreamingTimeStretch(playbackRate, SAMPLE_RATE);
    processedOutputFrames = 0;
    stretchFinished = false;
    startupReady = true;
    pendingSeekFrame = waiting ? targetFrame : null;
    nextStart = 0;
    playbackComplete = false;
    highlighter?.set([], selectionRange);
    currentSentenceKey = "";
    controls.pauseButton.textContent = context.state === "running" ? "Pause" : "Play";

    if (waiting) {
      setPlayerStatus(controls, `Buffering to ${formatTime(targetFrame / SAMPLE_RATE)}…`);
      setTransportState(controls, "buffering");
    } else {
      scheduleFromFrame(targetFrame);
      setTransportState(controls, context.state === "suspended" ? "paused" : "buffering");
    }

    controls.rewindButton.disabled = targetFrame === 0;
    controls.forwardButton.disabled = streamFinished && targetFrame === receivedFrames;
    cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(updatePlaybackTime);
    if (streamFinished && sources.size === 0) {
      finishIfReady();
    }
  };

  const seekBy = (seconds: number): void => {
    seekTo((pendingSeekFrame ?? getAudibleFrame()) + seconds * SAMPLE_RATE);
  };

  setCurrentPlaybackSpeed = (rate) => {
    const frame = pendingSeekFrame ?? getAudibleFrame();
    playbackRate = rate;
    try { port.postMessage({ type: "set_speed", rate }); } catch {
      reportError(RECONNECT_MESSAGE);
      return;
    }
    recordClientEvent("speed_changed", frame / SAMPLE_RATE * 1000, { rate });
    if (!playbackComplete) {
      seekTo(frame, false);
    }
  };

  const rebuildWordRanges = (): void => {
    const segments = Array.from(alignmentsByChunk.values()).flatMap((snapshot) =>
      snapshot.segments.map((segment) => ({
        text: segment.text,
        start: snapshot.offset + segment.start,
        end: snapshot.offset + segment.end,
      })),
    ).sort((left, right) => left.start - right.start);
    locatedWords = mapSentenceTimings(playbackSource, spoken, segments);
    readingOffsets = mapReadingOffsets(spoken, segments);
    currentSentenceKey = "";
    const mappedWords = locatedWords.filter((word) => word.ranges.length);
    const mismatch = locatedWords.find((word) => !word.ranges.length);
    if (mismatch && !didReportHighlightMismatch) {
      recordClientEvent("highlight_text_mismatch", mismatch.start * 1000);
      didReportHighlightMismatch = true;
    }
    if (!didReportHighlightMapping) {
      recordClientEvent("highlight_mapping", undefined, {
        mapped_words: mappedWords.length,
        alignment_words: segments.length,
      });
      didReportHighlightMapping = true;
    }
  };

  const updateSentenceHighlight = (playbackSeconds: number, playing: boolean): void => {
    let word: (typeof locatedWords)[number] | undefined;
    for (const candidate of locatedWords) {
      if (candidate.start > playbackSeconds) {
        break;
      }
      word = candidate;
    }

    if (playing && word?.ranges.length && word.sourceOffset !== null) {
      const offset = word.sourceOffset;
      autoScroller.follow(() => sourceRanges(playbackSource, offset, offset + 1));
    }
    if (!word || !highlighter) {
      highlighter?.set([], selectionRange);
      currentSentenceKey = "";
      return;
    }
    if (word.sentenceKey === currentSentenceKey) {
      return;
    }

    highlighter?.set(word.ranges, selectionRange);
    currentSentenceKey = word.sentenceKey;
  };

  const updatePlaybackTime = (): void => {
    if (stopped || playbackComplete) {
      return;
    }

    const now = performance.now();
    if (now - lastProgressAt >= 5000) {
      lastProgressAt = now;
      persistProgress();
    }
    if (now - lastBufferStatusAt >= 250) {
      lastBufferStatusAt = now;
      try {
        port.postMessage({
          type: "buffer_status",
        audibleFrame: pendingSeekFrame ?? getAudibleFrame(),
        rate: playbackRate,
        paused: context.state === "suspended",
        pendingSeek: pendingSeekFrame !== null,
        });
      } catch {
        reportError(RECONNECT_MESSAGE);
        return;
      }
    }
    if (scheduledRanges.length === 0) {
      animationFrame = requestAnimationFrame(updatePlaybackTime);
      return;
    }

    if (alignmentNeedsMapping) {
      rebuildWordRanges();
      alignmentNeedsMapping = false;
    }

    const frame = getAudibleFrame();
    const outputContextTime = context.getOutputTimestamp().contextTime ?? context.currentTime;
    const hasAudibleAudio = isAudioAudible(scheduledRanges, outputContextTime);
    setTransportState(controls, context.state === "suspended" ? "paused" : hasAudibleAudio ? "playing" : "buffering");
    if (!playbackStarted && hasAudibleAudio && context.state === "running") {
      playbackStarted = true;
      recordClientEvent("playback_started", frame / SAMPLE_RATE * 1000);
    }
    updateSentenceHighlight(frame / SAMPLE_RATE, hasAudibleAudio && context.state === "running");
    controls.rewindButton.disabled = frame <= 0;
    controls.forwardButton.disabled = streamFinished && frame >= receivedFrames;
    const seconds = Math.max(0, frame / SAMPLE_RATE);
    const state = context.state === "suspended" ? "Paused" : hasAudibleAudio ? "Playing" : "Buffering";
    setPlayerStatus(controls, `${state} · ${formatTime(elapsedBeforeSession + seconds)}`);
    animationFrame = requestAnimationFrame(updatePlaybackTime);
  };

  port.onMessage.addListener((message: {
    event?: string;
    audio_base64?: string;
    message?: string;
    chunk_seq?: number;
    section_index?: number;
    section_start_frame?: number;
    chunk_audio_offset_sec?: number;
    alignment?: { segments?: WordTiming[] } | null;
  }) => {
    if (stopped) {
      return;
    }

    if (message.event === "audio" && message.audio_base64) {
      try {
        const sectionIndex = Number(message.section_index) || 0;
        const section = sections[sectionIndex];
        if (section && typeof message.section_start_frame === "number" && Number.isFinite(message.section_start_frame)) {
          sectionOffsets.set(sectionIndex, { start: message.section_start_frame / SAMPLE_RATE, offset: spoken.sourceOffsets[section.start] ?? 0 });
        }
        queueAudio(message.audio_base64, sectionIndex);
        if (typeof message.chunk_seq === "number" && message.alignment?.segments?.length) {
          alignmentsByChunk.set(`${sectionIndex}:${message.chunk_seq}`, {
            offset: typeof message.chunk_audio_offset_sec === "number" ? message.chunk_audio_offset_sec : 0,
            segments: message.alignment.segments,
          });
          alignmentNeedsMapping = true;
        }
      } catch {
        reportError("Readflow received invalid audio data.");
      }
    } else if (message.event === "section_finish") {
      const sectionIndex = Number(message.section_index) || 0;
      if (pendingBytesBySection.get(sectionIndex)?.length) {
        reportError("Fish Audio ended with an incomplete PCM sample.");
      }
    } else if (message.event === "finish") {
      if (pendingBytesBySection.size) {
        reportError("Fish Audio ended with an incomplete PCM sample.");
        return;
      }
      streamFinished = true;
      flushSamples(true);
      if (receivedFrames === 0) {
        reportError("Fish Audio returned no audio.");
        return;
      }
      if (pendingSeekFrame !== null) {
        seekTo(pendingSeekFrame);
      }
      startWhenBuffered();
      if (!processingTimer) processAvailableAudio();
    } else if (message.event === "error") {
      reportError(message.message || "Audio could not be generated.");
    }
  });

  try {
    if (!options.resumePaused) await context.resume();
    port.postMessage({
      type: "start",
      sessionId,
      referenceId: voice.id,
      source: source === "Article" ? "article" : "selection",
      text: spokenText,
      sections,
      rate: playbackRate,
      textCharCount: spokenText.length,
      wordCount: spokenText.trim().split(/\s+/).length,
      startedAt: new Date().toISOString(),
    });
    setPlayerStatus(controls, options.resumePaused ? `Paused · ${formatTime(elapsedBeforeSession)}` : "Buffering audio…");
    setTransportState(controls, options.resumePaused ? "paused" : "buffering");
    animationFrame = requestAnimationFrame(updatePlaybackTime);
  } catch {
    reportError("Audio playback could not start. Try again.");
  }
}

function formatTime(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}
