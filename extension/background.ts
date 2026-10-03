import { handleReadingMessage } from "./reading-list-background";
import {
  appendTraceEvent,
  consumeDetailedCapture,
  createTraceSession,
  type TraceEvent,
  type TraceSession,
} from "./diagnostics-store";
import type { TextSection } from "./text-sections";
import { DEFAULT_VOICE, isFishVoice, type VoicePage } from "./voices";
import { keepSessionConnected } from "./session-connection";

type StreamEvent = {
  event: "connected" | "audio" | "finish" | "error";
  [key: string]: unknown;
};

chrome.runtime.onMessage.addListener((message: { type?: string; query?: string; page?: number; voice?: unknown; favorite?: boolean }, _sender, sendResponse) => {
  const readingResponse = handleReadingMessage(message as Record<string, unknown>, _sender);
  if (readingResponse) {
    void readingResponse.then(sendResponse);
    return true;
  }
  if (message.type === "open_diagnostics") {
    void chrome.tabs.create({ url: chrome.runtime.getURL("extension/diagnostics.html") });
  } else if (message.type === "list_voices") {
    const query = new URLSearchParams({
      query: (message.query || "").slice(0, 100),
      page: String(Math.max(1, Math.floor(Number(message.page) || 1))),
    });
    void fetch(`http://127.0.0.1:4179/v1/voices?${query}`, { signal: AbortSignal.timeout(15_000) })
      .then(async (response) => {
        const data = await response.json() as VoicePage & { detail?: string };
        if (!response.ok) throw new Error(data.detail || "Could not load Fish Audio voices.");
        if (!Array.isArray(data.voices) || !data.voices.every(isFishVoice)) throw new Error("The voice library returned an invalid response.");
        sendResponse({ ...data, voices: data.voices.filter((voice) => voice.languages.some((language) => language.toLowerCase().split("-")[0] === "en")) });
      }).catch((error: unknown) => sendResponse({ error: error instanceof Error ? error.message : "Start the Readflow bridge to browse voices." }));
    return true;
  } else if (message.type === "voice_settings") {
    void chrome.storage.local.get(["selectedVoice", "favoriteVoices"]).then((settings) => sendResponse({
      selected: isFishVoice(settings.selectedVoice) ? settings.selectedVoice : DEFAULT_VOICE,
      favorites: Array.isArray(settings.favoriteVoices) ? settings.favoriteVoices.filter(isFishVoice) : [DEFAULT_VOICE],
    })).catch(() => sendResponse({ selected: DEFAULT_VOICE, favorites: [DEFAULT_VOICE] }));
    return true;
  } else if (message.type === "select_voice" && isFishVoice(message.voice)) {
    void chrome.storage.local.set({ selectedVoice: message.voice }).then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ error: "Could not save your voice. Try again." }));
    return true;
  } else if (message.type === "favorite_voice" && isFishVoice(message.voice)) {
    const voice = message.voice;
    voiceSettingsQueue = voiceSettingsQueue.catch(() => undefined).then(async () => {
      const settings = await chrome.storage.local.get("favoriteVoices");
      const favorites = (Array.isArray(settings.favoriteVoices) ? settings.favoriteVoices.filter(isFishVoice) : [DEFAULT_VOICE])
        .filter((item) => item.id !== voice.id);
      if (message.favorite) favorites.push(voice);
      await chrome.storage.local.set({ favoriteVoices: favorites });
      sendResponse({ ok: true });
    }).catch(() => sendResponse({ error: "Could not save your favorites. Try again." }));
    return true;
  }
});

