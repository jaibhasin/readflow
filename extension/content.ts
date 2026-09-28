import { isProbablyReaderable, Readability } from "@mozilla/readability";

let statusTimeout = 0;
const articleText = getArticleText();

if (articleText && !document.getElementById("readflow-controls")) {
  const controls = createControls();
  document.documentElement.append(controls.host);

  controls.articleButton.addEventListener("click", () => {
    showCaptureStatus(controls.status, "Article", articleText);
  });

  controls.selectionButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
  });

  controls.selectionButton.addEventListener("click", () => {
    const selectedText = getSelectedText();

    if (selectedText) {
      showCaptureStatus(controls.status, "Selected text", selectedText);
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
        bottom: 76px;
        box-shadow: 0 4px 16px rgb(0 0 0 / 22%);
        color: #f7f7f8;
        max-width: min(320px, calc(100vw - 32px));
        padding: 10px 14px;
        pointer-events: auto;
        position: fixed;
        right: 24px;
      }

      [hidden] {
        display: none !important;
      }
    </style>
    <div class="readflow-layer">
      <button id="article-button" type="button">Listen to article</button>
      <button id="selection-button" type="button" hidden>Listen</button>
      <div id="status" role="status" aria-live="polite" hidden></div>
    </div>
  `;

  return {
    host,
    articleButton: shadow.querySelector<HTMLButtonElement>("#article-button")!,
    selectionButton: shadow.querySelector<HTMLButtonElement>("#selection-button")!,
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

function showCaptureStatus(
  status: HTMLDivElement,
  source: string,
  text: string,
): void {
  const wordCount = text.split(/\s+/).length;
  status.textContent = `${source} text ready · ${wordCount} words`;
  status.hidden = false;
  window.clearTimeout(statusTimeout);
  statusTimeout = window.setTimeout(() => {
    status.hidden = true;
  }, 2500);
}
