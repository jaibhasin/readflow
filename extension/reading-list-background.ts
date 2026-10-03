import { READING_LIST_KEY, readingUrl, saveReading, updateReading, type ReadingItem } from "./reading-list-store.ts";

let queue = Promise.resolve();
async function items(): Promise<ReadingItem[]> {
  const stored = await chrome.storage.local.get(READING_LIST_KEY);
  return (stored[READING_LIST_KEY] as ReadingItem[] | undefined) || [];
}

export function handleReadingMessage(message: Record<string, unknown>, sender: chrome.runtime.MessageSender): Promise<unknown> | undefined {
  if (typeof message.type !== "string" || !message.type.startsWith("reading_") && message.type !== "open_reading_list") return;
  const run = async (): Promise<unknown> => {
    if (message.type === "open_reading_list") {
      await chrome.tabs.create({ url: chrome.runtime.getURL("extension/reading-list.html") });
      return { ok: true };
    }
    const list = await items();
    if (message.type === "reading_list") return { items: list };
    if (message.type === "reading_for_page") {
      const tabId = sender.tab?.id;
      const key = `readingTab:${tabId}`;
      const requested = tabId === undefined ? undefined : (await chrome.storage.session.get(key))[key];
      if (requested && tabId !== undefined) await chrome.storage.session.remove(key);
      const url = readingUrl(sender.url || "");
      const item = list.find((entry) => entry.id === requested && entry.url === url)
        ?? list.filter((entry) => entry.url === url && entry.source === "article" && entry.status !== "completed")
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      return { item };
    }
    if (message.type === "reading_open") {
      const item = list.find((entry) => entry.id === message.id);
      if (!item) throw new Error("This read has been removed.");
      const url = readingUrl(item.url);
      const tab = await chrome.tabs.create({ url: "about:blank" });
      if (tab.id === undefined) throw new Error("Could not open this article.");
      await chrome.storage.session.set({ [`readingTab:${tab.id}`]: item.id });
      await chrome.tabs.update(tab.id, { url });
      return { ok: true };
    }
    if (message.type === "reading_save") {
      const input = message.item as Partial<ReadingItem> | undefined;
      if (!input || typeof input.text !== "string" || !input.text.trim() || typeof input.title !== "string" || typeof input.url !== "string"
        || !["article", "selection"].includes(input.source || "")) throw new Error("Could not save this read.");
      if (!sender.tab || readingUrl(sender.url || "") !== readingUrl(input.url)) throw new Error("Save this read from its article tab.");
      const item = saveReading(list, input as ReadingItem, typeof message.sessionId === "string" ? message.sessionId : undefined);
      await chrome.storage.local.set({ [READING_LIST_KEY]: list });
      return { item };
    }
    if (message.type === "reading_progress") {
      if (typeof message.id !== "string" || typeof message.sessionId !== "string" || typeof message.offset !== "number" || !Number.isFinite(message.offset)) throw new Error("Invalid reading progress.");
      const item = list.find((entry) => entry.id === message.id);
      if (!sender.tab || !item || readingUrl(sender.url || "") !== item.url) return { ok: false };
      updateReading(list, message.id, message.sessionId, message.offset, message.completed === true);
    } else if (message.type === "reading_remove") {
      const index = list.findIndex((entry) => entry.id === message.id);
      if (index >= 0) list.splice(index, 1);
    } else {
      throw new Error("Unknown reading list action.");
    }
    await chrome.storage.local.set({ [READING_LIST_KEY]: list });
    return { ok: true };
  };
  const result = queue.then(run);
  queue = result.then(() => undefined, () => undefined);
  return result.catch((error: unknown) => ({ error: error instanceof Error ? error.message : "Could not update your reading list." }));
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(`readingTab:${tabId}`);
});