let voiceSettingsQueue = Promise.resolve();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "readflow-tts") {
    return;
  }

  const controller = new AbortController();
  const stopHeartbeat = keepSessionConnected(chrome.runtime);
  let sessionController: AbortController | null = null;
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
    stopHeartbeat();
    disconnected = true;
    controller.abort();
    sessionController?.abort();
    schedulerTicks.delete(port);
    bufferStatusByPort.delete(port);
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
    sections?: TextSection[];
    rate?: number;
    audibleFrame?: number;
    paused?: boolean;
    pendingSeek?: boolean;
  }) => {
    if (message.type === "start" && message.text && message.sessionId && message.sections?.length) {
      sessionController = new AbortController();
      bufferStatusByPort.set(port, {
        audibleFrame: 0,
        rate: Math.max(0.5, Number(message.rate) || 1),
        paused: false,
        pendingSeek: false,
      });
      const abortSession = (): void => sessionController?.abort();
      controller.signal.addEventListener("abort", abortSession, { once: true });
      void startSession(port, message, sessionController.signal, () => disconnected, (created, mode) => {
        session = created;
        persistQueue = createTraceSession(created).catch(() => undefined);
        port.postMessage({ event: "trace_mode", detailed: mode });
        for (const event of pendingEvents.splice(0)) {
          record(event.kind, event.fields);
        }
      }, record);
    } else if (message.type === "buffer_status") {
      const status = bufferStatusByPort.get(port);
      if (status) Object.assign(status, {
        audibleFrame: Math.max(0, Number(message.audibleFrame) || 0),
        rate: Math.max(0.5, Number(message.rate) || 1),
        paused: Boolean(message.paused),
        pendingSeek: Boolean(message.pendingSeek),
      });
      requestSchedulerTick(port);
    } else if (message.type === "set_speed") {
      const status = bufferStatusByPort.get(port);
      if (status) status.rate = Math.max(0.5, Number(message.rate) || 1);
      requestSchedulerTick(port);
    } else if (message.type === "client_event" && message.kind) {
      if (session && message.kind === "playback_started") {
        session.playback_started_ms = message.clientElapsedMs;
      } else if (session && message.kind === "playback_finished") {
        stopHeartbeat();
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
    sections?: TextSection[];
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
  await streamSections(port, message.sections || [], message.referenceId, session, signal, isDisconnected, record);
}

type BufferStatus = { audibleFrame: number; rate: number; paused: boolean; pendingSeek: boolean };
type HeldSection = { events: Array<Record<string, unknown>>; frames: number; finished: boolean };
const bufferStatusByPort = new WeakMap<chrome.runtime.Port, BufferStatus>();
const schedulerTicks = new WeakMap<chrome.runtime.Port, () => void>();

function requestSchedulerTick(port: chrome.runtime.Port): void {
  schedulerTicks.get(port)?.();
}

async function streamSections(
  port: chrome.runtime.Port,
  sections: TextSection[],
  referenceId: string | undefined,
  session: TraceSession,
  signal: AbortSignal,
  isDisconnected: () => boolean,
  record: (kind: string, fields?: Record<string, unknown>) => void,
): Promise<void> {
  const status = bufferStatusByPort.get(port) || { audibleFrame: 0, rate: 1, paused: false, pendingSeek: false };
  const requestController = new AbortController();
  const abortRequests = (): void => requestController.abort();
  signal.addEventListener("abort", abortRequests, { once: true });
  bufferStatusByPort.set(port, status);
  const held = sections.map((): HeldSection => ({ events: [], frames: 0, finished: false }));
  const starts = new Array<number>(sections.length).fill(0);
  let nextIndex = 0;
  let active = 0;
  let emittedThrough = 0;
  let failed = false;
  const limitForRate = (): number => status.rate >= 3 ? 3 : status.rate >= 2 ? 2 : 1;
  const bufferedFrames = (): number => Math.max(0, held.reduce((sum, section) => sum + section.frames, 0) - status.audibleFrame);
  let pump = (): void => undefined;
  schedulerTicks.set(port, () => pump());

  const emitReady = (): void => {
    while (emittedThrough < held.length) {
      const section = held[emittedThrough];
      starts[emittedThrough] = emittedThrough === 0 ? 0 : starts[emittedThrough - 1] + held[emittedThrough - 1].frames;
      for (const event of section.events.splice(0)) {
        const payload = { ...event };
        delete payload.raw;
        if (payload.event === "audio") {
          const localOffset = Number(payload.chunk_audio_offset_sec) || 0;
          payload.chunk_audio_offset_sec = starts[emittedThrough] / 44_100 + localOffset;
          payload.section_index = emittedThrough;
          payload.section_start_frame = starts[emittedThrough];
        }
        port.postMessage(payload);
      }
      if (!section.finished) break;
      port.postMessage({ event: "section_finish", section_index: emittedThrough });
      emittedThrough += 1;
    }
    if (emittedThrough === held.length && nextIndex === sections.length && active === 0 && !failed) {
      port.postMessage({ event: "finish" });
      schedulerTicks.delete(port);
      bufferStatusByPort.delete(port);
    }
  };

  pump = (): void => {
    if (failed || signal.aborted || isDisconnected() || (status.paused && !status.pendingSeek)) return;
    const concurrency = limitForRate();
    while (active < concurrency && nextIndex < sections.length) {
      if (nextIndex >= concurrency && bufferedFrames() >= 12 * status.rate * 44_100) break;
      const section = sections[nextIndex++];
      active += 1;
      void streamSection(section).then(() => {
        active -= 1;
        emitReady();
        pump();
      }).catch((error: unknown) => {
        active -= 1;
        if (signal.aborted || isDisconnected() || failed) return;
        failed = true;
        requestController.abort();
        const message = error instanceof Error ? error.message : "Audio could not be generated.";
        finishSession(session, "error", message);
        record("error", { message });
        port.postMessage({ event: "error", message });
        schedulerTicks.delete(port);
        bufferStatusByPort.delete(port);
      });
    }
  };

  async function streamSection(section: TextSection): Promise<void> {
    const started = performance.now();
    const release = await acquireRequestSlot(requestController.signal);
    try {
      const response = await fetch("http://127.0.0.1:4179/v1/tts/stream/with-timestamp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: section.text,
          reference_id: referenceId,
          session_id: session.session_id,
          source: session.source,
        }),
        signal: requestController.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { detail?: string } | null;
        throw new Error(body?.detail || `The local Readflow bridge returned ${response.status}.`);
      }
      if (!response.body) throw new Error("The local Readflow bridge did not start an audio stream.");
      await forwardSectionEvents(response.body, section, held[section.index], port, session, isDisconnected, started, record, () => {
        emitReady();
        pump();
      });
    } finally {
      release();
    }
  }

  pump();
}

