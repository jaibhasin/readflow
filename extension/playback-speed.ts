export const PLAYBACK_RATES = [0.75, 1, 1.1, 1.2, 1.3, 1.4, 1.5];

export function nextPlaybackRate(currentRate: number): number {
  const index = PLAYBACK_RATES.indexOf(currentRate);
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
}

export function playedFrames(elapsedSeconds: number, sampleRate: number, playbackRate: number): number {
  return elapsedSeconds * sampleRate * playbackRate;
}

export function playbackDuration(frameCount: number, sampleRate: number, playbackRate: number): number {
  return frameCount / sampleRate / playbackRate;
}

export function bufferFramesForSpeed(baseFrames: number, playbackRate: number): number {
  return Math.ceil(baseFrames * playbackRate);
}

export function isAudioAudible(ranges: Array<{ start: number; end: number }>, contextTime: number): boolean {
  return ranges.some((range) => range.start <= contextTime && contextTime < range.end);
}
