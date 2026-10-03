import assert from "node:assert/strict";
import test from "node:test";

import { prepareSpokenSource, prepareSpokenText } from "../extension/spoken-text.ts";

test("speaks an inline ordinal instead of its math markup", () => {
  assert.equal(
    prepareSpokenText("After repeating myself for the $n^\\text{th}$ time."),
    "After repeating myself for the nth time.",
  );
});

test("leaves unsupported formulas intact", () => {
  assert.equal(prepareSpokenText("Energy is $E=mc^2$."), "Energy is $E=mc^2$.");
});

test("spoken cleanup retains the original offset after a shortened formula", () => {
  const source = "The $n^\\text{th}$ time. The $n^\\text{th}$ time.";
  const spoken = prepareSpokenSource(source);
  assert.equal(spoken.text, "The nth time. The nth time.");
  assert.equal(spoken.sourceOffsets.length, spoken.text.length);
  const second = spoken.text.lastIndexOf("time");
  assert.equal(spoken.sourceOffsets[second], source.lastIndexOf("time"));
  assert.equal(spoken.sourceOffsets[spoken.text.indexOf("nth")], source.indexOf("$"));
});
