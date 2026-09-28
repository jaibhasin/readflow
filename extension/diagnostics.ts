import {
  clearTraceSessions,
  deleteTraceSession,
  getDetailedCapture,
  listTraceEvents,
  listTraceSessions,
  setDetailedCapture,
  type TraceEvent,
  type TraceSession,
} from "./diagnostics-store";

const detailedToggle = document.querySelector<HTMLInputElement>("#detailed-toggle")!;
const recordStatus = document.querySelector<HTMLParagraphElement>("#record-status")!;
const sessionList = document.querySelector<HTMLElement>("#session-list")!;
const sessionDetail = document.querySelector<HTMLElement>("#session-detail")!;
const clearButton = document.querySelector<HTMLButtonElement>("#clear-button")!;

void initialize();

async function initialize(): Promise<void> {
  detailedToggle.checked = await getDetailedCapture().catch(() => false);
  updateRecordStatus();
  detailedToggle.addEventListener("change", async () => {
    await setDetailedCapture(detailedToggle.checked);
    updateRecordStatus();
  });
  clearButton.addEventListener("click", async () => {
    await clearTraceSessions();
    sessionDetail.replaceChildren();
    await renderSessions();
  });
  await renderSessions();
}

function updateRecordStatus(): void {
  recordStatus.textContent = detailedToggle.checked
    ? "The next listen will save the exact text and word timestamps on this device."
    : "Summaries only. Detailed text recording is off.";
}

async function renderSessions(): Promise<void> {
  const sessions = await listTraceSessions().catch(() => []);
  sessionList.replaceChildren();
  if (sessions.length === 0) {
    sessionList.textContent = "No listens recorded yet.";
    return;
  }

  for (const session of sessions) {
    const button = document.createElement("button");
    button.className = "session-item";
    button.type = "button";
    const firstAudio = typeof session.first_audio_request_ms === "number"
      ? ` · request to first audio ${Math.round(session.first_audio_request_ms)} ms`
      : "";
    button.textContent = `${session.source} · ${session.status}\n${new Date(session.started_at).toLocaleString()}\n${session.word_count} words · ${session.audio_event_count} audio events${firstAudio}`;
    button.addEventListener("click", () => void renderDetail(session));
    sessionList.append(button);
  }
}

async function renderDetail(session: TraceSession): Promise<void> {
  const events = await listTraceEvents(session.session_id).catch(() => []);
  sessionDetail.replaceChildren();

  const title = document.createElement("h2");
  title.textContent = `${session.source} listen`;
  const summary = document.createElement("p");
  summary.textContent = `${session.status} · ${session.word_count} words · ${session.text_char_count} characters · ${session.audio_event_count} audio events · ${session.audio_bytes} audio bytes`;
  sessionDetail.append(title, summary);

  const actions = document.createElement("div");
  actions.className = "detail-actions";
  const exportButton = document.createElement("button");
  exportButton.textContent = "Export JSON";
  exportButton.addEventListener("click", () => exportTrace(session, events));
  const deleteButton = document.createElement("button");
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", async () => {
    await deleteTraceSession(session.session_id);
    sessionDetail.replaceChildren();
    await renderSessions();
  });
  actions.append(exportButton, deleteButton);
  sessionDetail.append(actions);

  if (session.detailed && session.request_text) {
    appendBlock(sessionDetail, "Exact text sent to Readflow", session.request_text);
  }
  for (const event of events) {
    appendEvent(sessionDetail, event);
  }
  if (session.error) {
    appendBlock(sessionDetail, "Error", session.error);
  }
}

function appendEvent(container: HTMLElement, event: TraceEvent): void {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = `${event.sequence + 1}. ${event.kind}${elapsedLabel(event)}`;
  const pre = document.createElement("pre");
  const { session_id: _sessionId, sequence: _sequence, kind: _kind, ...fields } = event;
  pre.textContent = JSON.stringify(fields, null, 2);
  details.append(summary, pre);
  container.append(details);
}

function appendBlock(container: HTMLElement, label: string, text: string): void {
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = label;
  const pre = document.createElement("pre");
  pre.textContent = text;
  details.append(summary, pre);
  container.append(details);
}

function elapsedLabel(event: TraceEvent): string {
  const elapsed = event.client_elapsed_ms ?? event.bridge_elapsed_ms;
  return typeof elapsed === "number" ? ` · ${Math.round(elapsed)} ms` : "";
}

function exportTrace(session: TraceSession, events: TraceEvent[]): void {
  const data = JSON.stringify({ session, events }, null, 2);
  const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `readflow-${session.session_id}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
