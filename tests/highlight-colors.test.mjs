import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { adaptiveHighlightPalette } from "../extension/highlight-colors.ts";
import { createPageHighlighter } from "../extension/page-highlighter.ts";

function page(style = "", prefersDark = false) {
  const { window } = new JSDOM(`<html style='${style}'><body style='color: #222'><article><p>Hello <strong>world.</strong></p></article></body></html>`);
  window.matchMedia = () => ({ matches: prefersDark });
  return window;
}

function rangeFor(element) {
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  return range;
}

test("white and warm paper backgrounds get a soft blue cue", () => {
  for (const background of ["#fff", "#fff8eb"]) {
    const window = page(`background: ${background}`);
    assert.deepEqual(adaptiveHighlightPalette(window.document.querySelector("p")), {
      sentence: "rgba(59, 130, 246, 0.28)", passage: "rgba(59, 130, 246, 0.12)",
    });
  }
});

test("black and charcoal backgrounds get lavender while preserving light text", () => {
  for (const background of ["#000", "#20232a"]) {
    const window = page(`background: ${background}`);
    const paragraph = window.document.querySelector("p");
    paragraph.style.color = "#eee";
    assert.deepEqual(adaptiveHighlightPalette(paragraph), {
      sentence: "rgba(167, 139, 250, 0.3)", passage: "rgba(167, 139, 250, 0.14)",
    });
  }
});

test("explicit light color scheme overrides the system dark preference", () => {
  const window = page("color-scheme: light", true);
  assert.match(adaptiveHighlightPalette(window.document.querySelector("p")).sentence, /^rgba\(59, 130, 246,/);
});

test("normal color scheme stays light and an explicit dark scheme uses a dark canvas", () => {
  const light = page("", true);
  assert.match(adaptiveHighlightPalette(light.document.querySelector("p")).sentence, /^rgba\(59, 130, 246,/);
  const dark = page("color-scheme: dark");
  dark.document.body.style.color = "white";
  assert.match(adaptiveHighlightPalette(dark.document.querySelector("p")).sentence, /^rgba\(167, 139, 250,/);
});

test("a translucent surface is composited over its real ancestor background", () => {
  const window = page("background: black");
  const paragraph = window.document.querySelector("p");
  paragraph.style.backgroundColor = "rgba(255, 255, 255, 0.9)";
  assert.match(adaptiveHighlightPalette(paragraph).sentence, /^rgba\(59, 130, 246,/);
  paragraph.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
  paragraph.style.color = "white";
  assert.match(adaptiveHighlightPalette(paragraph).sentence, /^rgba\(167, 139, 250,/);
});

test("marginal text contrast reduces highlight opacity", () => {
  const window = page("background: white");
  const paragraph = window.document.querySelector("p");
  paragraph.style.color = "#767676";
  const palette = adaptiveHighlightPalette(paragraph);
  const opacity = Number(palette.sentence.match(/, ([\d.]+)\)$/)[1]);
  assert.ok(opacity < 0.28);
  const background = [59, 130, 246].map(channel => channel * opacity + 255 * (1 - opacity));
  const linear = channel => (channel / 255 <= 0.04045 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * linear(background[0]) + 0.7152 * linear(background[1]) + 0.0722 * linear(background[2]);
  assert.ok((luminance + 0.05) / (linear(118) + 0.05) >= 4.5);
});

test("modern CSS colors are converted through the browser's canvas", () => {
  const window = page();
  const paragraph = window.document.querySelector("p");
  const originalStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = element => element === paragraph
    ? { backgroundColor: "oklch(0.2 0.01 250)", color: "rgb(255, 255, 255)" }
    : originalStyle(element);
  window.HTMLCanvasElement.prototype.getContext = () => ({
    clearRect() {}, fillRect() {}, getImageData: () => ({ data: [18, 18, 18, 255] }),
  });
  assert.match(adaptiveHighlightPalette(paragraph).sentence, /^rgba\(167, 139, 250,/);
});

test("selected passages crossing themes receive local colors and restore prior styles", () => {
  const window = page("background: white");
  window.CSS = { highlights: new Map() };
  window.Highlight = class extends Set { priority = 0; };
  const document = window.document;
  const article = document.querySelector("article");
  article.innerHTML = "<p style='--readflow-current-sentence-highlight: pink !important'>Light paper.</p><p style='background: black; color: white'>Dark inset.</p>";
  const [light, dark] = article.children;
  const highlighter = createPageHighlighter(document);
  const selection = rangeFor(article);
  highlighter.set([rangeFor(light)], selection);
  assert.match(light.style.getPropertyValue("--readflow-selected-passage-highlight"), /^rgba\(59, 130, 246,/);
  assert.match(dark.style.getPropertyValue("--readflow-selected-passage-highlight"), /^rgba\(167, 139, 250,/);
  assert.equal(window.CSS.highlights.get("readflow-selected-sentence").size, 1);
  assert.equal(light.style.color, "");
  highlighter.set([rangeFor(dark)]);
  assert.equal(window.CSS.highlights.get("readflow-selected-passage").size, 0);
  assert.equal(light.style.getPropertyValue("--readflow-current-sentence-highlight"), "pink");
  assert.equal(light.style.getPropertyPriority("--readflow-current-sentence-highlight"), "important");
  highlighter.clear();
  assert.equal(dark.style.getPropertyValue("--readflow-current-sentence-highlight"), "");
  for (const highlight of window.CSS.highlights.values()) assert.equal(highlight.size, 0);
});

test("unavailable Highlight API leaves the page untouched", () => {
  const window = page();
  assert.equal(createPageHighlighter(window.document), null);
});
