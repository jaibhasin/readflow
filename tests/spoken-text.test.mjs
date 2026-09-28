import assert from "node:assert/strict";
import test from "node:test";

import { prepareSpokenText } from "../extension/spoken-text.ts";

test("speaks an inline ordinal instead of its math markup", () => {
  assert.equal(
    prepareSpokenText("After repeating myself for the $n^\\text{th}$ time."),
    "After repeating myself for the nth time.",
  );
});

test("leaves unsupported formulas intact", () => {
  assert.equal(prepareSpokenText("Energy is $E=mc^2$."), "Energy is $E=mc^2$.");
});
