export function resolveSeekTarget(
  requestedFrame: number,
  receivedFrames: number,
  streamFinished: boolean,
  bufferFrames: number,
): { targetFrame: number; waiting: boolean } {
  const targetFrame = Math.max(0, Math.floor(requestedFrame));
  if (streamFinished) {
    return { targetFrame: Math.min(targetFrame, receivedFrames), waiting: false };
  }
  return {
    targetFrame,
    waiting: receivedFrames - targetFrame < bufferFrames,
  };
}
