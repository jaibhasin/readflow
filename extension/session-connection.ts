// An open port alone does not keep a Manifest V3 worker alive. Run the heartbeat
// in the worker so hidden article tabs cannot throttle it while playback is paused.
export function keepSessionConnected(
  runtime: Pick<typeof chrome.runtime, "getPlatformInfo" | "lastError">,
  timers: Pick<typeof globalThis, "setInterval" | "clearInterval"> = globalThis,
): () => void {
  const timer = timers.setInterval(() => {
    runtime.getPlatformInfo(() => { void runtime.lastError; });
  }, 20_000);
  return () => timers.clearInterval(timer);
}
