import { isProbablyReaderable, Readability } from "@mozilla/readability";

let stopCurrentPlayback: (() => void) | null = null;
const SAMPLE_RATE = 44_100;
const START_BUFFER_FRAMES = SAMPLE_RATE / 10;
const articleText = getArticleText();

if (articleText && !document.getElementById("readflow-controls")) {
  const controls = createControls();
  document.documentElement.append(controls.host);

  controls.articleButton.addEventListener("click", () => {
    void startPlayback(controls, articleText, "Article");
  });

  controls.selectionButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
  });

  controls.selectionButton.addEventListener("click", () => {
    const selectedText = getSelectedText();

    if (selectedText) {
      void startPlayback(controls, selectedText, "Selected text");
      controls.selectionButton.hidden = true;
    }
  });

  document.addEventListener("selectionchange", () => {
    positionSelectionButton(controls.selectionButton);
  });
  document.addEventListener("mouseup", () => {
    positionSelectionButton(controls.selectionButton);
  });
  document.addEventListener("keyup", () => {
    positionSelectionButton(controls.selectionButton);
  });
  window.addEventListener(
    "scroll",
    () => positionSelectionButton(controls.selectionButton),
    true,
  );
}

function getArticleText(): string | null {
  if (!isProbablyReaderable(document)) {
    return null;
  }

  const article = new Readability(document.cloneNode(true) as Document).parse();
  const text = article?.textContent?.trim();

  return text || null;
}

function getSelectedText(): string | null {
  const text = window.getSelection()?.toString().trim();

  return text || null;
}

