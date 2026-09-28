import assert from "node:assert/strict";
import test from "node:test";

import { bufferFramesForSpeed, nextPlaybackRate, playbackDuration, playedFrames } from "../extension/playback-speed.ts";

test("cycles through the available speeds", () => {
  assert.equal(nextPlaybackRate(1), 1.25);
  assert.equal(nextPlaybackRate(1.5), 0.75);
});

test("audio frames and elapsed time use the same speed", () => {
  assert.equal(playbackDuration(44_100, 44_100, 1.25), 0.8);
  assert.equal(playedFrames(0.8, 44_100, 1.25), 44_100);
});

test("the buffer keeps 100 ms of wall time at faster speeds", () => {
  assert.equal(bufferFramesForSpeed(4_410, 1.5), 6_615);
  assert.ok(Math.abs(playbackDuration(6_615, 44_100, 1.5) - 0.1) < 1e-12);
});
