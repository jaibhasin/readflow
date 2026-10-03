import { isProbablyReaderable, Readability } from "@mozilla/readability";
import { bufferFramesForSpeed, isAudioAudible, nextPlaybackRate, playbackDuration, playedFrames } from "./playback-speed";
import { StreamingTimeStretch } from "./time-stretch";
import { resolveSeekTarget } from "./seek-target";
import { prepareSpokenText } from "./spoken-text";
import { splitTextSections } from "./text-sections";
import { shortTapeTitle } from "./tape-label";
import { foldCharacter, locateWordOffsets, normalizeForSearch, sentenceSpans } from "./text-map";

let stopCurrentPlayback: (() => void) | null = null;
let setCurrentPlaybackSpeed: ((rate: number) => void) | null = null;
let selectedPlaybackRate = 1;
const SAMPLE_RATE = 44_100;
const START_BUFFER_SECONDS = 3;
const articleText = getArticleText();
let pageSentenceHighlighter: PageSentenceHighlighter | null = null;

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
  sentences: Array<{ start: number; end: number }>;
};

type PageSentenceHighlighter = {
  set(range: Range | null): void;
  clear(): void;
};

type TransportState = "idle" | "connecting" | "buffering" | "playing" | "paused" | "finished" | "stopped" | "error";

