import { READING_LIST_KEY, readingProgress, type ReadingItem } from "./reading-list-store.ts";

const notice = document.querySelector<HTMLElement>("#notice")!;
async function message<T>(input: object): Promise<T> {
  const result = await chrome.runtime.sendMessage(input);
  if (result?.error) throw new Error(result.error);
  return result as T;
}
function action(button: HTMLButtonElement, run: () => Promise<void>): void {
  button.addEventListener("click", () => {
    button.disabled = true;
    void run().catch((error: unknown) => {
      notice.textContent = error instanceof Error ? error.message : "Could not update your reads. Try again.";
    }).finally(() => { button.disabled = false; });
  });
}
function empty(container: HTMLElement, text: string): void {
  const panel = document.createElement("div");
  panel.className = "empty";
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  panel.append(paragraph);
  container.append(panel);
}
function renderCard(item: ReadingItem): HTMLElement {
  const card = document.createElement("article");
  card.dataset.status = item.status;
  card.dataset.readId = item.id;
  const label = document.createElement("div"); label.className = "tape-label";
  const meta = document.createElement("div"); meta.className = "tape-meta";
  const mark = document.createElement("span"); mark.className = "tape-mark";
  mark.textContent = item.source === "selection" ? "PASSAGE" : "ARTICLE";
  const title = document.createElement("h3");
  const link = document.createElement("a");
  link.className = "read-link";
  link.dataset.action = "link";
  link.href = item.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = item.title || "Untitled article";
  link.setAttribute("aria-label", `Open ${link.textContent} in a new tab`);
  title.append(link);
  const site = document.createElement("p");
  site.className = "site";
  site.textContent = `${new URL(item.url).hostname}${item.source === "selection" ? " · Selected passage" : ""}`;
  const status = document.createElement("p");
  status.className = "status";
  const { percent, remainingWords, minutes } = readingProgress(item);
  const lead = document.createElement("span"); lead.className = "status-lead";
  lead.textContent = item.status === "completed" ? "Completed" : item.status === "queued" ? "Not started" : `${percent}% read`;
  status.append(lead);
  if (item.status !== "completed") {
    const detail = document.createElement("span"); detail.className = "status-detail";
    detail.textContent = item.status === "queued" ? `About ${minutes} min` : `${remainingWords.toLocaleString()} words left · About ${minutes} min left`;
    status.append(" ", detail);
  }
  meta.append(mark, site); label.append(meta, title);
  const body = document.createElement("div"); body.className = "read-body";
  body.append(status); card.append(label, body);
  if (item.status === "in-progress") {
    const progress = document.createElement("progress");
    progress.max = 100; progress.value = percent;
    progress.setAttribute("aria-label", `${percent}% read`);
    body.append(progress);
  }
  const actions = document.createElement("div"); actions.className = "actions";
  const open = document.createElement("button"); open.type = "button";
  open.className = "play";
  open.dataset.action = "open";
  open.textContent = item.status === "in-progress" ? "Resume" : item.status === "queued" ? "Start reading" : "Read again";
  action(open, async () => { await message({ type: "reading_open", id: item.id }); });
  card.addEventListener("click", (event) => {
    const target = event.target as Element;
    if (target.closest("button") || event.defaultPrevented || event.button !== 0
      || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    open.click();
  });
  const remove = document.createElement("button"); remove.type = "button";
  remove.className = "remove"; remove.textContent = "Remove";
  remove.dataset.action = "remove";
  remove.setAttribute("aria-label", `Remove ${item.title}`);
  action(remove, async () => { await message({ type: "reading_remove", id: item.id }); await render(); });
  actions.append(open, remove); body.append(actions);
  return card;
}
async function render(): Promise<void> {
  const { items } = await message<{ items: ReadingItem[] }>({ type: "reading_list" });
  const focused = document.activeElement as HTMLElement | null;
  const focusedRead = focused?.closest<HTMLElement>("article")?.dataset.readId;
  const focusedAction = focused?.dataset.action;
  const sections = [
    { id: "pending", status: "in-progress", label: "In progress", empty: "No unfinished reads yet. Start listening to an article to see it here." },
    { id: "future", status: "queued", label: "To read", empty: "Nothing saved for later. Use Save for later on an article, or save the current article above." },
    { id: "done", status: "completed", label: "Completed reads", empty: "Finished reads will appear here." },
  ];
  for (const section of sections) {
    const container = document.getElementById(section.id)!;
    container.replaceChildren();
    const reads = items.filter((item) => item.status === section.status).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const item of reads) container.append(renderCard(item));
    if (!reads.length) empty(container, section.empty);
    if (section.id !== "done") {
      const heading = document.getElementById(`${section.id}-title`)!;
      const count = document.createElement("span"); count.className = "count"; count.textContent = `(${reads.length})`;
      heading.replaceChildren(`${section.label} `, count);
    } else document.querySelector("#completed summary")!.textContent = `${section.label} (${reads.length})`;
  }
  if (focusedRead && focusedAction) {
    const card = Array.from(document.querySelectorAll<HTMLElement>("article")).find((item) => item.dataset.readId === focusedRead);
    card?.querySelector<HTMLElement>(`[data-action="${focusedAction}"]`)?.focus({ preventScroll: true });
  }
}
action(document.querySelector("#debug")!, async () => { await message({ type: "open_diagnostics" }); });
action(document.querySelector("#expand")!, async () => { await message({ type: "open_reading_list" }); });
action(document.querySelector("#save")!, async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) throw new Error("Open a readable article first.");
  let response;
  try { response = await chrome.tabs.sendMessage(tab.id, { type: "save_read" }); }
  catch { throw new Error("Open a readable article and refresh its tab, then save it here."); }
  if (response?.error) throw new Error(response.error);
  notice.textContent = "Saved for later.";
  await render();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[READING_LIST_KEY]) void render().catch(() => { notice.textContent = "Could not refresh your reading list."; });
});
void render().catch((error: unknown) => { notice.textContent = error instanceof Error ? error.message : "Could not load your reading list."; });

void chrome.tabs.getCurrent().then((tab) => {
  document.body.dataset.view = tab ? "page" : "popup";
  if (tab) {
    document.getElementById("save")!.hidden = true;
    document.getElementById("expand")!.hidden = true;
  }
});
