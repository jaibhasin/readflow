import assert from "node:assert/strict";
import test from "node:test";
import { readingProgress, readingUrl, resumeOffset, saveReading, updateReading } from "../extension/reading-list-store.ts";
import { mapReadingOffsets } from "../extension/reading-progress.ts";
import { prepareSpokenSource } from "../extension/spoken-text.ts";

const article = { url: "https://example.com/article#intro", title: "An article", source: "article", text: "First sentence. Second sentence. Third sentence." };

test("save for later deduplicates without losing unfinished progress", () => {
  const list = [];
  const saved = saveReading(list, article);
  assert.equal(saved.status, "queued");
  assert.equal(readingProgress(saved).percent, 0);
  const started = saveReading(list, article, "session-1");
  updateReading(list, started.id, "session-1", 16, false);
  const again = saveReading(list, { ...article, url: "https://example.com/article#second" });
  assert.equal(list.length, 1);
  assert.equal(again.status, "in-progress");
  assert.equal(again.offset, 16);
  assert.deepEqual(readingProgress(again), { percent: 33, remainingWords: 4, minutes: 1 });
});

test("selections on the same article retain independent progress", () => {
  const list = [];
  const full = saveReading(list, article, "full");
  const selection = saveReading(list, { ...article, source: "selection", text: "Second sentence." }, "selection");
  assert.notEqual(full.id, selection.id);
  updateReading(list, selection.id, "selection", 0, true);
  assert.equal(full.status, "in-progress");
  assert.equal(selection.status, "completed");
});

test("resume keeps saved progress; stale tabs cannot overwrite the current session", () => {
  const list = [];
  const saved = saveReading(list, article, "old");
  updateReading(list, saved.id, "old", 20, false);
  saveReading(list, article, "current");
  assert.equal(saved.offset, 20);
  updateReading(list, saved.id, "old", 40, true);
  assert.equal(saved.offset, 20);
  assert.equal(saved.status, "in-progress");
  updateReading(list, saved.id, "current", 4, false);
  assert.equal(saved.offset, 4, "rewinding saves the new playback position");
  list.splice(0);
  updateReading(list, saved.id, "current", 30, false);
  assert.equal(list.length, 0, "progress cannot recreate a removed read");
});

test("only playback completion marks a read complete; replay resets it", () => {
  const list = [];
  const item = saveReading(list, article, "session");
  updateReading(list, item.id, "session", article.text.length, false);
  assert.equal(item.status, "in-progress");
  assert.ok(readingProgress(item).percent < 100);
  updateReading(list, item.id, "session", 0, true);
  assert.deepEqual(readingProgress(item), { percent: 100, remainingWords: 0, minutes: 0 });
  updateReading(list, item.id, "session", 0, false);
  assert.equal(item.status, "completed");
  saveReading(list, article, "replay");
  assert.equal(item.status, "in-progress");
  assert.equal(item.offset, 0);
});

test("resume repeats only the unfinished word, including at word boundaries", () => {
  assert.equal(resumeOffset(article.text, 0), 0);
  assert.equal(resumeOffset(article.text, 20), 16);
  assert.equal(resumeOffset(article.text, 26), 23);
  assert.equal(resumeOffset(article.text, 23), 23);
  assert.equal(resumeOffset(article.text, 33), 33);
});

test("spoken math timestamps map back to the original saved text", () => {
  const text = "The $n^\\text{th}$ time. Another sentence.";
  const spoken = prepareSpokenSource(text);
  const timings = mapReadingOffsets(spoken, [
    { text: "The", start: 0, end: 1 }, { text: "nth", start: 1, end: 2 },
    { text: "time", start: 2, end: 3 }, { text: "Another", start: 3, end: 4 },
  ]);
  assert.deepEqual(timings.map(t => t.offset), [0, text.indexOf("$"), text.indexOf("time"), text.indexOf("Another")]);
});

test("reading URLs preserve query parameters and reject unsafe schemes", () => {
  assert.equal(readingUrl("https://example.com/article?id=3#part"), "https://example.com/article?id=3");
  assert.throws(() => readingUrl("javascript:alert(1)"));
});
