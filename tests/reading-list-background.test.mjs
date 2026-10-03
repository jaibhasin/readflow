import assert from "node:assert/strict";
import test from "node:test";

const local = {};
const session = {};
const removedListeners = [];
const opened = [];
const updated = [];
function storage(values) {
  return {
    async get(key) { return { [key]: structuredClone(values[key]) }; },
    async set(input) { Object.assign(values, structuredClone(input)); },
    async remove(key) { delete values[key]; },
  };
}
globalThis.chrome = {
  storage: { local: storage(local), session: storage(session) },
  runtime: { getURL: path => `chrome-extension://test/${path}` },
  tabs: {
    onRemoved: { addListener: listener => removedListeners.push(listener) },
    async create(input) { opened.push(input); return { id: opened.length }; },
    async update(id, input) { updated.push({ id, ...input, requested: session[`readingTab:${id}`] }); },
  },
};
const { handleReadingMessage } = await import("../extension/reading-list-background.ts");
const sender = { url: "https://example.com/article", tab: { id: 20 } };
const item = { url: sender.url, title: "Saved article", source: "article", text: "First sentence. Second sentence." };

async function request(input, from = sender) { return await handleReadingMessage(input, from); }

test("background serializes simultaneous saves and persists progress across reopening", async () => {
  const [saved] = await Promise.all([
    request({ type: "reading_save", item, sessionId: "playing" }),
    request({ type: "reading_save", item: { ...item, text: "Different article text." } }),
  ]);
  assert.equal((await request({ type: "reading_list" })).items.length, 2);
  await request({ type: "reading_progress", id: saved.item.id, sessionId: "playing", offset: 18 });
  const found = await request({ type: "reading_for_page" });
  assert.equal(found.item.offset, 18);
  assert.equal(found.item.status, "in-progress");
  await request({ type: "reading_open", id: saved.item.id });
  assert.equal(opened.at(-1).url, "about:blank");
  assert.equal(updated.at(-1).url, item.url);
  assert.equal(updated.at(-1).requested, saved.item.id, "resume target is saved before navigation");
  const reopened = await request({ type: "reading_for_page" }, { ...sender, tab: { id: updated.at(-1).id } });
  assert.equal(reopened.item.id, saved.item.id);
  assert.equal(session[`readingTab:${updated.at(-1).id}`], undefined);
});

test("completed reads are excluded from automatic resume but explicitly reopenable", async () => {
  const saved = await request({ type: "reading_save", item: { ...item, text: "A finished passage.", source: "selection" }, sessionId: "finished" });
  await request({ type: "reading_progress", id: saved.item.id, sessionId: "finished", offset: 0, completed: true });
  await request({ type: "reading_open", id: saved.item.id });
  const tabId = updated.at(-1).id;
  const found = await request({ type: "reading_for_page" }, { ...sender, tab: { id: tabId } });
  assert.equal(found.item.source, "selection");
  assert.equal(found.item.status, "completed");
});

test("invalid saves and stale or non-finite progress leave storage intact", async () => {
  const before = structuredClone(local);
  const invalid = await request({ type: "reading_save", item: { ...item, url: "https://different.example/" } });
  assert.ok(invalid.error);
  const nonfinite = await request({ type: "reading_progress", id: "unknown", sessionId: "x", offset: NaN });
  assert.ok(nonfinite.error);
  const wrongTab = await request({ type: "reading_progress", id: local.readingList[0].id, sessionId: "playing", offset: 0 }, { url: "https://different.example", tab: { id: 21 } });
  assert.equal(wrongTab.ok, false);
  assert.deepEqual(local, before);
  const valid = await request({ type: "reading_list" });
  assert.ok(valid.items.length, "rejections do not break the serial mutation queue");
});

test("removal deletes saved text and later playback cannot recreate it", async () => {
  const id = local.readingList[0].id;
  await request({ type: "reading_remove", id });
  await request({ type: "reading_progress", id, sessionId: "playing", offset: 20 });
  assert.equal(local.readingList.find(entry => entry.id === id), undefined);
  assert.ok((await request({ type: "reading_open", id })).error);
});
