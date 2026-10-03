import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createReadingAutoScroller, readingScrollDelta } from "../extension/auto-scroll.ts";

function fixture({ reducedMotion = false, nested = false } = {}) {
  const { window } = new JSDOM("<div id='player'></div><article><p>Spoken text.</p></article>");
  const document = window.document;
  let now = 0;
  Object.defineProperty(window.performance, "now", { value: () => now });
  Object.defineProperty(document, "hidden", { value: false });
  window.innerHeight = 1_000;
  window.matchMedia = () => ({ matches: reducedMotion });
  const scrolls = [];
  window.scrollBy = (options) => scrolls.push(options);
  const article = document.querySelector("article");
  const panelScrolls = [];
  if (nested) {
    article.style.overflowY = "auto";
    Object.defineProperties(article, {
      clientHeight: { value: 400 },
      scrollHeight: { value: 2_000 },
    });
    article.getBoundingClientRect = () => ({ top: 200 });
    article.scrollBy = (options) => panelScrolls.push(options);
  }
  const range = document.createRange();
  range.selectNodeContents(document.querySelector("p"));
  range.getClientRects = () => [{ top: 900, bottom: 924, width: 80, height: 24 }];
  const scroller = createReadingAutoScroller(window, document.querySelector("#player"));
  return { window, document, range, scroller, scrolls, panelScrolls, advance: (ms) => { now += ms; }, follow: () => scroller.follow(() => [range]) };
}

test("comfortable lines stay still; lines outside the reading area move near the upper third", () => {
  assert.equal(readingScrollDelta(300, 324, 0, 1_000), 0);
  assert.equal(readingScrollDelta(900, 924, 0, 1_000), 550);
  assert.equal(readingScrollDelta(50, 74, 0, 1_000), -300);
  assert.equal(readingScrollDelta(900, 924, 200, 400), 560);
  assert.equal(readingScrollDelta(0, 24, 0, 0), 0);
});

test("scroll checks are throttled, and reduced motion uses instant movement", () => {
  const f = fixture({ reducedMotion: true });
  f.follow();
  f.follow();
  assert.deepEqual(f.scrolls, [{ top: 550, behavior: "instant" }]);
  f.advance(250);
  f.follow();
  assert.equal(f.scrolls.length, 2);
  f.scroller.dispose();
});

test("manual wheel and keyboard scrolling yield for four seconds, including within the same sentence", () => {
  for (const input of ["wheel", "PageDown"]) {
    const f = fixture();
    f.document.dispatchEvent(input === "wheel" ? new f.window.Event("wheel") : new f.window.KeyboardEvent("keydown", { key: input }));
    f.advance(3_999);
    f.follow();
    assert.equal(f.scrolls.length, 0);
    f.advance(1);
    f.follow();
    assert.deepEqual(f.scrolls, [{ top: 550, behavior: "smooth" }]);
    f.scroller.dispose();
  }
});

test("dragging or selecting text holds scrolling until release and the grace period", () => {
  const f = fixture();
  f.document.dispatchEvent(new f.window.Event("pointerdown"));
  f.advance(8_000);
  f.follow();
  assert.equal(f.scrolls.length, 0);
  f.document.dispatchEvent(new f.window.Event("pointerup"));
  f.advance(4_000);
  f.follow();
  assert.equal(f.scrolls.length, 1);
  f.scroller.dispose();
});

test("page navigation keys yield even while a player button has focus", () => {
  const f = fixture();
  f.document.querySelector("#player").dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
  f.follow();
  assert.equal(f.scrolls.length, 0);
  f.advance(4_000);
  f.follow();
  assert.equal(f.scrolls.length, 1);
  f.scroller.dispose();
});

test("nested panels reveal their text without unnecessarily moving the outer page", () => {
  const f = fixture({ nested: true });
  f.follow();
  assert.deepEqual(f.panelScrolls, [{ top: 560, behavior: "smooth" }]);
  assert.deepEqual(f.scrolls, []);
  f.scroller.dispose();
});

test("player interactions do not suppress following; detached text and disposed sessions do not scroll", () => {
  const f = fixture();
  f.document.querySelector("#player").dispatchEvent(new f.window.Event("pointerdown", { bubbles: true }));
  f.follow();
  assert.equal(f.scrolls.length, 1);
  const paragraph = f.document.querySelector("p");
  paragraph.remove();
  f.range.selectNodeContents(paragraph);
  f.advance(250);
  f.follow();
  assert.equal(f.scrolls.length, 1);
  f.scroller.dispose();
  f.scroller.follow(() => { throw new Error("disposed session should not resolve ranges"); });
});
