import assert from "node:assert/strict";
import test from "node:test";
import { StreamingTimeStretch } from "../extension/time-stretch.ts";

const sampleRate = 44100;
const tone = Float32Array.from({ length: sampleRate * 2 }, (_, i) => 0.4 * Math.sin(2 * Math.PI * 220 * i / sampleRate));
function render(samples, speed, chunkSize) {
  const stretch = new StreamingTimeStretch(speed, sampleRate);
  const chunks = [];
  for (let i = 0; i < samples.length; i += chunkSize) {
    chunks.push(stretch.push(samples.subarray(i, i + chunkSize)));
  }
  chunks.push(stretch.finish());
  const result = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  assert.equal(stretch.finish().length, 0);
  assert.throws(() => stretch.push(tone), /after finishing/);
  return result;
}
function frequency(samples) {
  // Exclude the start/end overlap, then count positive-going zero crossings.
  const start = Math.floor(sampleRate * 0.2);
  const end = samples.length - start;
  let crossings = 0;
  for (let i = start + 1; i < end; i += 1) {
    if (samples[i - 1] <= 0 && samples[i] > 0) crossings += 1;
  }
  return crossings * sampleRate / (end - start);
}
for (const speed of [0.75, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 2, 3]) {
  test(`${speed}x changes duration while preserving a 220 Hz voice fundamental`, () => {
    const result = render(tone, speed, 997);
    assert.equal(result.length, Math.round(tone.length / speed));
    assert.ok(Math.abs(frequency(result) - 220) < 2, `frequency: ${frequency(result)}`);
    assert.ok(result.every(Number.isFinite));
  });
}
test("network chunk boundaries do not change the output", () => {
  assert.deepEqual(render(tone, 1.4, 997), render(tone, 1.4, 8192));
});
test("normal speed retains every original sample", () => {
  assert.deepEqual(render(tone, 1, 333), tone);
});
test("short final audio is drained rather than lost to lookahead", () => {
  const short = tone.subarray(0, 2205);
  const result = render(short, 1.4, 101);
  assert.equal(result.length, Math.round(short.length / 1.4));
  assert.ok(result.some((value) => Math.abs(value) > 0.1));
});
test("a final voiced tail survives draining", () => {
  const samples = new Float32Array(sampleRate);
  samples.set(tone.subarray(0, 4410), sampleRate - 4410);
  const result = render(samples, 1.4, 511);
  assert.ok(result.subarray(-2000).some((value) => Math.abs(value) > 0.1));
});
test("empty streams and invalid settings are handled", () => {
  assert.equal(render(new Float32Array(), 1.4, 100).length, 0);
  for (const speed of [0, -1, NaN, Infinity]) {
    assert.throws(() => new StreamingTimeStretch(speed, sampleRate));
  }
});
