import { isProbablyReaderable, Readability } from "@mozilla/readability";

let stopCurrentPlayback: (() => void) | null = null;
const SAMPLE_RATE = 44_100;
const START_BUFFER_FRAMES = SAMPLE_RATE / 10;
const articleText = getArticleText();
let pageWordHighlighter: PageWordHighlighter | null = null;

type WordTiming = {
  text: string;
  start: number;
  end: number;
};

type ChunkAlignment = {
  offset: number;
  segments: WordTiming[];
};

type TextSpan = {
  node: Text;
  start: number;
  offsets: number[];
};

type PageTextIndex = {
  text: string;
  spans: TextSpan[];
};

type PageWordHighlighter = {
  set(range: Range | null): void;
  clear(): void;
};

if (articleText && !document.getElementById("readflow-controls")) {
  const controls = createControls();
  document.documentElement.append(controls.host);

  controls.articleButton.addEventListener("click", () => {
    void startPlayback(controls, articleText, "Article");
  });

  controls.debugButton.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "open_diagnostics" });
  });

  controls.selectionButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
  });

  controls.selectionButton.addEventListener("click", () => {
    const selectedText = getSelectedText();
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;

    if (selectedText) {
      void startPlayback(controls, selectedText, "Selected text", range);
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

function createPageTextIndex(): PageTextIndex {
  const text = document.body;
  const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = node.parentElement;
      return parent?.closest("script, style, noscript, template, [hidden], [aria-hidden='true'], #readflow-controls")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  let normalized = "";
  const spans: TextSpan[] = [];

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    let spanStart = -1;
    const offsets: number[] = [];
    for (let offset = 0; offset < node.data.length; offset += 1) {
      const character = node.data[offset];
      if (/\s/.test(character)) {
        if (normalized && !normalized.endsWith(" ")) {
          spanStart = spanStart < 0 ? normalized.length : spanStart;
          normalized += " ";
          offsets.push(offset);
        }
      } else {
        spanStart = spanStart < 0 ? normalized.length : spanStart;
        normalized += foldCharacter(character);
        offsets.push(offset);
      }
    }
    if (offsets.length) {
      spans.push({ node, start: spanStart, offsets });
    }
  }

  return { text: normalized, spans };
}

function normalizeForSearch(text: string): string {
  return text.replace(/\s+/g, " ").trim().split("").map(foldCharacter).join("");
}

function foldCharacter(character: string): string {
  const folded = character.toLowerCase();
  return folded.length === 1 ? folded : character;
}

function findTextPosition(index: PageTextIndex, text: string, startAt: number): number {
  const needle = normalizeForSearch(text);
  return needle ? index.text.indexOf(needle, startAt) : -1;
}

function findSourceStart(index: PageTextIndex, text: string, range?: Range): number {
  if (range?.startContainer.nodeType === Node.TEXT_NODE) {
    const node = range.startContainer as Text;
    const span = index.spans.find((candidate) => candidate.node === node);
    const localIndex = span?.offsets.findIndex((offset) => offset >= range.startOffset) ?? -1;
    if (span && localIndex >= 0) {
      return span.start + localIndex;
    }
  }

  const normalizedSource = normalizeForSearch(text);
  const prefix = normalizedSource.slice(0, 80);
  for (let length = prefix.length; length > 0; length -= 8) {
    const found = index.text.indexOf(prefix.slice(0, length));
    if (found >= 0) {
      return found;
    }
  }
  return -1;
}

function getTextPoint(index: PageTextIndex, position: number): { node: Text; offset: number } | null {
  let low = 0;
  let high = index.spans.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const span = index.spans[middle];
    const end = span.start + span.offsets.length;
    if (position < span.start) {
      high = middle - 1;
    } else if (position >= end) {
      low = middle + 1;
    } else {
      return { node: span.node, offset: span.offsets[position - span.start] };
    }
  }
  return null;
}

function createPageWordHighlighter(): PageWordHighlighter | null {
  if (pageWordHighlighter) {
    return pageWordHighlighter;
  }

  type HighlightValue = Set<Range> & { priority: number };
  type HighlightRegistry = { set(name: string, value: HighlightValue): void };
  const registry = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  const HighlightConstructor = (window as unknown as {
    Highlight?: new (...ranges: Range[]) => HighlightValue;
  }).Highlight;
  if (!registry || !HighlightConstructor) {
    return null;
  }

  const name = "readflow-current-word";
  const highlight = new HighlightConstructor();
  registry.set(name, highlight);
  pageWordHighlighter = {
    set(range) {
      highlight.clear();
      if (range) {
        highlight.add(range);
      }
    },
    clear() {
      highlight.clear();
    },
  };
  return pageWordHighlighter;
}

function createControls(): {
  host: HTMLDivElement;
  articleButton: HTMLButtonElement;
  debugButton: HTMLButtonElement;
  selectionButton: HTMLButtonElement;
  playerControls: HTMLDivElement;
  rewindButton: HTMLButtonElement;
  pauseButton: HTMLButtonElement;
  forwardButton: HTMLButtonElement;
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

      button:disabled {
        cursor: default;
        opacity: 0.5;
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

      #debug-button {
        bottom: 24px;
        position: fixed;
        right: 184px;
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
        padding: 0 12px;
      }

      [hidden] {
        display: none !important;
      }
    </style>
    <div class="readflow-layer">
      <button id="article-button" type="button">Listen to article</button>
      <button id="debug-button" type="button" title="Open Readflow diagnostics">Debug</button>
      <button id="selection-button" type="button" hidden>Listen</button>
      <div id="status" role="status" aria-live="polite" hidden></div>
      <div id="player-controls" hidden>
        <button id="rewind-button" type="button" aria-label="Back 15 seconds" title="Back 15 seconds">−15</button>
        <button id="pause-button" type="button">Pause</button>
        <button id="forward-button" type="button" aria-label="Forward 15 seconds" title="Forward 15 seconds">+15</button>
        <button id="stop-button" type="button">Stop</button>
      </div>
    </div>
  `;

  return {
    host,
    articleButton: shadow.querySelector<HTMLButtonElement>("#article-button")!,
    debugButton: shadow.querySelector<HTMLButtonElement>("#debug-button")!,
    selectionButton: shadow.querySelector<HTMLButtonElement>("#selection-button")!,
    playerControls: shadow.querySelector<HTMLDivElement>("#player-controls")!,
    rewindButton: shadow.querySelector<HTMLButtonElement>("#rewind-button")!,
    pauseButton: shadow.querySelector<HTMLButtonElement>("#pause-button")!,
    forwardButton: shadow.querySelector<HTMLButtonElement>("#forward-button")!,
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
  selectionRange?: Range,
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
  let pageTextIndex: PageTextIndex | null = null;
  let sourceStart = -1;
  const highlighter = createPageWordHighlighter();
  const alignmentsByChunk = new Map<number, ChunkAlignment>();
  let locatedWords: Array<{ key: string; start: number; end: number; range: Range }> = [];
  let currentWordKey = "";
  let alignmentNeedsMapping = false;
  let didReportHighlightMapping = false;
  let didReportHighlightMismatch = false;
  const sources = new Set<AudioBufferSourceNode>();
  const scheduledRanges: Array<{ start: number; end: number; firstFrame: number }> = [];
  const audioTimeline: Array<{ buffer: AudioBuffer; firstFrame: number }> = [];
  const pendingSamples: Float32Array<ArrayBuffer>[] = [];
  let pendingFrameCount = 0;
  let pendingByte = new Uint8Array();
  let receivedFrames = 0;
  let seekStartFrame = 0;
  let nextStart = 0;
  let streamFinished = false;
  let playbackComplete = false;
  let stopped = false;
  let animationFrame = 0;
  let playbackStarted = false;
  const sessionId = crypto.randomUUID();
  const sessionStarted = performance.now();

  const recordClientEvent = (kind: string, playbackMs?: number, value?: unknown): void => {
    port.postMessage({
      type: "client_event",
      kind,
      clientElapsedMs: performance.now() - sessionStarted,
      playbackMs,
      value,
    });
  };
  recordClientEvent("listen_started");
  if (!highlighter) {
    recordClientEvent("highlight_api_unavailable");
  }

  const cleanup = (recordStop = true): void => {
    if (stopped) {
      return;
    }

    stopped = true;
    cancelAnimationFrame(animationFrame);
    highlighter?.clear();
    if (recordStop && !playbackComplete) {
      recordClientEvent("stopped", getAudibleFrame() / SAMPLE_RATE * 1000);
    }
    port.disconnect();
    for (const audioSource of sources) {
      audioSource.stop();
    }
    void context.close();
  };

  stopCurrentPlayback = cleanup;
  controls.playerControls.hidden = false;
  controls.rewindButton.disabled = true;
  controls.forwardButton.disabled = true;
  controls.pauseButton.textContent = "Pause";
  controls.pauseButton.onclick = () => {
    if (playbackComplete) {
      playbackComplete = false;
      controls.pauseButton.textContent = "Pause";
      seekTo(0);
      return;
    }

    if (context.state === "running") {
      void context.suspend().then(() => {
        controls.pauseButton.textContent = "Play";
        recordClientEvent("paused", getAudibleFrame() / SAMPLE_RATE * 1000);
      });
    } else {
      void context.resume().then(() => {
        controls.pauseButton.textContent = "Pause";
        recordClientEvent("resumed", getAudibleFrame() / SAMPLE_RATE * 1000);
      });
    }
  };
  controls.rewindButton.onclick = () => seekBy(-15);
  controls.forwardButton.onclick = () => seekBy(15);
  controls.stopButton.onclick = () => {
    cleanup();
    controls.status.textContent = "Stopped";
    controls.playerControls.hidden = true;
    if (stopCurrentPlayback === cleanup) {
      stopCurrentPlayback = null;
    }
  };

  const reportError = (message: string): void => {
    recordClientEvent("playback_error", getAudibleFrame() / SAMPLE_RATE * 1000, message);
    cleanup(false);
    controls.status.textContent = message;
    controls.playerControls.hidden = true;
    if (stopCurrentPlayback === cleanup) {
      stopCurrentPlayback = null;
    }
  };

  const finishIfReady = (): void => {
    if (streamFinished && sources.size === 0 && pendingFrameCount === 0 && !stopped) {
      playbackComplete = true;
      highlighter?.clear();
      currentWordKey = "";
      recordClientEvent("playback_finished", getAudibleFrame() / SAMPLE_RATE * 1000);
      controls.status.textContent = "Finished";
      controls.pauseButton.textContent = "Play";
      cancelAnimationFrame(animationFrame);
    }
  };

  const scheduleBuffer = (
    timelineEntry: { buffer: AudioBuffer; firstFrame: number },
    offsetFrames: number,
  ): void => {
    const frameCount = timelineEntry.buffer.length - offsetFrames;
    if (frameCount <= 0) {
      return;
    }

    const audioSource = context.createBufferSource();
    audioSource.buffer = timelineEntry.buffer;
    audioSource.connect(context.destination);

    const schedulingLead = nextStart === 0 ? 0.05 : 0.01;
    const start = Math.max(context.currentTime + schedulingLead, nextStart);
    const end = start + frameCount / SAMPLE_RATE;
    scheduledRanges.push({
      start,
      end,
      firstFrame: timelineEntry.firstFrame + offsetFrames,
    });
    nextStart = end;
    sources.add(audioSource);
    audioSource.onended = () => {
      sources.delete(audioSource);
      finishIfReady();
    };
    audioSource.start(start, offsetFrames / SAMPLE_RATE);
  };

  const scheduleSamples = (samples: Float32Array<ArrayBuffer>): void => {
    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const timelineEntry = { buffer, firstFrame: receivedFrames };
    audioTimeline.push(timelineEntry);
    receivedFrames += samples.length;
    scheduleBuffer(timelineEntry, 0);
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

  const getAudibleFrame = (): number => {
    const outputContextTime = context.getOutputTimestamp().contextTime ?? context.currentTime;
    let frame = scheduledRanges[0]?.firstFrame ?? seekStartFrame;
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
    return Math.min(receivedFrames, Math.max(0, frame));
  };

  const seekTo = (requestedFrame: number): void => {
    const targetFrame = Math.floor(Math.min(receivedFrames, Math.max(0, requestedFrame)));
    recordClientEvent("seek", targetFrame / SAMPLE_RATE * 1000);
    for (const audioSource of sources) {
      audioSource.onended = null;
      audioSource.stop();
    }
    sources.clear();
    scheduledRanges.length = 0;
    seekStartFrame = targetFrame;
    nextStart = 0;
    playbackComplete = false;
    controls.pauseButton.textContent = context.state === "running" ? "Pause" : "Play";

    for (const timelineEntry of audioTimeline) {
      const offsetFrames = Math.max(0, targetFrame - timelineEntry.firstFrame);
      scheduleBuffer(timelineEntry, offsetFrames);
    }

    controls.rewindButton.disabled = receivedFrames === 0 || targetFrame === 0;
    controls.forwardButton.disabled = receivedFrames === 0 || targetFrame === receivedFrames;
    cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(updatePlaybackTime);
    if (streamFinished && sources.size === 0) {
      finishIfReady();
    }
  };

  const seekBy = (seconds: number): void => {
    seekTo(getAudibleFrame() + seconds * SAMPLE_RATE);
  };

  const rebuildWordRanges = (): void => {
    if (!pageTextIndex || sourceStart < 0) {
      return;
    }

    const segments = Array.from(alignmentsByChunk.entries()).flatMap(([chunkSequence, snapshot]) =>
      snapshot.segments.map((segment, index) => ({
        key: `${chunkSequence}:${index}`,
        text: segment.text,
        start: snapshot.offset + segment.start,
        end: snapshot.offset + segment.end,
      })),
    ).sort((left, right) => left.start - right.start);
    let cursor = sourceStart;
    const words: typeof locatedWords = [];

    for (const segment of segments) {
      const matchAt = findTextPosition(pageTextIndex, segment.text, cursor);
      const matchedText = normalizeForSearch(segment.text);
      if (matchAt < 0 || !matchedText || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)) {
        continue;
      }
      if (matchAt - cursor > 80) {
        if (!didReportHighlightMismatch) {
          recordClientEvent("highlight_text_mismatch", segment.start * 1000, {
            skipped_page_chars: matchAt - cursor,
          });
          didReportHighlightMismatch = true;
        }
        break;
      }

      const first = getTextPoint(pageTextIndex, matchAt);
      const last = getTextPoint(pageTextIndex, matchAt + matchedText.length - 1);
      if (!first || !last) {
        continue;
      }

      const range = document.createRange();
      range.setStart(first.node, first.offset);
      range.setEnd(last.node, last.offset + 1);
      if (selectionRange && range.compareBoundaryPoints(Range.END_TO_END, selectionRange) > 0) {
        break;
      }
      words.push({ key: segment.key, start: segment.start, end: segment.end, range });
      cursor = matchAt + matchedText.length;
    }
    locatedWords = words;
    if (!didReportHighlightMapping) {
      recordClientEvent("highlight_mapping", undefined, {
        mapped_words: words.length,
        alignment_words: segments.length,
      });
      didReportHighlightMapping = true;
    }
  };

  const updateWordHighlight = (playbackSeconds: number): void => {
    const word = locatedWords.find((candidate) =>
      candidate.start <= playbackSeconds && playbackSeconds < candidate.end,
    );

    if (!word || !highlighter) {
      highlighter?.clear();
      currentWordKey = "";
      return;
    }
    if (word.key === currentWordKey) {
      return;
    }

    highlighter?.set(word.range);
    currentWordKey = word.key;
  };

  const updatePlaybackTime = (): void => {
    if (stopped || streamFinished && sources.size === 0) {
      return;
    }

    if (scheduledRanges.length === 0) {
      animationFrame = requestAnimationFrame(updatePlaybackTime);
      return;
    }

    if (alignmentNeedsMapping && pageTextIndex) {
      rebuildWordRanges();
      alignmentNeedsMapping = false;
    }

    const frame = getAudibleFrame();
    const outputContextTime = context.getOutputTimestamp().contextTime ?? context.currentTime;
    const hasAudibleAudio = scheduledRanges.some((range) => outputContextTime >= range.start);
    if (!playbackStarted && hasAudibleAudio && context.state === "running") {
      playbackStarted = true;
      recordClientEvent("playback_started", frame / SAMPLE_RATE * 1000);
    }
    updateWordHighlight(frame / SAMPLE_RATE);
    controls.rewindButton.disabled = frame <= 0;
    controls.forwardButton.disabled = frame >= receivedFrames;
    const seconds = Math.max(0, frame / SAMPLE_RATE);
    const state = context.state === "suspended" ? "Paused" : "Playing";
    controls.status.textContent = `${state} · ${formatTime(seconds)}`;
    animationFrame = requestAnimationFrame(updatePlaybackTime);
  };

  port.onMessage.addListener((message: {
    event?: string;
    audio_base64?: string;
    message?: string;
    chunk_seq?: number;
    chunk_audio_offset_sec?: number;
    alignment?: { segments?: WordTiming[] } | null;
  }) => {
    if (stopped) {
      return;
    }

    if (message.event === "audio" && message.audio_base64) {
      try {
        queueAudio(message.audio_base64);
        if (typeof message.chunk_seq === "number" && message.alignment?.segments?.length) {
          alignmentsByChunk.set(message.chunk_seq, {
            offset: typeof message.chunk_audio_offset_sec === "number" ? message.chunk_audio_offset_sec : 0,
            segments: message.alignment.segments,
          });
          alignmentNeedsMapping = true;
        }
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
      if (receivedFrames === 0) {
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
    port.postMessage({
      type: "start",
      sessionId,
      source: source === "Article" ? "article" : "selection",
      text,
      textCharCount: text.length,
      wordCount: text.trim().split(/\s+/).length,
      startedAt: new Date().toISOString(),
    });
    const prepareTextIndex = (): void => {
      pageTextIndex = createPageTextIndex();
      sourceStart = findSourceStart(pageTextIndex, text, selectionRange);
      if (sourceStart < 0) {
        recordClientEvent("highlight_source_not_found");
      }
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
    };
    if (idleWindow.requestIdleCallback) {
      idleWindow.requestIdleCallback(prepareTextIndex, { timeout: 500 });
    } else {
      window.setTimeout(prepareTextIndex, 0);
    }
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
