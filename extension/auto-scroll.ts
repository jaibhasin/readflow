const MANUAL_SCROLL_GRACE_MS = 4_000;
const CHECK_INTERVAL_MS = 250;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/** Keep the spoken line comfortable without scrolling for every word. */
export function readingScrollDelta(top: number, bottom: number, viewportTop: number, height: number): number {
  if (height <= 0) return 0;
  const comfortableTop = viewportTop + height * 0.15;
  const comfortableBottom = viewportTop + height * 0.8;
  if (top >= comfortableTop && bottom <= comfortableBottom) return 0;
  return top - (viewportTop + height * 0.35);
}

export function createReadingAutoScroller(view: Window, player: HTMLElement) {
  const document = view.document;
  const listeners = new (view as Window & typeof globalThis).AbortController();
  const options = { capture: true, passive: true, signal: listeners.signal };
  let suspendedUntil = 0;
  let pointerHeld = false;
  let nextCheckAt = 0;
  let disposed = false;
  const yieldToReader = (): void => {
    suspendedUntil = view.performance.now() + MANUAL_SCROLL_GRACE_MS;
  };
  const isPlayerEvent = (event: Event): boolean => event.composedPath().includes(player);
  document.addEventListener("wheel", (event) => {
    if (!isPlayerEvent(event)) yieldToReader();
  }, options);
  document.addEventListener("touchmove", yieldToReader, options);
  document.addEventListener("keydown", (event) => {
    if (!isPlayerEvent(event) && SCROLL_KEYS.has(event.key)) yieldToReader();
  }, options);
  document.addEventListener("pointerdown", (event) => {
    if (isPlayerEvent(event)) return;
    pointerHeld = true;
    yieldToReader();
  }, options);
  const releasePointer = (): void => {
    if (!pointerHeld) return;
    pointerHeld = false;
    yieldToReader();
  };
  document.addEventListener("pointerup", releasePointer, options);
  document.addEventListener("pointercancel", releasePointer, options);
  view.addEventListener("blur", releasePointer, options);

  return {
    follow(getRanges: () => Range[]): void {
      const now = view.performance.now();
      if (disposed || document.hidden || pointerHeld || now < suspendedUntil || now < nextCheckAt) return;
      nextCheckAt = now + CHECK_INTERVAL_MS;
      const range = getRanges().find((candidate) => candidate.startContainer.isConnected && candidate.endContainer.isConnected);
      if (!range) return;
      const rect = Array.from(range.getClientRects()).find((candidate) => candidate.width > 0 && candidate.height > 0);
      if (!rect) return;
      let top = rect.top;
      let bottom = rect.bottom;
      const behavior: ScrollBehavior = view.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth";
      let element = range.startContainer.nodeType === 1
        ? range.startContainer as Element
        : range.startContainer.parentElement;

      // Reveal text inside nested article panels before moving the outer page.
      while (element && element !== document.scrollingElement) {
        if (element.clientHeight > 0 && element.scrollHeight > element.clientHeight
          && /^(auto|scroll)$/.test(view.getComputedStyle(element).overflowY)) {
          const viewportTop = element.getBoundingClientRect().top + element.clientTop;
          const delta = readingScrollDelta(top, bottom, viewportTop, element.clientHeight);
          const target = Math.max(0, Math.min(element.scrollHeight - element.clientHeight, element.scrollTop + delta));
          const movement = target - element.scrollTop;
          if (Math.abs(movement) > 1) {
            element.scrollBy({ top: movement, behavior });
            top -= movement;
            bottom -= movement;
          }
        }
        element = element.parentElement;
      }
      const viewport = view.visualViewport;
      const delta = readingScrollDelta(top, bottom, viewport?.offsetTop ?? 0, viewport?.height ?? view.innerHeight);
      if (Math.abs(delta) > 1) view.scrollBy({ top: delta, behavior });
    },
    dispose(): void {
      disposed = true;
      listeners.abort();
    },
  };
}
