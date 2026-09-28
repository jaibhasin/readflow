import assert from "node:assert/strict";
import test from "node:test";

import { locateWordOffsets, normalizeForSearch } from "../extension/text-map.ts";

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
