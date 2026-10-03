import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createArticleSource, createSelectionSource, sourceRanges } from "../extension/reading-source.ts";

const paragraph = "This article describes a reader following the same words in separate paragraphs, with enough detail to identify the main content reliably. ".repeat(5);

function articleDocument() {
  return new JSDOM(`<nav class="menu"><p>Keep going.</p></nav><article><p id="first">Keep going. ${paragraph}</p><p id="second">Keep going. ${paragraph}</p></article>`, { url: "https://example.com/article" }).window.document;
}

test("repeated article text retains each original paragraph instead of the navigation copy", () => {
  const document = articleDocument();
  const before = document.body.innerHTML;
  const source = createArticleSource(document);
  assert.ok(source);
  const first = source.text.indexOf("Keep going.");
  const second = source.text.indexOf("Keep going.", first + 1);
  assert.equal(sourceRanges(source, first, first + 11)[0].startContainer.parentElement.id, "first");
  assert.equal(sourceRanges(source, second, second + 11)[0].startContainer.parentElement.id, "second");
  assert.equal(document.body.innerHTML, before);
  assert.equal(source.text.indexOf("Keep going.", second + 1), -1);
});

test("inline formatting retains exact text nodes and spaces", () => {
  const document = new JSDOM("<p>Hello <strong>world</strong>.</p>").window.document;
  const selection = document.createRange();
  selection.selectNodeContents(document.querySelector("p"));
  const source = createSelectionSource(selection);
  const ranges = sourceRanges(source, 0, source.text.length);
  assert.equal(source.text, "Hello world.");
  assert.equal(ranges.map(range => range.toString()).join(""), "Hello world.");
  assert.equal(ranges[1].startContainer.parentElement.tagName, "STRONG");
});

test("selection of a repeated passage starts at the selected occurrence and clips both ends", () => {
  const document = new JSDOM("<p>Keep going.</p><p id='selected'>Before Keep <strong>going</strong>. After</p>").window.document;
  const paragraph = document.getElementById("selected");
  const selection = document.createRange();
  selection.setStart(paragraph.firstChild, 7);
  selection.setEnd(paragraph.lastChild, 1);
  const source = createSelectionSource(selection);
  const ranges = sourceRanges(source, 0, source.text.length);
  assert.equal(source.text, "Keep going.");
  assert.equal(ranges.map(range => range.toString()).join(""), "Keep going.");
  assert.equal(ranges[0].startContainer, paragraph.firstChild);
  assert.equal(ranges.at(-1).endOffset, 1);
});

test("collapsed whitespace retains original character offsets", () => {
  const document = new JSDOM("<p>  Hello \n  world. </p>").window.document;
  const selection = document.createRange();
  selection.selectNodeContents(document.querySelector("p"));
  const source = createSelectionSource(selection);
  assert.equal(source.text, "Hello world.");
  assert.equal(sourceRanges(source, 6, 11)[0].toString(), "world");
});

test("changed or detached source nodes are never replaced with a matching occurrence", () => {
  const document = articleDocument();
  const source = createArticleSource(document);
  const first = source.text.indexOf("Keep going.");
  document.getElementById("first").firstChild.data = "Changed text.";
  assert.deepEqual(sourceRanges(source, first, first + 11), []);
  const second = source.text.indexOf("Keep going.", first + 1);
  document.getElementById("second").remove();
  assert.deepEqual(sourceRanges(source, second, second + 11), []);
});

test("non-article pages and empty selections have no reading source", () => {
  const document = new JSDOM("<p>Short text.</p>").window.document;
  assert.equal(createArticleSource(document), null);
  const selection = document.createRange();
  selection.setStart(document.querySelector("p").firstChild, 0);
  selection.collapse(true);
  assert.equal(createSelectionSource(selection), null);
});
