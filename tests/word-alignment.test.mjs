import assert from "node:assert/strict";
import test from "node:test";
import { alignSpokenWords } from "../extension/word-alignment.ts";

test("repeated words and sentences align to successive source occurrences", () => {
  assert.deepEqual(alignSpokenWords("Keep going. Keep going.", ["Keep", "going.", "Keep", "going."]), [0, 5, 12, 17]);
});

test("whole words do not match inside longer words", () => {
  assert.deepEqual(alignSpokenWords("Theme. The reader continues.", ["The", "reader", "continues."]), [7, 11, 18]);
});

test("unmatched provider words stay unmapped while a unique nearby phrase can recover", () => {
  assert.deepEqual(alignSpokenWords("Version 2026. The results improved.", ["Version", "two", "thousand", "twenty", "six", "The", "results", "improved."]), [0, null, null, null, null, 14, 18, 26]);
});

test("a single repeated word cannot jump forward after a mismatch", () => {
  assert.deepEqual(alignSpokenWords("Start hidden words. Keep going. Keep going.", ["Start", "Keep"]), [0, null]);
});

test("an ambiguous repeated phrase is not used to recover a mismatch", () => {
  assert.deepEqual(alignSpokenWords("Start hidden. Keep going. Keep going.", ["Start", "Keep", "going"]), [0, null, null]);
});

test("an isolated matching word does not end uncertainty after a provider mismatch", () => {
  assert.deepEqual(alignSpokenWords("Keep going. Keep going.", ["Keep", "changed", "going"]), [0, null, null]);
});

test("punctuation and multiword timestamp segments retain the source start", () => {
  assert.deepEqual(alignSpokenWords("Hello, world! Hello, world!", ["Hello, world!", "Hello", "world!"]), [0, 14, 21]);
});

test("each cumulative snapshot is mapped deterministically from the source beginning", () => {
  const text = "Keep going. Keep going.";
  const partial = alignSpokenWords(text, ["Keep", "going."]);
  const complete = alignSpokenWords(text, ["Keep", "going.", "Keep", "going."]);
  assert.deepEqual(complete.slice(0, 2), partial);
});
