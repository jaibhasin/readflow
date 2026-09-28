import {
  appendTraceEvent,
  consumeDetailedCapture,
  createTraceSession,
  type TraceEvent,
  type TraceSession,
} from "./diagnostics-store";

type StreamEvent = {
  event: "connected" | "audio" | "finish" | "error";
  [key: string]: unknown;
};

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "readflow-tts") {
    return;
  }

  const controller = new AbortController();
  let disconnected = false;
  let session: TraceSession | null = null;
  let persistQueue = Promise.resolve();
  const pendingEvents: Array<{ kind: string; fields: Record<string, unknown> }> = [];

  const record = (kind: string, fields: Record<string, unknown> = {}): void => {
    if (!session) {
      pendingEvents.push({ kind, fields });
      return;
    }

    const event: TraceEvent = {
      session_id: session.session_id,
      sequence: session.next_sequence,
      kind,
      ...fields,
    };
    session.next_sequence += 1;
    persistQueue = persistQueue.then(() => appendTraceEvent(session!, event)).catch(() => undefined);
  };

  port.onDisconnect.addListener(() => {
    disconnected = true;
    controller.abort();
    if (session?.status === "running") {
      session.status = "cancelled";
      session.ended_at = new Date().toISOString();
      record("cancelled");
    }
  });

  port.onMessage.addListener((message: {
    type?: string;
    text?: string;
    referenceId?: string;
    sessionId?: string;
    source?: string;
    textCharCount?: number;
    wordCount?: number;
    startedAt?: string;
    kind?: string;
    clientElapsedMs?: number;
    playbackMs?: number;
    value?: unknown;
  }) => {
    if (message.type === "start" && message.text && message.sessionId) {
      void startSession(port, message, controller.signal, () => disconnected, (created, mode) => {
        session = created;
        persistQueue = createTraceSession(created).catch(() => undefined);
        port.postMessage({ event: "trace_mode", detailed: mode });
        for (const event of pendingEvents.splice(0)) {
          record(event.kind, event.fields);
        }
      }, record);
    } else if (message.type === "client_event" && message.kind) {
      if (session && message.kind === "playback_started") {
        session.playback_started_ms = message.clientElapsedMs;
      } else if (session && message.kind === "playback_finished") {
        finishSession(session, "finished");
      } else if (session && message.kind === "stopped") {
        finishSession(session, "stopped");
      } else if (session && message.kind === "playback_error") {
        finishSession(session, "error", typeof message.value === "string" ? message.value : undefined);
      }
      record(message.kind, {
        client_elapsed_ms: message.clientElapsedMs,
        playback_ms: message.playbackMs,
        value: message.value,
      });
    }
  });
});

async function startSession(
  port: chrome.runtime.Port,
  message: {
    text?: string;
    referenceId?: string;
    sessionId?: string;
    source?: string;
    textCharCount?: number;
    wordCount?: number;
    startedAt?: string;
  },
  signal: AbortSignal,
  isDisconnected: () => boolean,
  onSession: (session: TraceSession, detailed: boolean) => void,
  record: (kind: string, fields?: Record<string, unknown>) => void,
): Promise<void> {
  if (!message.text || !message.sessionId) {
    return;
  }

  const detailed = await consumeDetailedCapture().catch(() => false);
  const session: TraceSession = {
    session_id: message.sessionId,
    started_at: message.startedAt || new Date().toISOString(),
    source: message.source || "article",
    status: "running",
    detailed,
    text_char_count: message.textCharCount || message.text.length,
    word_count: message.wordCount || message.text.trim().split(/\s+/).length,
    ...(detailed ? { request_text: message.text } : {}),
    text_fragment_count: 0,
    audio_event_count: 0,
    audio_bytes: 0,
    alignment_snapshot_count: 0,
    next_sequence: 0,
  };
  onSession(session, detailed);
  record("request", {
    source: session.source,
    text_char_count: session.text_char_count,
    word_count: session.word_count,
    ...(detailed ? { request_text: message.text } : {}),
  });
  await streamSpeech(port, message.text, message.referenceId, session, signal, isDisconnected, record);
}