let activeRequests = 0;
const requestWaiters: Array<{ signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: Error) => void }> = [];

function acquireRequestSlot(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) return Promise.reject(new Error("Request cancelled."));
  return new Promise((resolve, reject) => {
    const waiter = { signal, resolve, reject };
    if (activeRequests < 3) {
      grantRequestSlot(resolve);
      return;
    }
    requestWaiters.push(waiter);
    signal.addEventListener("abort", () => {
      const index = requestWaiters.indexOf(waiter);
      if (index >= 0) requestWaiters.splice(index, 1);
      reject(new Error("Request cancelled."));
    }, { once: true });
  });
}

function grantRequestSlot(resolve: (release: () => void) => void): void {
  activeRequests += 1;
  let released = false;
  resolve(() => {
    if (released) return;
    released = true;
    activeRequests -= 1;
    while (requestWaiters.length && activeRequests < 3) {
      const waiter = requestWaiters.shift()!;
      if (waiter.signal.aborted) continue;
      grantRequestSlot(waiter.resolve);
      break;
    }
  });
}

async function forwardSectionEvents(
  body: ReadableStream<Uint8Array>,
  section: TextSection,
  held: HeldSection,
  port: chrome.runtime.Port,
  session: TraceSession,
  isDisconnected: () => boolean,
  requestStarted: number,
  record: (kind: string, fields?: Record<string, unknown>) => void,
  onProgress: () => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  try {
    while (!isDisconnected() && !held.finished) {
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
          held.frames += Math.floor(bytes / 2);
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
          held.events.push({ ...event });
          onProgress();
        } else if (event.event === "finish") {
          const fragments = Array.isArray(event.text_fragments) ? event.text_fragments : [];
          session.text_fragment_count = fragments.length;
          if (session.detailed) {
            record("text_fragments", { fragments });
          }
          record("provider_finish", {
            section_index: section.index,
            bridge_elapsed_ms: event.bridge_elapsed_ms,
            provider_event_index: event.provider_event_index,
            fish_time: event.fish_time,
            text_fragment_count: fragments.length,
          });
          held.finished = true;
          onProgress();
        } else if (event.event === "error") {
          const fragments = Array.isArray(event.text_fragments) ? event.text_fragments : [];
          session.text_fragment_count = fragments.length;
          if (session.detailed) {
            record("text_fragments", { fragments });
          }
          throw new Error(typeof event.message === "string" ? event.message : "Audio could not be generated.");
        }
      }

      if (done) {
        break;
      }
    }
    if (!held.finished && !isDisconnected()) {
      throw new Error("The local speech stream ended before this section finished.");
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
