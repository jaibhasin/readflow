import assert from "node:assert/strict";
import test from "node:test";
import { handlePlaybackSettings } from "../extension/playback-settings.ts";

test("settings persist rapid speed changes in order, including resetting to 1x", async () => {
  const stored = {};
  const writes = [];
  globalThis.chrome = { storage: { local: {
    async get() { return { ...stored }; },
    async set(values) {
      await new Promise(resolve => setTimeout(resolve, values.playbackRate === 1.2 ? 10 : 0));
      writes.push(values.playbackRate);
      Object.assign(stored, values);
    },
  } } };
  assert.deepEqual(await handlePlaybackSettings({ type: "playback_settings" }), { rate: 1 });
  await Promise.all([1.2, 1.3, 1].map(rate => handlePlaybackSettings({ type: "select_playback_rate", rate })));
  assert.deepEqual(writes, [1.2, 1.3, 1]);
  assert.deepEqual(await handlePlaybackSettings({ type: "playback_settings" }), { rate: 1 });
});

test("invalid values and storage failures fall back safely and allow later saves", async () => {
  let rate = "1.2";
  let fail = false;
  globalThis.chrome = { storage: { local: {
    async get() { if (fail) throw new Error("storage unavailable"); return { playbackRate: rate }; },
    async set(values) { if (fail) throw new Error("storage unavailable"); rate = values.playbackRate; },
  } } };
  for (const value of [undefined, "1.2", NaN, Infinity, 0, 3.1]) {
    rate = value;
    assert.deepEqual(await handlePlaybackSettings({ type: "playback_settings" }), { rate: 1 });
    assert.ok((await handlePlaybackSettings({ type: "select_playback_rate", rate: value })).error);
  }
  fail = true;
  assert.ok((await handlePlaybackSettings({ type: "select_playback_rate", rate: 1.2 })).error);
  assert.deepEqual(await handlePlaybackSettings({ type: "playback_settings" }), { rate: 1 });
  fail = false;
  await handlePlaybackSettings({ type: "select_playback_rate", rate: 1.2 });
  assert.deepEqual(await handlePlaybackSettings({ type: "playback_settings" }), { rate: 1.2 });
});
