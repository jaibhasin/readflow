export function isPlaybackRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.75 && value <= 3;
}

let settingsQueue = Promise.resolve();

export function handlePlaybackSettings(message: { type?: string; rate?: unknown }): Promise<object> | undefined {
  if (message.type === "playback_settings") {
    return settingsQueue.then(async () => {
      const settings = await chrome.storage.local.get("playbackRate");
      return { rate: isPlaybackRate(settings.playbackRate) ? settings.playbackRate : 1 };
    }).catch(() => ({ rate: 1 }));
  }
  if (message.type !== "select_playback_rate") return;
  const rate = message.rate;
  if (!isPlaybackRate(rate)) return Promise.resolve({ error: "Invalid playback speed." });
  const saved = settingsQueue.then(async () => {
    await chrome.storage.local.set({ playbackRate: rate });
    return { ok: true };
  }).catch(() => ({ error: "Could not save your playback speed. Try again." }));
  settingsQueue = saved.then(() => undefined);
  return saved;
}
