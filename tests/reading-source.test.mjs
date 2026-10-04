import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createArticleSource, createSelectionSource, selectedWordOffset, sourceOffsetAt, sourceRanges } from "../extension/reading-source.ts";

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

test("table-based essays with line breaks retain live text locations without changing the page", () => {
  const document = new JSDOM(`<title>Essay</title><table><tr><td><div class='menu'><a href='/'>Home</a><br><a href='/essays'>Essays</a></div></td><td><font>September 2026<br><br><span id='first'>First passage. ${paragraph}</span><br><br><span id='second'>Second passage. ${paragraph}</span></font></td></tr></table>`).window.document;
  const before = document.body.innerHTML;
  const source = createArticleSource(document);
  assert.ok(source);
  assert.ok(source.text.includes("First passage."));
  assert.ok(source.text.includes("Second passage."));
  assert.ok(!source.text.includes("Home"));
  assert.ok(!source.text.includes("Essays"));
  const second = source.text.indexOf("Second passage.");
  assert.equal(sourceRanges(source, second, second + 15)[0].startContainer, document.getElementById("second").firstChild);
  assert.equal(document.body.innerHTML, before);
});

test("a table-based navigation page does not become an article", () => {
  const links = Array.from({ length: 40 }, (_, index) => `<a href='/post-${index}'>Read another detailed article about this interesting topic</a><br>`).join("");
  const document = new JSDOM(`<table><tr><td>${links}</td></tr></table>`).window.document;
  const before = document.body.innerHTML;
  assert.equal(createArticleSource(document), null);
  assert.equal(document.body.innerHTML, before);
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

test("source IDs survive Readability rebuilding a short article during retries", () => {
  const paragraph = ("Keep going. " + "The reader follows a detailed explanation of source locations and repeated text. ".repeat(4)).slice(0, 245);
  const document = new JSDOM(`<article><p id='first'>${paragraph}</p><p id='second'>${paragraph}</p></article>`).window.document;
  const source = createArticleSource(document);
  assert.ok(source);
  const second = source.text.indexOf("Keep going.", 1);
  assert.ok(second > 0);
  assert.equal(sourceRanges(source, second, second + 11)[0].startContainer, document.getElementById("second").firstChild);
});

test("hidden text inside a selected sentence receives no highlight range", () => {
  const document = new JSDOM("<p>Keep <span aria-hidden='true'>Ignore this duplicate.</span><strong>going.</strong></p>").window.document;
  const selection = document.createRange();
  selection.selectNodeContents(document.querySelector("p"));
  const source = createSelectionSource(selection);
  const ranges = sourceRanges(source, 0, source.text.length);
  assert.equal(source.text, "Keep going.");
  assert.equal(ranges.map(range => range.toString()).join(""), "Keep going.");
  assert.equal(ranges.length, 2);
});

test("source extraction preserves main's sentence boundaries before case-insensitive alignment", () => {
  const document = new JSDOM("<p>First sentence. Second sentence? Third sentence.</p>").window.document;
  const selection = document.createRange();
  selection.selectNodeContents(document.querySelector("p"));
  const source = createSelectionSource(selection);
  assert.deepEqual(source.sentences.map(({ start, end }) => source.text.slice(start, end)), [
    "First sentence.", "Second sentence?", "Third sentence.",
  ]);
});

test("double-click resolves repeated words by DOM occurrence, excluding navigation", () => {
  const document = articleDocument();
  const source = createArticleSource(document);
  const range = document.createRange();
  range.setStart(document.getElementById("second").firstChild, 5);
  range.setEnd(document.getElementById("second").firstChild, 10);
  assert.equal(selectedWordOffset(source, range), source.text.indexOf("going", source.text.indexOf("going") + 1));
  range.selectNodeContents(document.querySelector("nav p").firstChild);
  assert.equal(selectedWordOffset(source, range), null);
});

test("word seeking handles inline words and collapsed whitespace without accepting stale nodes", () => {
  const document = new JSDOM("<p>  Hello \n <strong>world</strong>. After.</p>").window.document;
  const passage = document.createRange();
  passage.selectNodeContents(document.querySelector("p"));
  const source = createSelectionSource(passage);
  const word = document.createRange();
  const node = document.querySelector("strong").firstChild;
  word.setStart(node, 1);
  word.setEnd(node, 5);
  assert.equal(selectedWordOffset(source, word), 6);
  assert.equal(sourceOffsetAt(source, document.querySelector("p").firstChild, 2), 0);
  word.collapse(true);
  assert.equal(selectedWordOffset(source, word), null);
  node.data = "other";
  assert.equal(sourceOffsetAt(source, node, 0), null);
});

test("seeking cannot escape a selected source through the same text node", () => {
  const document = new JSDOM("<p>Before selected words after.</p>").window.document;
  const node = document.querySelector("p").firstChild;
  const passage = document.createRange();
  passage.setStart(node, 7);
  passage.setEnd(node, 21);
  const source = createSelectionSource(passage);
  assert.equal(sourceOffsetAt(source, node, 0), null);
  assert.equal(sourceOffsetAt(source, node, 7), 0);
  assert.equal(sourceOffsetAt(source, node, 22), null);
});

test("resuming a sliced source retains original DOM ranges across inline elements", async () => {
  const { sliceReadingSource } = await import("../extension/reading-source.ts");
  const document = new JSDOM("<p>First sentence. Second <strong>sentence</strong>. Third sentence.</p>").window.document;
  const range = document.createRange();
  range.selectNodeContents(document.querySelector("p"));
  const full = createSelectionSource(range);
  const source = sliceReadingSource(full, 16);
  assert.equal(source.text, "Second sentence. Third sentence.");
  assert.equal(sourceRanges(source, 0, 16).map(r => r.toString()).join(""), "Second sentence.");
  assert.equal(sourceRanges(source, 7, 15)[0].startContainer.parentElement.tagName, "STRONG");
  assert.equal(source.sentences[0].start, 0);
});