if (articleText && !document.getElementById("readflow-controls")) {
  const controls = createControls();
  document.documentElement.append(controls.host);

  controls.articleButton.addEventListener("click", () => {
    void startPlayback(controls, articleText, "Article");
  });

  controls.debugButton.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "open_diagnostics" });
  });

  controls.speedButton.addEventListener("click", () => {
    selectedPlaybackRate = nextPlaybackRate(selectedPlaybackRate);
    controls.speedButton.textContent = `${selectedPlaybackRate}×`;
    controls.speedButton.title = `Playback speed: ${selectedPlaybackRate} times`;
    controls.speedButton.setAttribute("aria-label", `Playback speed ${selectedPlaybackRate} times. Change speed`);
    setCurrentPlaybackSpeed?.(selectedPlaybackRate);
  });

  controls.minimizeButton.addEventListener("click", () => setCompactMode(controls, true));
  controls.expandButton.addEventListener("click", () => setCompactMode(controls, false));
  controls.miniActionButton.addEventListener("click", () => {
    if (controls.playerControls.hidden) {
      controls.articleButton.click();
    } else {
      controls.pauseButton.click();
    }
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
  const blockStarts = [0];
  let currentBlock: Element | null = null;

  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const block = node.parentElement?.closest("p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, th, dt, dd, pre, div, section, article, main") ?? null;
    if (block !== currentBlock) {
      if (normalized) {
        if (!normalized.endsWith(" ")) {
          normalized += " ";
        }
        blockStarts.push(normalized.length);
      }
      currentBlock = block;
    }
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

  return { text: normalized, spans, sentences: sentenceSpans(normalized, blockStarts) };
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

function createPageSentenceHighlighter(): PageSentenceHighlighter | null {
  if (pageSentenceHighlighter) {
    return pageSentenceHighlighter;
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

  const name = "readflow-current-sentence";
  const highlight = new HighlightConstructor();
  registry.set(name, highlight);
  pageSentenceHighlighter = {
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
  return pageSentenceHighlighter;
}

function createControls(): {
  host: HTMLDivElement;
  dock: HTMLDivElement;
  fullPlayer: HTMLDivElement;
  miniPlayer: HTMLDivElement;
  articleButton: HTMLButtonElement;
  debugButton: HTMLButtonElement;
  speedButton: HTMLButtonElement;
  minimizeButton: HTMLButtonElement;
  expandButton: HTMLButtonElement;
  miniActionButton: HTMLButtonElement;
  selectionButton: HTMLButtonElement;
  playerControls: HTMLDivElement;
  rewindButton: HTMLButtonElement;
  pauseButton: HTMLButtonElement;
  forwardButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
  status: HTMLDivElement;
  miniStatus: HTMLSpanElement;
  tapeTitle: HTMLElement;
} {
  const host = document.createElement("div");
  host.id = "readflow-controls";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        color: #edf0ed;
        font: 600 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .readflow-layer {
        inset: 0;
        pointer-events: none;
        position: fixed;
        z-index: 2147483647;
      }

      button {
        appearance: none;
        background: linear-gradient(180deg, #485055, #30383d);
        border: 1px solid #626c70;
        border-bottom-color: #1c2225;
        border-radius: 9px;
        box-shadow: inset 0 1px rgb(255 255 255 / 12%), 0 2px 3px rgb(0 0 0 / 28%);
        color: inherit;
        cursor: pointer;
        font: inherit;
        min-height: 38px;
        padding: 0 12px;
        pointer-events: auto;
        transition: background 150ms ease, transform 150ms ease;
      }

      button:hover {
        background: linear-gradient(180deg, #596267, #3b454a);
      }

      button:active:not(:disabled) {
        transform: translateY(1px);
      }

      button:disabled {
        cursor: default;
        opacity: 0.5;
      }

      button:focus-visible {
        outline: 2px solid #d4e888;
        outline-offset: 3px;
      }

      #dock {
        background: linear-gradient(145deg, #4b5558, #283135 25%, #1c2428 72%);
        border: 1px solid #667175;
        border-bottom-color: #111719;
        border-radius: 18px;
        bottom: max(16px, env(safe-area-inset-bottom));
        box-shadow: 0 18px 44px rgb(0 0 0 / 32%), inset 0 1px rgb(255 255 255 / 16%);
        box-sizing: border-box;
        padding: 13px;
        pointer-events: auto;
        position: fixed;
        right: 16px;
        width: min(300px, calc(100vw - 32px));
      }

      #dock[data-compact="true"] {
        border-radius: 13px;
        padding: 8px;
        width: min(236px, calc(100vw - 32px));
      }

      #dock-header {
        align-items: center;
        display: flex;
        justify-content: space-between;
        margin: 0 2px 10px;
      }

      #header-actions {
        align-items: center;
        display: flex;
        gap: 7px;
      }

      #brand {
        color: #e9eeeb;
        font: 800 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        letter-spacing: 0.19em;
      }

      #brand::before {
        background: #d6e986;
        border-radius: 50%;
        box-shadow: 0 0 9px rgb(214 233 134 / 45%);
        content: "";
        display: inline-block;
        height: 7px;
        margin-right: 9px;
        vertical-align: 1px;
        width: 7px;
      }

      #dock[data-transport="playing"] #brand::before {
        animation: power-glow 1.8s ease-in-out infinite;
      }

      #debug-button {
        background: transparent;
        border: 0;
        box-shadow: none;
        color: #b9c4c3;
        font-size: 11px;
        min-height: 24px;
        padding: 0 2px;
      }

      #debug-button:hover {
        background: transparent;
        color: #eff5ef;
      }

      #minimize-button {
        background: transparent;
        border: 1px solid #667471;
        border-radius: 6px;
        box-shadow: none;
        color: #d6dfd6;
        font: 700 17px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        min-height: 26px;
        min-width: 26px;
        padding: 0;
      }

      #minimize-button:hover {
        background: #354144;
      }

      #speed-button {
        background: #20292c;
        border: 1px solid #667471;
        border-radius: 6px;
        color: #dce9ac;
        font: 700 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        min-height: 26px;
        min-width: 43px;
        padding: 0 6px;
      }

      #speed-button:hover {
        background: #354144;
      }

      #cassette-window {
        align-items: center;
        background: linear-gradient(180deg, #12191c, #252e30);
        border: 1px solid #0c1315;
        border-radius: 9px;
        box-shadow: inset 0 5px 13px rgb(0 0 0 / 65%), 0 1px rgb(255 255 255 / 9%);
        display: flex;
        height: 58px;
        justify-content: space-between;
        margin-bottom: 10px;
        overflow: hidden;
        padding: 0 15px;
        position: relative;
      }

      #cassette-window::before {
        background: #736a4a;
        content: "";
        height: 2px;
        left: 52px;
        opacity: 0.65;
        position: absolute;
        right: 52px;
        top: 28px;
      }

      #cassette-window::after {
        background: linear-gradient(110deg, transparent 18%, rgb(255 255 255 / 7%) 48%, transparent 64%);
        content: "";
        inset: 0;
        pointer-events: none;
        position: absolute;
      }

      .reel {
        background: #222a2a;
        border: 5px solid #89928d;
        border-radius: 50%;
        box-shadow: 0 0 0 2px #111719, inset 0 0 0 3px #111719;
        box-sizing: border-box;
        height: 44px;
        position: relative;
        width: 44px;
      }

      .reel::before {
        animation: reel-turn 4s linear infinite;
        animation-play-state: paused;
        background: repeating-conic-gradient(#bec8bc 0deg 14deg, #36423f 14deg 60deg);
        border-radius: 50%;
        content: "";
        inset: 6px;
        position: absolute;
      }

      #dock[data-transport="playing"] .reel::before {
        animation-play-state: running;
      }

      .reel::after {
        background: #1c2627;
        border: 2px solid #a4afa6;
        border-radius: 50%;
        content: "";
        height: 7px;
        left: 50%;
        position: absolute;
        top: 50%;
        transform: translate(-50%, -50%);
        width: 7px;
      }

      #tape-label {
        color: #dfe9da;
        display: flex;
        flex-direction: column;
        font: 700 9px/1.25 ui-monospace, SFMono-Regular, Menlo, monospace;
        gap: 2px;
        max-width: 132px;
        position: relative;
        text-align: center;
        text-shadow: 0 1px #101515;
      }

      #tape-side {
        color: #a5b17d;
        font-size: 7px;
        letter-spacing: 0.22em;
      }

      #tape-title,
      #tape-site {
        display: block;
        max-width: 132px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #tape-title {
        color: #e9eee5;
        font-size: 10px;
        letter-spacing: 0.01em;
      }

      #tape-site {
        color: #a0aaa3;
        font-size: 8px;
        letter-spacing: 0.03em;
      }

      #selection-button {
        background: linear-gradient(180deg, #434d4f, #20292c);
        border: 1px solid #77827f;
        border-radius: 10px;
        box-shadow: inset 0 1px rgb(255 255 255 / 18%), 0 8px 24px rgb(0 0 0 / 30%);
        color: #f3f5ef;
        position: fixed;
        transform: translateX(-50%);
        white-space: nowrap;
      }

      #selection-button::before,
      #article-button::before {
        content: "▶";
        font-size: 11px;
        margin-right: 9px;
      }

      #selection-button::before {
        color: #dce9ac;
      }

      #status {
        background: linear-gradient(180deg, #c6d4af, #aebf99);
        border: 1px solid #111a14;
        border-radius: 7px;
        box-shadow: inset 0 2px 5px rgb(32 45 30 / 23%);
        color: #253627;
        font: 700 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
        min-height: 17px;
        overflow: hidden;
        padding: 10px 11px;
        position: relative;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #status::after {
        background: repeating-linear-gradient(180deg, transparent 0 3px, rgb(33 49 33 / 9%) 3px 4px);
        content: "";
        inset: 0;
        pointer-events: none;
        position: absolute;
      }

      #dock[data-transport="error"] #status {
        background: #dfb7ad;
        color: #4c2722;
      }

      #player-controls {
        display: grid;
        gap: 6px;
        grid-template-columns: 1fr 1.25fr 1fr 1fr;
        margin-top: 10px;
      }

      #player-controls button {
        min-width: 0;
        padding: 0 4px;
      }

      #stop-button::before {
        background: #d98879;
        border-radius: 2px;
        content: "";
        display: inline-block;
        height: 8px;
        margin-right: 5px;
        width: 8px;
      }

      #pause-button {
        background: linear-gradient(180deg, #dce9ac, #abbf78);
        border-color: #d8e6a5;
        border-bottom-color: #6a7e46;
        color: #263324;
      }

      #pause-button:hover {
        background: linear-gradient(180deg, #eaf5bf, #bed38b);
      }

      #article-button {
        background: linear-gradient(180deg, #dce9ac, #afc37e);
        border-color: #e0edb1;
        border-bottom-color: #6a7e46;
        color: #243323;
        font-weight: 750;
        margin-top: 10px;
        width: 100%;
      }

      #article-button:hover {
        background: linear-gradient(180deg, #eaf5bf, #c3d690);
      }

      #mini-player {
        align-items: center;
        display: flex;
        gap: 7px;
      }

      #mini-mark {
        align-items: center;
        background: #172022;
        border: 2px solid #93a093;
        border-radius: 50%;
        box-shadow: inset 0 0 0 2px #11191b;
        color: #dce9ac;
        display: flex;
        flex: 0 0 26px;
        font: 800 9px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
        height: 26px;
        justify-content: center;
      }

      #dock[data-transport="playing"] #mini-mark {
        box-shadow: inset 0 0 0 2px #11191b, 0 0 9px rgb(214 233 134 / 40%);
      }

      #mini-status {
        color: #d5e4c1;
        flex: 1;
        font: 700 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      #mini-action-button,
      #expand-button {
        min-height: 34px;
        padding: 0;
      }

      #mini-action-button {
        background: linear-gradient(180deg, #dce9ac, #afc37e);
        border-color: #e0edb1;
        border-bottom-color: #6a7e46;
        color: #243323;
        flex: 0 0 34px;
        font-size: 16px;
      }

      #expand-button {
        flex: 0 0 26px;
        font-size: 18px;
      }

      @keyframes reel-turn {
        to { transform: rotate(360deg); }
      }

      @keyframes power-glow {
        50% { box-shadow: 0 0 15px rgb(214 233 134 / 80%); }
      }

      @media (max-width: 540px) {
        #dock {
          right: 50%;
          transform: translateX(50%);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        button { transition: none; }
        .reel::before,
        #dock[data-transport="playing"] #brand::before { animation: none; }
      }

      [hidden] {
        display: none !important;
      }
    </style>
    <div class="readflow-layer">
      <button id="selection-button" type="button" hidden>Listen to selection</button>
      <div id="dock" role="group" aria-label="Readflow player" data-transport="idle" data-compact="false">
        <div id="full-player">
        <div id="dock-header">
          <span id="brand">READFLOW</span>
          <div id="header-actions">
            <button id="speed-button" type="button" title="Playback speed: 1 time" aria-label="Playback speed 1 time. Change speed">1×</button>
            <button id="debug-button" type="button" title="Open Readflow diagnostics">Debug</button>
            <button id="minimize-button" type="button" title="Minimize player" aria-label="Minimize Readflow player">−</button>
          </div>
        </div>
        <div id="cassette-window" aria-hidden="true">
          <span class="reel"></span>
          <span id="tape-label">
            <span id="tape-side">SIDE A · RF-01</span>
            <span id="tape-title"></span>
            <span id="tape-site"></span>
          </span>
          <span class="reel"></span>
        </div>
        <div id="status" role="status" aria-live="polite">Ready to listen</div>
        <div id="player-controls" hidden>
          <button id="rewind-button" type="button" aria-label="Back 15 seconds" title="Back 15 seconds">−15</button>
          <button id="pause-button" type="button">Pause</button>
          <button id="forward-button" type="button" aria-label="Forward 15 seconds" title="Forward 15 seconds">+15</button>
          <button id="stop-button" type="button">Stop</button>
        </div>
        <button id="article-button" type="button">Listen to article</button>
        </div>
        <div id="mini-player" hidden>
          <span id="mini-mark" aria-hidden="true">RF</span>
          <span id="mini-status" role="status" aria-live="polite">Ready to listen</span>
          <button id="mini-action-button" type="button" aria-label="Listen to article" title="Listen to article">▶</button>
          <button id="expand-button" type="button" aria-label="Expand Readflow player" title="Expand player">⌃</button>
        </div>
      </div>
    </div>
  `;

  shadow.querySelector<HTMLElement>("#tape-site")!.textContent = window.location.hostname.replace(/^www\./, "") || "LOCAL PAGE";
  const tapeTitle = shadow.querySelector<HTMLElement>("#tape-title")!;
  tapeTitle.textContent = shortTapeTitle(document.title);
  tapeTitle.title = tapeTitle.textContent;

  return {
    host,
    dock: shadow.querySelector<HTMLDivElement>("#dock")!,
    fullPlayer: shadow.querySelector<HTMLDivElement>("#full-player")!,
    miniPlayer: shadow.querySelector<HTMLDivElement>("#mini-player")!,
    articleButton: shadow.querySelector<HTMLButtonElement>("#article-button")!,
    debugButton: shadow.querySelector<HTMLButtonElement>("#debug-button")!,
    speedButton: shadow.querySelector<HTMLButtonElement>("#speed-button")!,
    minimizeButton: shadow.querySelector<HTMLButtonElement>("#minimize-button")!,
    expandButton: shadow.querySelector<HTMLButtonElement>("#expand-button")!,
    miniActionButton: shadow.querySelector<HTMLButtonElement>("#mini-action-button")!,
    selectionButton: shadow.querySelector<HTMLButtonElement>("#selection-button")!,
    playerControls: shadow.querySelector<HTMLDivElement>("#player-controls")!,
    rewindButton: shadow.querySelector<HTMLButtonElement>("#rewind-button")!,
    pauseButton: shadow.querySelector<HTMLButtonElement>("#pause-button")!,
    forwardButton: shadow.querySelector<HTMLButtonElement>("#forward-button")!,
    stopButton: shadow.querySelector<HTMLButtonElement>("#stop-button")!,
    status: shadow.querySelector<HTMLDivElement>("#status")!,
    miniStatus: shadow.querySelector<HTMLSpanElement>("#mini-status")!,
    tapeTitle,
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
  const boundedCenter = Math.max(92, Math.min(window.innerWidth - 92, horizontalCenter));
  const verticalPosition = rect.top >= 48 ? rect.top - 48 : rect.bottom + 10;
  button.style.left = `${boundedCenter}px`;
  button.style.top = `${Math.max(8, Math.min(window.innerHeight - 48, verticalPosition))}px`;
  button.hidden = false;
}

function setTransportState(controls: ReturnType<typeof createControls>, state: TransportState): void {
  if (controls.dock.dataset.transport === state) {
    return;
  }
  controls.dock.dataset.transport = state;
  const canPause = state === "playing" || state === "buffering";
  const canResume = state === "paused" || state === "finished";
  controls.articleButton.hidden = canPause || canResume || state === "connecting";
  const label = canPause ? "Pause audio" : canResume ? "Play audio" : "Listen to article";
  controls.miniActionButton.textContent = canPause ? "Ⅱ" : "▶";
  controls.miniActionButton.disabled = state === "connecting";
  controls.miniActionButton.setAttribute("aria-label", label);
  controls.miniActionButton.title = label;
}

function setPlayerStatus(controls: ReturnType<typeof createControls>, message: string): void {
  if (controls.status.textContent === message) {
    return;
  }
  controls.status.textContent = message;
  controls.miniStatus.textContent = message;
  controls.miniStatus.title = message;
}

function setCompactMode(controls: ReturnType<typeof createControls>, compact: boolean): void {
  controls.dock.dataset.compact = compact ? "true" : "false";
  controls.fullPlayer.hidden = compact;
  controls.miniPlayer.hidden = !compact;
  (compact ? controls.expandButton : controls.minimizeButton).focus();
}

async function startPlayback(
  controls: ReturnType<typeof createControls>,
  text: string,
  source: string,
  selectionRange?: Range,
): Promise<void> {
  stopCurrentPlayback?.();
  controls.playerControls.hidden = true;
  const spokenText = prepareSpokenText(text);
  controls.tapeTitle.textContent = source === "Selected text" ? "Selected passage" : shortTapeTitle(document.title);
  controls.tapeTitle.title = controls.tapeTitle.textContent;
  setTransportState(controls, "connecting");
  setPlayerStatus(controls, `Connecting for ${source.toLowerCase()} audio…`);
  controls.status.hidden = false;

  let context: AudioContext;
  try {
    context = new AudioContext({ sampleRate: SAMPLE_RATE });
  } catch {
    setTransportState(controls, "error");
    setPlayerStatus(controls, "This browser could not create a 44.1 kHz audio stream.");
    controls.status.hidden = false;
    return;
  }
  const port = chrome.runtime.connect({ name: "readflow-tts" });
  let pageTextIndex: PageTextIndex | null = null;
  let sourceStart = -1;
  const highlighter = createPageSentenceHighlighter();
  const alignmentsByChunk = new Map<string, ChunkAlignment>();
  let locatedWords: Array<{ sentenceKey: string; start: number; range: Range }> = [];
  let currentSentenceKey = "";
  let alignmentNeedsMapping = false;
  let didReportHighlightMapping = false;
  let didReportHighlightMismatch = false;
  const sources = new Set<AudioBufferSourceNode>();
  const scheduledRanges: Array<{ start: number; end: number; firstFrame: number; rate: number }> = [];
  const audioTimeline: Array<{ buffer: AudioBuffer; firstFrame: number }> = [];
  const pendingSamples: Float32Array<ArrayBuffer>[] = [];
  let pendingFrameCount = 0;
  const pendingBytesBySection = new Map<number, Uint8Array>();
  let receivedFrames = 0;
  let seekStartFrame = 0;
  let pendingSeekFrame: number | null = null;
  let playbackRate = selectedPlaybackRate;
  let stretch = new StreamingTimeStretch(playbackRate, SAMPLE_RATE);
  let processedOutputFrames = 0;
  let stretchFinished = false;
  let processingTimer = 0;
  let processingEntry = 0;
  let processingOffset = 0;
  const bufferFrames = (): number => bufferFramesForSpeed(SAMPLE_RATE / 10, playbackRate);
  const startupBufferFrames = (): number => Math.ceil(START_BUFFER_SECONDS * SAMPLE_RATE * playbackRate);
  let nextStart = 0;
  let streamFinished = false;
  let playbackComplete = false;
  let stopped = false;
  let animationFrame = 0;
  let playbackStarted = false;
  let startupReady = false;
  let lastBufferStatusAt = 0;
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
    setCurrentPlaybackSpeed = null;
    cancelAnimationFrame(animationFrame);
    window.clearTimeout(processingTimer);
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
        if (stopped) {
          return;
        }
        controls.pauseButton.textContent = "Play";
        setTransportState(controls, "paused");
        recordClientEvent("paused", getAudibleFrame() / SAMPLE_RATE * 1000);
      }).catch(() => undefined);
    } else {
      void context.resume().then(() => {
        if (stopped) {
          return;
        }
        controls.pauseButton.textContent = "Pause";
        setTransportState(controls, "buffering");
        recordClientEvent("resumed", getAudibleFrame() / SAMPLE_RATE * 1000);
      }).catch(() => undefined);
    }
  };
  controls.rewindButton.onclick = () => seekBy(-15);
  controls.forwardButton.onclick = () => seekBy(15);
  controls.stopButton.onclick = () => {
    cleanup();
    setPlayerStatus(controls, "Stopped");
    setTransportState(controls, "stopped");
    controls.playerControls.hidden = true;
    if (stopCurrentPlayback === cleanup) {
      stopCurrentPlayback = null;
    }
  };

  const reportError = (message: string): void => {
    recordClientEvent("playback_error", getAudibleFrame() / SAMPLE_RATE * 1000, message);
    cleanup(false);
    setPlayerStatus(controls, message);
    setTransportState(controls, "error");
    controls.playerControls.hidden = true;
    if (stopCurrentPlayback === cleanup) {
      stopCurrentPlayback = null;
    }
  };

  const finishIfReady = (): void => {
    if (streamFinished && stretchFinished && sources.size === 0 && pendingFrameCount === 0 && !stopped && !playbackComplete) {
      playbackComplete = true;
      highlighter?.clear();
      currentSentenceKey = "";
      recordClientEvent("playback_finished", getAudibleFrame() / SAMPLE_RATE * 1000);
      setPlayerStatus(controls, "Finished");
      setTransportState(controls, "finished");
      controls.pauseButton.textContent = "Play";
      cancelAnimationFrame(animationFrame);
    }
  };

  const scheduleOutput = (samples: Float32Array<ArrayBuffer>): void => {
    if (samples.length === 0) {
      return;
    }
    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const audioSource = context.createBufferSource();
    audioSource.buffer = buffer;
    // Tempo is already applied to the PCM. Resampling here would change pitch.
    audioSource.playbackRate.value = 1;
    audioSource.connect(context.destination);

    const schedulingLead = nextStart === 0 ? 0.05 : 0.01;
    const start = Math.max(context.currentTime + schedulingLead, nextStart);
    const end = start + playbackDuration(samples.length, SAMPLE_RATE, 1);
    scheduledRanges.push({
      start,
      end,
      firstFrame: seekStartFrame + processedOutputFrames * playbackRate,
      rate: playbackRate,
    });
    processedOutputFrames += samples.length;
    nextStart = end;
    sources.add(audioSource);
    audioSource.onended = () => {
      sources.delete(audioSource);
      finishIfReady();
    };
    audioSource.start(start);
  };

  const finishStretch = (): void => {
    if (!stretchFinished && pendingSeekFrame === null) {
      scheduleOutput(stretch.finish());
      stretchFinished = true;
    }
  };

  const processAvailableAudio = (): void => {
    processingTimer = 0;
    if (stopped || pendingSeekFrame !== null) {
      return;
    }
    // Bound each task so replaying a long cached article never blocks the UI.
    const deadline = performance.now() + 8;
    while (processingEntry < audioTimeline.length) {
      const samples = audioTimeline[processingEntry].buffer.getChannelData(0);
      const end = Math.min(samples.length, processingOffset + 8192);
      scheduleOutput(stretch.push(samples.subarray(processingOffset, end)));
      processingOffset = end;
      if (processingOffset === samples.length) {
        processingEntry += 1;
        processingOffset = 0;
      }
      if (performance.now() >= deadline) {
        processingTimer = window.setTimeout(processAvailableAudio, 0);
        return;
      }
    }
    if (streamFinished && pendingFrameCount === 0) {
      finishStretch();
      finishIfReady();
    }
  };

  const startWhenBuffered = (): void => {
    if (!startupReady && (receivedFrames >= startupBufferFrames() || streamFinished)) {
      startupReady = true;
    }
  };

  const scheduleFromFrame = (targetFrame: number): void => {
    processingEntry = 0;
    processingOffset = 0;
    while (processingEntry < audioTimeline.length) {
      const entry = audioTimeline[processingEntry];
      if (entry.firstFrame + entry.buffer.length > targetFrame) {
        processingOffset = Math.max(0, Math.floor(targetFrame - entry.firstFrame));
        break;
      }
      processingEntry += 1;
    }
    processAvailableAudio();
  };

  const scheduleSamples = (samples: Float32Array<ArrayBuffer>): void => {
    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    audioTimeline.push({ buffer, firstFrame: receivedFrames });
    receivedFrames += samples.length;
    if (pendingSeekFrame !== null) {
      const seek = resolveSeekTarget(pendingSeekFrame, receivedFrames, streamFinished, startupBufferFrames());
      if (seek.waiting) {
        return;
      }
      pendingSeekFrame = null;
      seekStartFrame = seek.targetFrame;
      scheduleFromFrame(seek.targetFrame);
      return;
    }
    startWhenBuffered();
    if (startupReady && !processingTimer) {
      processAvailableAudio();
    }
  };

  const flushSamples = (force: boolean): void => {
    if (!force && pendingFrameCount < bufferFrames()) {
      return;
    }

    for (const samples of pendingSamples) {
      scheduleSamples(samples);
    }
    pendingSamples.length = 0;
    pendingFrameCount = 0;
  };

  const queueAudio = (audioBase64: string, sectionIndex: number): void => {
    const decoded = atob(audioBase64);
    const incoming = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    const pendingByte = pendingBytesBySection.get(sectionIndex) || new Uint8Array();
    const combined = new Uint8Array(pendingByte.length + incoming.length);
    combined.set(pendingByte);
    combined.set(incoming, pendingByte.length);
    const completeLength = combined.length - (combined.length % 2);
    if (completeLength === combined.length) pendingBytesBySection.delete(sectionIndex);
    else pendingBytesBySection.set(sectionIndex, combined.slice(completeLength));

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
        frame = range.firstFrame + playedFrames(outputContextTime - range.start, SAMPLE_RATE, range.rate);
        break;
      }
      frame = range.firstFrame + playedFrames(range.end - range.start, SAMPLE_RATE, range.rate);
    }
    return Math.min(receivedFrames, Math.max(0, frame));
  };

  const seekTo = (requestedFrame: number, recordSeek = true): void => {
    const { targetFrame, waiting } = resolveSeekTarget(
      requestedFrame, receivedFrames, streamFinished, startupBufferFrames(),
    );
    if (recordSeek) {
      recordClientEvent("seek", targetFrame / SAMPLE_RATE * 1000);
    }
    for (const audioSource of sources) {
      audioSource.onended = null;
      audioSource.stop();
    }
    sources.clear();
    window.clearTimeout(processingTimer);
    processingTimer = 0;
    scheduledRanges.length = 0;
    seekStartFrame = targetFrame;
    stretch = new StreamingTimeStretch(playbackRate, SAMPLE_RATE);
    startupReady = true;
    processedOutputFrames = 0;
    stretchFinished = false;
    pendingSeekFrame = waiting ? targetFrame : null;
    nextStart = 0;
    playbackComplete = false;
    highlighter?.clear();
    currentSentenceKey = "";
    controls.pauseButton.textContent = context.state === "running" ? "Pause" : "Play";

    if (waiting) {
      setPlayerStatus(controls, `Buffering to ${formatTime(targetFrame / SAMPLE_RATE)}…`);
      setTransportState(controls, "buffering");
    } else {
      scheduleFromFrame(targetFrame);
      setTransportState(controls, context.state === "suspended" ? "paused" : "buffering");
    }

    controls.rewindButton.disabled = targetFrame === 0;
    controls.forwardButton.disabled = streamFinished && targetFrame === receivedFrames;
    cancelAnimationFrame(animationFrame);
    animationFrame = requestAnimationFrame(updatePlaybackTime);
    if (streamFinished && sources.size === 0) {
      finishIfReady();
    }
  };

  const seekBy = (seconds: number): void => {
    seekTo((pendingSeekFrame ?? getAudibleFrame()) + seconds * SAMPLE_RATE);
  };

  setCurrentPlaybackSpeed = (rate) => {
    const frame = pendingSeekFrame ?? getAudibleFrame();
    playbackRate = rate;
    port.postMessage({ type: "set_speed", rate });
    recordClientEvent("speed_changed", frame / SAMPLE_RATE * 1000, { rate });
    if (!playbackComplete) {
      seekTo(frame, false);
    }
  };

  const rebuildWordRanges = (): void => {
    if (!pageTextIndex || sourceStart < 0) {
      return;
    }

    const segments = Array.from(alignmentsByChunk.values()).flatMap((snapshot) =>
      snapshot.segments.map((segment) => ({
        text: segment.text,
        start: snapshot.offset + segment.start,
        end: snapshot.offset + segment.end,
      })),
    ).sort((left, right) => left.start - right.start);
    const offsets = locateWordOffsets(pageTextIndex.text, segments.map((segment) => segment.text), sourceStart);
    const words: typeof locatedWords = [];
    const sentenceRanges = new Map<string, Range>();

    for (const [index, segment] of segments.entries()) {
      const matchAt = offsets[index];
      const matchedText = normalizeForSearch(segment.text);
      if (matchAt === null || !matchedText || !Number.isFinite(segment.start) || !Number.isFinite(segment.end)) {
        if (!didReportHighlightMismatch) {
          recordClientEvent("highlight_text_mismatch", segment.start * 1000);
          didReportHighlightMismatch = true;
        }
        continue;
      }

      const sentence = pageTextIndex.sentences.find((span) => span.start <= matchAt && matchAt < span.end);
      if (!sentence) {
        continue;
      }
      const first = getTextPoint(pageTextIndex, sentence.start);
      const last = getTextPoint(pageTextIndex, sentence.end - 1);
      if (!first || !last) {
        continue;
      }

      const sentenceKey = `${sentence.start}:${sentence.end}`;
      let range = sentenceRanges.get(sentenceKey);
      if (!range) {
        range = document.createRange();
        range.setStart(first.node, first.offset);
        range.setEnd(last.node, last.offset + 1);
        sentenceRanges.set(sentenceKey, range);
      }
      if (selectionRange) {
        if (range.compareBoundaryPoints(Range.END_TO_START, selectionRange) <= 0) {
          continue;
        }
        if (range.compareBoundaryPoints(Range.START_TO_END, selectionRange) >= 0) {
          break;
        }
        if (range.compareBoundaryPoints(Range.START_TO_START, selectionRange) < 0) {
          range.setStart(selectionRange.startContainer, selectionRange.startOffset);
        }
        if (range.compareBoundaryPoints(Range.END_TO_END, selectionRange) > 0) {
          range.setEnd(selectionRange.endContainer, selectionRange.endOffset);
        }
      }
      words.push({ sentenceKey, start: segment.start, range });
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

  const updateSentenceHighlight = (playbackSeconds: number): void => {
    let word: (typeof locatedWords)[number] | undefined;
    for (const candidate of locatedWords) {
      if (candidate.start > playbackSeconds) {
        break;
      }
      word = candidate;
    }

    if (!word || !highlighter) {
      highlighter?.clear();
      currentSentenceKey = "";
      return;
    }
    if (word.sentenceKey === currentSentenceKey) {
      return;
    }

    highlighter?.set(word.range);
    currentSentenceKey = word.sentenceKey;
  };

  const updatePlaybackTime = (): void => {
    if (stopped || playbackComplete) {
      return;
    }

    const now = performance.now();
    if (now - lastBufferStatusAt >= 250) {
      lastBufferStatusAt = now;
      port.postMessage({
        type: "buffer_status",
        audibleFrame: pendingSeekFrame ?? getAudibleFrame(),
        rate: playbackRate,
        paused: context.state === "suspended",
        pendingSeek: pendingSeekFrame !== null,
      });
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
    const hasAudibleAudio = isAudioAudible(scheduledRanges, outputContextTime);
    setTransportState(controls, context.state === "suspended" ? "paused" : hasAudibleAudio ? "playing" : "buffering");
    if (!playbackStarted && hasAudibleAudio && context.state === "running") {
      playbackStarted = true;
      recordClientEvent("playback_started", frame / SAMPLE_RATE * 1000);
    }
    updateSentenceHighlight(frame / SAMPLE_RATE);
    controls.rewindButton.disabled = frame <= 0;
    controls.forwardButton.disabled = streamFinished && frame >= receivedFrames;
    const seconds = Math.max(0, frame / SAMPLE_RATE);
    const state = context.state === "suspended" ? "Paused" : hasAudibleAudio ? "Playing" : "Buffering";
    setPlayerStatus(controls, `${state} · ${formatTime(seconds)}`);
    animationFrame = requestAnimationFrame(updatePlaybackTime);
  };

  port.onMessage.addListener((message: {
    event?: string;
    audio_base64?: string;
    message?: string;
    chunk_seq?: number;
    section_index?: number;
    chunk_audio_offset_sec?: number;
    alignment?: { segments?: WordTiming[] } | null;
  }) => {
    if (stopped) {
      return;
    }

    if (message.event === "audio" && message.audio_base64) {
      try {
        const sectionIndex = Number(message.section_index) || 0;
        queueAudio(message.audio_base64, sectionIndex);
        if (typeof message.chunk_seq === "number" && message.alignment?.segments?.length) {
          alignmentsByChunk.set(`${sectionIndex}:${message.chunk_seq}`, {
            offset: typeof message.chunk_audio_offset_sec === "number" ? message.chunk_audio_offset_sec : 0,
            segments: message.alignment.segments,
          });
          alignmentNeedsMapping = true;
        }
      } catch {
        reportError("Readflow received invalid audio data.");
      }
    } else if (message.event === "section_finish") {
      const sectionIndex = Number(message.section_index) || 0;
      if (pendingBytesBySection.get(sectionIndex)?.length) {
        reportError("Fish Audio ended with an incomplete PCM sample.");
      }
    } else if (message.event === "finish") {
      if (pendingBytesBySection.size) {
        reportError("Fish Audio ended with an incomplete PCM sample.");
        return;
      }
      streamFinished = true;
      flushSamples(true);
      if (receivedFrames === 0) {
        reportError("Fish Audio returned no audio.");
        return;
      }
      if (pendingSeekFrame !== null) {
        seekTo(pendingSeekFrame);
      }
      startWhenBuffered();
      if (!processingTimer) {
        processAvailableAudio();
      }
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
      text: spokenText,
      sections: splitTextSections(spokenText),
      rate: playbackRate,
      textCharCount: spokenText.length,
      wordCount: spokenText.trim().split(/\s+/).length,
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
    setPlayerStatus(controls, "Buffering audio…");
    setTransportState(controls, "buffering");
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
