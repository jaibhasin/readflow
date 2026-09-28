import assert from "node:assert/strict";
import test from "node:test";

import { locateWordOffsets, normalizeForSearch, sentenceSpans } from "../extension/text-map.ts";

test("groups words by sentence without including leading spaces", () => {
  assert.deepEqual(sentenceSpans("First sentence.  Second sentence?"), [
    { start: 0, end: 15 },
    { start: 17, end: 33 },
  ]);
});

test("keeps headings and paragraphs separate when the DOM adds no whitespace", () => {
  const blocks = ["Title", "First sentence. Second sentence.", "Next heading", "Body sentence."];
  const text = blocks.join("");
  const starts = blocks.map((_, index) => blocks.slice(0, index).join("").length);
  const sentences = sentenceSpans(text, starts).map(({ start, end }) => text.slice(start, end));
  assert.deepEqual(sentences, ["Title", "First sentence.", "Second sentence.", "Next heading", "Body sentence."]);
});

test("matches spoken nth to rendered superscript text", () => {
  const page = normalizeForSearch("for the nᵗʰ time on how");
  const offsets = locateWordOffsets(page, ["for", "the", "nth", "time"], 0);
  assert.deepEqual(offsets, [0, 4, 8, 12]);
});

test("skips unmatched math and resumes at the next nearby word", () => {
  const page = normalizeForSearch("for the $n^\\text{th}$ time on how");
  const offsets = locateWordOffsets(page, ["for", "the", "nth", "time", "on"], 0);
  assert.deepEqual(offsets.slice(0, 3), [0, 4, null]);
  assert.equal(page.slice(offsets[3], offsets[3] + 4), "time");
  assert.equal(page.slice(offsets[4], offsets[4] + 2), "on");
});

test("does not attach a word to a distant occurrence", () => {
  const page = normalizeForSearch(`start ${"filler ".repeat(20)}time`);
  assert.deepEqual(locateWordOffsets(page, ["start", "time"], 0), [0, null]);
});