async function streamSpeech(
  port: chrome.runtime.Port,
  text: string,
  referenceId: string | undefined,
  session: TraceSession,
  signal: AbortSignal,
  isDisconnected: () => boolean,
  record: (kind: string, fields?: Record<string, unknown>) => void,
): Promise<void> {
  const requestStarted = performance.now();
  try {
    const response = await fetch("http://127.0.0.1:4179/v1/tts/stream/with-timestamp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        reference_id: referenceId,
        session_id: session.session_id,
        source: session.source,
      }),
      signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null) as { detail?: string } | null;
      throw new Error(body?.detail || `The local Readflow bridge returned ${response.status}.`);
    }
    if (!response.body) {
      throw new Error("The local Readflow bridge did not start an audio stream.");
    }

    await forwardEvents(response.body, port, session, isDisconnected, requestStarted, record);
  } catch (error) {
    if (!signal.aborted && !isDisconnected()) {
      const message = error instanceof Error ? error.message : "Audio could not be started.";
      finishSession(session, "error", message);
      record("error", { message, client_elapsed_ms: performance.now() - requestStarted });
      port.postMessage({ event: "error", message });
    }
  }
}

async function forwardEvents(
  body: ReadableStream<Uint8Array>,
  port: chrome.runtime.Port,
  session: TraceSession,
  isDisconnected: () => boolean,
  requestStarted: number,
  record: (kind: string, fields?: Record<string, unknown>) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  try {
    while (!isDisconnected()) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      const records = pending.replaceAll("\r\n", "\n").split("\n\n");
      pending = records.pop() || "";

      for (const rawRecord of records) {
        const data = rawRecord.split("\n").filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || isDisconnected()) {
          continue;
        }

        const event = JSON.parse(data) as StreamEvent;
        if (event.event === "connected") {
          record("bridge_connected", {
            bridge_connect_ms: event.bridge_connect_ms,
            request_elapsed_ms: performance.now() - requestStarted,
          });
        } else if (event.event === "audio") {
          const bytes = Number(event.audio_byte_count) || 0;
          session.audio_event_count += 1;
          session.audio_bytes += bytes;
          session.first_audio_request_ms ??= performance.now() - requestStarted;
          session.first_audio_bridge_ms ??= Number(event.bridge_elapsed_ms);
          const fields = {
            audio_event_index: event.audio_event_index,
            audio_byte_count: bytes,
            bridge_elapsed_ms: event.bridge_elapsed_ms,
            fish_time: event.fish_time,
            chunk_seq: event.chunk_seq,
            chunk_audio_offset_sec: event.chunk_audio_offset_sec,
            ...(session.detailed ? {
              content: event.content,
              alignment: withAbsoluteTimes(event.alignment, event.chunk_audio_offset_sec),
            } : {}),
          };
          if (session.detailed && event.alignment) {
            session.alignment_snapshot_count += 1;
          }
          record("audio", fields);
          if (session.audio_event_count === 1) {
            record("first_audio", {
              request_elapsed_ms: session.first_audio_request_ms,
              bridge_elapsed_ms: event.bridge_elapsed_ms,
            });
          }
        } else if (event.event === "finish") {
          const fragments = Array.isArray(event.text_fragments) ? event.text_fragments : [];
          session.text_fragment_count = fragments.length;
          if (session.detailed) {
            record("text_fragments", { fragments });
          }
          record("provider_finish", {
            bridge_elapsed_ms: event.bridge_elapsed_ms,
            provider_event_index: event.provider_event_index,
            fish_time: event.fish_time,
            text_fragment_count: fragments.length,
          });
        } else if (event.event === "error") {
          const fragments = Array.isArray(event.text_fragments) ? event.text_fragments : [];
          session.text_fragment_count = fragments.length;
          if (session.detailed) {
            record("text_fragments", { fragments });
          }
          const message = typeof event.message === "string" ? event.message : "Audio could not be generated.";
          finishSession(session, "error", message);
          record("error", { message, bridge_elapsed_ms: event.bridge_elapsed_ms });
        }

        port.postMessage(event);
        if (event.event === "finish" || event.event === "error") {
          return;
        }
      }

      if (done) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function withAbsoluteTimes(alignment: unknown, offset: unknown): unknown {
  if (!alignment || typeof alignment !== "object" || !Array.isArray((alignment as { segments?: unknown }).segments)) {
    return alignment;
  }

  const offsetSeconds = typeof offset === "number" ? offset : 0;
  const value = alignment as { segments: Array<Record<string, unknown>>; [key: string]: unknown };
  return {
    ...value,
    segments: value.segments.map((segment) => ({
      ...segment,
      absolute_start_sec: offsetSeconds + (typeof segment.start === "number" ? segment.start : 0),
      absolute_end_sec: offsetSeconds + (typeof segment.end === "number" ? segment.end : 0),
    })),
  };
}

function finishSession(session: TraceSession, status: TraceSession["status"], error?: string): void {
  session.status = status;
  session.ended_at = new Date().toISOString();
  if (error) {
    session.error = error;
  }
}
