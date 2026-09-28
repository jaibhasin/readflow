import assert from "node:assert/strict";
import test from "node:test";

import { resolveSeekTarget } from "../extension/seek-target.ts";

test("keeps a forward target while the stream is still catching up", () => {
  assert.deepEqual(resolveSeekTarget(15_000, 2_000, false, 100), {
    targetFrame: 15_000,
    waiting: true,
  });
  assert.deepEqual(resolveSeekTarget(15_000, 15_099, false, 100).waiting, true);
  assert.deepEqual(resolveSeekTarget(15_000, 15_100, false, 100).waiting, false);
});

test("clamps only when the full stream has ended", () => {
  assert.deepEqual(resolveSeekTarget(15_000, 8_000, true, 100), {
    targetFrame: 8_000,
    waiting: false,
  });
});