function createControls(): {
  host: HTMLDivElement;
  articleButton: HTMLButtonElement;
  selectionButton: HTMLButtonElement;
  pauseButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  status: HTMLDivElement;
} {
  const host = document.createElement("div");
  host.id = "readflow-controls";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        color: #f7f7f8;
        font: 500 14px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .readflow-layer {
        inset: 0;
        pointer-events: none;
        position: fixed;
        z-index: 2147483647;
      }

      button {
        background: #202124;
        border: 1px solid #45464a;
        border-radius: 999px;
        box-shadow: 0 4px 16px rgb(0 0 0 / 22%);
        color: inherit;
        cursor: pointer;
        font: inherit;
        min-height: 40px;
        padding: 0 16px;
        pointer-events: auto;
      }

      button:hover {
        background: #303136;
      }

      button:focus-visible {
        outline: 2px solid #9bbcff;
        outline-offset: 3px;
      }

      #article-button {
        bottom: 24px;
        position: fixed;
        right: 24px;
      }

      #selection-button {
        position: fixed;
        transform: translateX(-50%);
      }

      #status {
        background: #202124;
        border: 1px solid #45464a;
        border-radius: 10px;
        bottom: 122px;
        box-shadow: 0 4px 16px rgb(0 0 0 / 22%);
        color: #f7f7f8;
        max-width: min(320px, calc(100vw - 32px));
        padding: 10px 14px;
        pointer-events: auto;
        position: fixed;
        right: 24px;
      }

      #player-controls {
        bottom: 76px;
        display: flex;
        gap: 8px;
        position: fixed;
        right: 24px;
      }

      #player-controls button {
        min-height: 36px;
      }

      [hidden] {
        display: none !important;
      }
    </style>
    <div class="readflow-layer">
      <button id="article-button" type="button">Listen to article</button>
      <button id="selection-button" type="button" hidden>Listen</button>
      <div id="status" role="status" aria-live="polite" hidden></div>
      <div id="player-controls" hidden>
        <button id="pause-button" type="button">Pause</button>
        <button id="stop-button" type="button">Stop</button>
      </div>
    </div>
  `;

  return {
    host,
    articleButton: shadow.querySelector<HTMLButtonElement>("#article-button")!,
    selectionButton: shadow.querySelector<HTMLButtonElement>("#selection-button")!,
    pauseButton: shadow.querySelector<HTMLButtonElement>("#pause-button")!,
    stopButton: shadow.querySelector<HTMLButtonElement>("#stop-button")!,
    status: shadow.querySelector<HTMLDivElement>("#status")!,
  };
}

function positionSelectionButton(button: HTMLButtonElement): void {
  if (!getSelectedText()) {
    button.hidden = true;
    return;
  }

  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const rect = range?.getBoundingClientRect();

  if (!rect || (!rect.width && !rect.height)) {
    button.hidden = true;
    return;
  }

  const horizontalCenter = rect.left + rect.width / 2;
  const boundedCenter = Math.max(56, Math.min(window.innerWidth - 56, horizontalCenter));
  button.style.left = `${boundedCenter}px`;
  button.style.top = `${Math.max(8, rect.top - 48)}px`;
  button.hidden = false;
}

async function startPlayback(
  controls: ReturnType<typeof createControls>,
  text: string,
  source: string,
): Promise<void> {
  stopCurrentPlayback?.();
  controls.status.textContent = `Connecting for ${source.toLowerCase()} audio…`;
  controls.status.hidden = false;

  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: SAMPLE_RATE });
  } catch {
    controls.status.textContent = "This browser could not create a 44.1 kHz audio stream.";
    controls.status.hidden = false;
    return;
  }
  const port = chrome.runtime.connect({ name: "readflow-tts" });
  const sources = new Set<AudioBufferSourceNode>();
  const scheduledRanges: Array<{ start: number; end: number; firstFrame: number }> = [];
  const pendingSamples: Float32Array<ArrayBuffer>[] = [];
  let pendingFrameCount = 0;
  let pendingByte = new Uint8Array();
  let submittedFrames = 0;
  let nextStart = 0;
  let streamFinished = false;
  let stopped = false;
  let animationFrame = 0;

  const cleanup = (): void => {
    if (stopped) {
      return;
    }

    stopped = true;
    cancelAnimationFrame(animationFrame);
    port.disconnect();
    for (const audioSource of sources) {
      audioSource.stop();
    }
    void context.close();
  };

  stopCurrentPlayback = cleanup;
  controls.pauseButton.hidden = false;
  controls.stopButton.hidden = false;
  controls.pauseButton.textContent = "Pause";
  controls.pauseButton.onclick = () => {
    if (context.state === "running") {
      void context.suspend().then(() => {
        controls.pauseButton.textContent = "Resume";
      });
    } else {
      void context.resume().then(() => {
        controls.pauseButton.textContent = "Pause";
      });
    }
  };
  controls.stopButton.onclick = () => {
    cleanup();
    controls.status.textContent = "Stopped";
    controls.pauseButton.hidden = true;
    controls.stopButton.hidden = true;
    if (stopCurrentPlayback === cleanup) {
      stopCurrentPlayback = null;
    }
  };

  const reportError = (message: string): void => {
    cleanup();
    controls.status.textContent = message;
    controls.pauseButton.hidden = true;
    controls.stopButton.hidden = true;
    if (stopCurrentPlayback === cleanup) {
      stopCurrentPlayback = null;
    }
  };

  const finishIfReady = (): void => {
    if (streamFinished && sources.size === 0 && pendingFrameCount === 0 && !stopped) {
      controls.status.textContent = "Finished";
      controls.pauseButton.hidden = true;
      controls.stopButton.hidden = true;
      cancelAnimationFrame(animationFrame);
    }
  };

  const scheduleSamples = (samples: Float32Array<ArrayBuffer>): void => {
    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const audioSource = context.createBufferSource();
    audioSource.buffer = buffer;
    audioSource.connect(context.destination);

    const schedulingLead = nextStart === 0 ? 0.05 : 0.01;
    const start = Math.max(context.currentTime + schedulingLead, nextStart);
    const end = start + buffer.duration;
    scheduledRanges.push({ start, end, firstFrame: submittedFrames });
    submittedFrames += samples.length;
    nextStart = end;
    sources.add(audioSource);
    audioSource.onended = () => {
      sources.delete(audioSource);
      finishIfReady();
    };
    audioSource.start(start);
  };

  const flushSamples = (force: boolean): void => {
    if (!force && pendingFrameCount < START_BUFFER_FRAMES) {
      return;
    }

    for (const samples of pendingSamples) {
      scheduleSamples(samples);
    }
    pendingSamples.length = 0;
    pendingFrameCount = 0;
  };

  const queueAudio = (audioBase64: string): void => {
    const decoded = atob(audioBase64);
    const incoming = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const combined = new Uint8Array(pendingByte.length + incoming.length);
    combined.set(pendingByte);
    combined.set(incoming, pendingByte.length);
    const completeLength = combined.length - (combined.length % 2);
    pendingByte = combined.slice(completeLength);

    if (completeLength === 0) {
      return;
    }

    const view = new DataView(combined.buffer, combined.byteOffset, completeLength);
    const samples = new Float32Array(completeLength / 2);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = view.getInt16(index * 2, true) / 32768;
    }
    pendingSamples.push(samples);
    pendingFrameCount += samples.length;
    flushSamples(false);
  };

  const updatePlaybackTime = (): void => {
    if (stopped || streamFinished && sources.size === 0) {
      return;
    }

    if (scheduledRanges.length === 0) {
      animationFrame = requestAnimationFrame(updatePlaybackTime);
      return;
    }

    const outputContextTime = context.getOutputTimestamp().contextTime ?? context.currentTime;
    let frame = 0;
    for (const range of scheduledRanges) {
      if (outputContextTime < range.start) {
        break;
      }
      if (outputContextTime < range.end) {
        frame = range.firstFrame + (outputContextTime - range.start) * SAMPLE_RATE;
        break;
      }
      frame = range.firstFrame + (range.end - range.start) * SAMPLE_RATE;
    }
    const seconds = Math.max(0, frame / SAMPLE_RATE);
    const state = context.state === "suspended" ? "Paused" : "Playing";
    controls.status.textContent = `${state} · ${formatTime(seconds)}`;
    animationFrame = requestAnimationFrame(updatePlaybackTime);
  };

  port.onMessage.addListener((message: { event?: string; audio_base64?: string; message?: string }) => {
    if (message.event === "audio" && message.audio_base64) {
      try {
        queueAudio(message.audio_base64);
      } catch {
        reportError("Readflow received invalid audio data.");
      }
    } else if (message.event === "finish") {
      if (pendingByte.length) {
        reportError("Fish Audio ended with an incomplete PCM sample.");
        return;
      }
      streamFinished = true;
      flushSamples(true);
      if (submittedFrames === 0) {
        reportError("Fish Audio returned no audio.");
        return;
      }
      finishIfReady();
    } else if (message.event === "error") {
      reportError(message.message || "Audio could not be generated.");
    }
  });

  try {
    await context.resume();
    port.postMessage({ text });
    controls.status.textContent = "Waiting for 100 ms of audio…";
    animationFrame = requestAnimationFrame(updatePlaybackTime);
  } catch {
    reportError("Audio playback could not start. Try again.");
  }
}

function formatTime(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}
