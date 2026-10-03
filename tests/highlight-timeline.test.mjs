import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createSelectionSource } from "../extension/reading-source.ts";
import { prepareSpokenSource } from "../extension/spoken-text.ts";
import { mapSentenceTimings } from "../extension/highlight-timeline.ts";

function timeline(document, words) {
  const selection = document.createRange();
  selection.selectNodeContents(document.querySelector("article"));
  const source = createSelectionSource(selection);
  return mapSentenceTimings(source, prepareSpokenSource(source.text), words.map((text, index) => ({ text, start: index, end: index + 0.5 })));
}

test("repeated sentences highlight their own paragraph throughout the timeline", () => {
  const document = new JSDOM("<nav>Keep going.</nav><article><p id='first'>Keep going.</p><p id='second'>Keep <strong>going</strong>.</p></article>").window.document;
  const timings = timeline(document, ["Keep", "going.", "Keep", "going."]);
  assert.equal(timings[0].ranges[0].startContainer.parentElement.id, "first");
  assert.equal(timings[2].ranges[0].startContainer.parentElement.id, "second");
  assert.equal(timings[3].ranges.map(range => range.toString()).join(""), "Keep going.");
  assert.notEqual(timings[0].sentenceKey, timings[2].sentenceKey);
});

test("spoken cleanup does not shift the second identical sentence to the first", () => {
  const document = new JSDOM("<article><p id='first'>The $n^\\text{th}$ time.</p><p id='second'>The $n^\\text{th}$ time.</p></article>").window.document;
  const timings = timeline(document, ["The", "nth", "time.", "The", "nth", "time."]);
  assert.equal(timings[1].ranges[0].startContainer.parentElement.id, "first");
  assert.equal(timings[4].ranges[0].startContainer.parentElement.id, "second");
});

test("unmapped timestamps clear the cue rather than holding a previous sentence", () => {
  const document = new JSDOM("<article><p>Keep going.</p><p>Keep going.</p></article>").window.document;
  const timings = timeline(document, ["Keep", "changed", "going"]);
  assert.ok(timings[0].ranges.length);
  assert.deepEqual(timings[1].ranges, []);
  assert.deepEqual(timings[2].ranges, []);
});
