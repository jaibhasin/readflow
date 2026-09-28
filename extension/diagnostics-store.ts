export type TraceStatus = "running" | "finished" | "stopped" | "error" | "cancelled";

export type TraceSession = {
  session_id: string;
  started_at: string;
  ended_at?: string;
  source: string;
  status: TraceStatus;
  detailed: boolean;
  text_char_count: number;
  word_count: number;
  request_text?: string;
  text_fragment_count: number;
  audio_event_count: number;
  audio_bytes: number;
  alignment_snapshot_count: number;
  first_audio_request_ms?: number;
  first_audio_bridge_ms?: number;
  playback_started_ms?: number;
  error?: string;
  next_sequence: number;
};

export type TraceEvent = {
  session_id: string;
  sequence: number;
  kind: string;
  [key: string]: unknown;
};

type Setting = {
  key: string;
  value: boolean;
};

const DATABASE_NAME = "readflow-diagnostics";
const DATABASE_VERSION = 1;
const SESSION_STORE = "sessions";
const EVENT_STORE = "events";
const SETTINGS_STORE = "settings";
const MAX_SESSIONS = 10;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore(SESSION_STORE, { keyPath: "session_id" });
      const events = database.createObjectStore(EVENT_STORE, {
        keyPath: ["session_id", "sequence"],
      });
      events.createIndex("session_id", "session_id");
      database.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function consumeDetailedCapture(): Promise<boolean> {
  const database = await openDatabase();
  const transaction = database.transaction(SETTINGS_STORE, "readwrite");
  const done = waitForTransaction(transaction);
  const store = transaction.objectStore(SETTINGS_STORE);
  const request = store.get("detailed_next") as IDBRequest<Setting | undefined>;
  let enabled = false;

  request.onsuccess = () => {
    enabled = request.result?.value ?? false;
    store.put({ key: "detailed_next", value: false } satisfies Setting);
  };

  await done;
  database.close();
  return enabled;
}

export async function setDetailedCapture(enabled: boolean): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(SETTINGS_STORE, "readwrite");
  const done = waitForTransaction(transaction);
  transaction.objectStore(SETTINGS_STORE).put({ key: "detailed_next", value: enabled } satisfies Setting);
  await done;
  database.close();
}

export async function getDetailedCapture(): Promise<boolean> {
  const database = await openDatabase();
  const transaction = database.transaction(SETTINGS_STORE, "readonly");
  const request = transaction.objectStore(SETTINGS_STORE).get("detailed_next") as IDBRequest<Setting | undefined>;
  const setting = await new Promise<Setting | undefined>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return setting?.value ?? false;
}

export async function createTraceSession(session: TraceSession): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, "readwrite");
  const done = waitForTransaction(transaction);
  transaction.objectStore(SESSION_STORE).put(session);
  await done;
  database.close();
  await pruneOldSessions();
}

export async function appendTraceEvent(
  session: TraceSession,
  event: TraceEvent,
): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction([SESSION_STORE, EVENT_STORE], "readwrite");
  const done = waitForTransaction(transaction);
  transaction.objectStore(SESSION_STORE).put(session);
  transaction.objectStore(EVENT_STORE).put(event);
  await done;
  database.close();
}

export async function listTraceSessions(): Promise<TraceSession[]> {
  const database = await openDatabase();
  const transaction = database.transaction(SESSION_STORE, "readonly");
  const request = transaction.objectStore(SESSION_STORE).getAll() as IDBRequest<TraceSession[]>;
  const sessions = await new Promise<TraceSession[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return sessions.sort((left, right) => right.started_at.localeCompare(left.started_at));
}

export async function listTraceEvents(sessionId: string): Promise<TraceEvent[]> {
  const database = await openDatabase();
  const transaction = database.transaction(EVENT_STORE, "readonly");
  const index = transaction.objectStore(EVENT_STORE).index("session_id");
  const request = index.getAll(IDBKeyRange.only(sessionId)) as IDBRequest<TraceEvent[]>;
  const events = await new Promise<TraceEvent[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return events.sort((left, right) => left.sequence - right.sequence);
}

export async function deleteTraceSession(sessionId: string): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction([SESSION_STORE, EVENT_STORE], "readwrite");
  const done = waitForTransaction(transaction);
  const sessions = transaction.objectStore(SESSION_STORE);
  const events = transaction.objectStore(EVENT_STORE);
  sessions.delete(sessionId);

  const request = events.index("session_id").openKeyCursor(IDBKeyRange.only(sessionId));
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor) {
      events.delete(cursor.primaryKey);
      cursor.continue();
    }
  };

  await done;
  database.close();
}

export async function clearTraceSessions(): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction([SESSION_STORE, EVENT_STORE], "readwrite");
  const done = waitForTransaction(transaction);
  transaction.objectStore(SESSION_STORE).clear();
  transaction.objectStore(EVENT_STORE).clear();
  await done;
  database.close();
}

async function pruneOldSessions(): Promise<void> {
  const sessions = await listTraceSessions();
  for (const session of sessions.slice(MAX_SESSIONS)) {
    await deleteTraceSession(session.session_id);
  }
}
