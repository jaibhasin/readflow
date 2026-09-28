type StreamEvent = {
  event: "audio" | "finish" | "error";
  [key: string]: unknown;
};

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "readflow-tts") {
    return;
  }

  const controller = new AbortController();
  let disconnected = false;

  port.onDisconnect.addListener(() => {
    disconnected = true;
    controller.abort();
  });

  port.onMessage.addListener((message: { text?: string; referenceId?: string }) => {
    if (!message.text) {
      return;
    }

    void streamSpeech(port, message.text, message.referenceId, controller.signal, () => disconnected);
  });
});

async function streamSpeech(
  port: chrome.runtime.Port,
  text: string,
  referenceId: string | undefined,
  signal: AbortSignal,
  isDisconnected: () => boolean,
): Promise<void> {
  try {
    const response = await fetch("http://127.0.0.1:4179/v1/tts/stream/with-timestamp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, reference_id: referenceId }),
      signal,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null) as { detail?: string } | null;
      throw new Error(body?.detail || `The local Readflow bridge returned ${response.status}.`);
    }

    if (!response.body) {
      throw new Error("The local Readflow bridge did not start an audio stream.");
    }

    await forwardEvents(response.body, port, isDisconnected);
  } catch (error) {
    if (!signal.aborted && !isDisconnected()) {
      const message = error instanceof Error ? error.message : "Audio could not be started.";
      port.postMessage({ event: "error", message });
    }
  }
}

async function forwardEvents(
  body: ReadableStream<Uint8Array>,
  port: chrome.runtime.Port,
  isDisconnected: () => boolean,
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

      for (const record of records) {
        const data = record
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");

        if (data && !isDisconnected()) {
          const event = JSON.parse(data) as StreamEvent;
          port.postMessage(event);
          if (event.event === "finish" || event.event === "error") {
            return;
          }
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
