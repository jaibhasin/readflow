export type ReadingItem = {
  id: string;
  url: string;
  title: string;
  source: "article" | "selection";
  text: string;
  offset: number;
  status: "queued" | "in-progress" | "completed";
  updatedAt: string;
  sessionId?: string;
};

export const READING_LIST_KEY = "readingList";

export function readingUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only web articles can be saved.");
  url.hash = "";
  return url.href;
}

export function readingProgress(item: ReadingItem): { percent: number; remainingWords: number; minutes: number } {
  const total = item.text.match(/\S+/g)?.length || 0;
  const remainingWords = item.status === "completed" ? 0 : item.text.slice(item.offset).match(/\S+/g)?.length || 0;
  return {
    percent: item.status === "completed" ? 100 : Math.min(99, Math.max(0, Math.floor((total - remainingWords) / Math.max(1, total) * 100))),
    remainingWords,
    minutes: Math.ceil(remainingWords / 180),
  };
}

export function resumeOffset(text: string, offset: number): number {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  let start = 0;
  for (const word of segmenter.segment(text)) {
    if (word.index > offset) break;
    if (word.isWordLike) start = word.index;
  }
  return start;
}

export function saveReading(items: ReadingItem[], input: Pick<ReadingItem, "url" | "title" | "source" | "text">, sessionId?: string): ReadingItem {
  const url = readingUrl(input.url);
  const existing = items.find((item) => item.url === url && item.source === input.source && item.text === input.text);
  const item: ReadingItem = existing ?? {
    ...input, url, id: crypto.randomUUID(), offset: 0, status: "queued", updatedAt: new Date().toISOString(),
  };
  if (sessionId) {
    if (item.status === "completed" || item.offset >= item.text.length) item.offset = 0;
    item.sessionId = sessionId;
    item.status = "in-progress";
  }
  item.updatedAt = new Date().toISOString();
  if (!existing) items.push(item);
  return item;
}

export function updateReading(items: ReadingItem[], id: string, sessionId: string, offset: number, completed: boolean): void {
  const item = items.find((entry) => entry.id === id && entry.sessionId === sessionId);
  if (!item || item.status === "completed") return;
  item.offset = completed ? item.text.length : Math.max(0, Math.min(item.text.length - 1, Math.floor(offset)));
  item.status = completed ? "completed" : "in-progress";
  item.updatedAt = new Date().toISOString();
}
