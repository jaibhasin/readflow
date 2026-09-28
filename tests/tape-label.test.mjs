import assert from "node:assert/strict";
import test from "node:test";

import { shortTapeTitle } from "../extension/tape-label.ts";

test("uses the article title without the site suffix", () => {
  assert.equal(shortTapeTitle("Product Evals in Three Simple Steps | Eugene Yan"), "Product Evals in Three Simple Steps");
});

test("has a label when the page has no title", () => {
  assert.equal(shortTapeTitle(""), "Untitled article");
});
