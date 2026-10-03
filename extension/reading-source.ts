import { isProbablyReaderable, Readability } from "@mozilla/readability";
import { sentenceSpans } from "./text-map.ts";

const SOURCE_ATTRIBUTE = "data-readflow-source-id";
const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, th, dt, dd, pre, div, section, article, main";
const EXCLUDED_SELECTOR = "script, style, noscript, template, [hidden], [aria-hidden='true'], #readflow-controls";

type SourcePart = {
  text: string;
  node: Text | null;
  offset: number;
  block: Element | null;
};

type SourceSpan = {
  node: Text;
  originalText: string;
  start: number;
  offsets: number[];
};

export type ReadingSource = {
  text: string;
  spans: SourceSpan[];
  sentences: Array<{ start: number; end: number }>;
};

function textNodes(root: Node): Text[] {
  if (root.nodeType === 3) {
    return [root as Text];
  }
  const walker = root.ownerDocument!.createTreeWalker(root, 4);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    nodes.push(walker.currentNode as Text);
  }
  return nodes;
}

function buildSource(parts: SourcePart[]): ReadingSource {
  let text = "";
  const spans: SourceSpan[] = [];
  const blockStarts = [0];
  let currentBlock: Element | null = null;
  for (const part of parts) {
    if (part.block !== currentBlock) {
      if (text) {
        if (!text.endsWith(" ")) {
          text += " ";
        }
        blockStarts.push(text.length);
      }
      currentBlock = part.block;
    }
    let start = -1;
    const offsets: number[] = [];
    for (let offset = 0; offset < part.text.length; offset += 1) {
      const character = part.text[offset];
      if (/\s/.test(character) && (!text || text.endsWith(" "))) {
        continue;
      }
      start = start < 0 ? text.length : start;
      text += /\s/.test(character) ? " " : character;
      offsets.push(part.offset + offset);
    }
    if (part.node && offsets.length) {
      spans.push({ node: part.node, originalText: part.node.data, start, offsets });
    }
  }
  text = text.trimEnd();
  return { text, spans, sentences: sentenceSpans(text, blockStarts) };
}

export function createArticleSource(document: Document): ReadingSource | null {
  if (!isProbablyReaderable(document)) {
    return null;
  }
  const clone = document.cloneNode(true) as Document;
  for (const element of Array.from(clone.querySelectorAll(`[${SOURCE_ATTRIBUTE}]`))) {
    element.removeAttribute(SOURCE_ATTRIBUTE);
  }
  const liveNodes = textNodes(document.body);
  const clonedNodes = textNodes(clone.body);
  const sourceNodes = new Map<string, Text>();
  for (const [index, node] of clonedNodes.entries()) {
    if (node.parentElement?.closest(EXCLUDED_SELECTOR)) {
      continue;
    }
    const id = String(index);
    const marker = clone.createElement("span");
    marker.setAttribute(SOURCE_ATTRIBUTE, id);
    node.replaceWith(marker);
    marker.append(node);
    sourceNodes.set(id, liveNodes[index]);
  }
  const article = new Readability(clone, { serializer: (node) => node }).parse();
  if (!article?.content) {
    return null;
  }
  const parts = textNodes(article.content).filter((node) => !node.parentElement?.closest(EXCLUDED_SELECTOR)).map((node) => {
    const id = node.parentElement?.closest(`[${SOURCE_ATTRIBUTE}]`)?.getAttribute(SOURCE_ATTRIBUTE);
    const liveNode = id ? sourceNodes.get(id) : undefined;
    return {
      text: node.data,
      node: liveNode?.data === node.data ? liveNode : null,
      offset: 0,
      block: node.parentElement?.closest(BLOCK_SELECTOR) ?? null,
    };
  });
  const source = buildSource(parts);
  return source.text ? source : null;
}

export function createSelectionSource(range: Range): ReadingSource | null {
  const parts = textNodes(range.commonAncestorContainer).filter((node) =>
    range.intersectsNode(node) && !node.parentElement?.closest(EXCLUDED_SELECTOR),
  ).map((node) => {
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.length;
    return {
      text: node.data.slice(start, end),
      node,
      offset: start,
      block: node.parentElement?.closest(BLOCK_SELECTOR) ?? null,
    };
  });
  const source = buildSource(parts);
  return source.text ? source : null;
}

export function sourceRanges(source: ReadingSource, start: number, end: number): Range[] {
  const ranges: Range[] = [];
  for (const span of source.spans) {
    const first = Math.max(start, span.start) - span.start;
    const last = Math.min(end, span.start + span.offsets.length) - span.start - 1;
    if (first > last || !span.node.isConnected || span.node.data !== span.originalText) {
      continue;
    }
    const range = span.node.ownerDocument.createRange();
    range.setStart(span.node, span.offsets[first]);
    range.setEnd(span.node, span.offsets[last] + 1);
    ranges.push(range);
  }
  return ranges;
}

export function sliceReadingSource(source: ReadingSource, start: number, end = source.text.length): ReadingSource {
  return {
    text: source.text.slice(start, end),
    spans: source.spans.flatMap((span) => {
      const first = Math.max(start, span.start) - span.start;
      const last = Math.min(end, span.start + span.offsets.length) - span.start;
      return first >= last ? [] : [{ ...span, start: Math.max(start, span.start) - start, offsets: span.offsets.slice(first, last) }];
    }),
    sentences: source.sentences.flatMap((sentence) => {
      const first = Math.max(start, sentence.start);
      const last = Math.min(end, sentence.end);
      return first >= last ? [] : [{ start: first - start, end: last - start }];
    }),
  };
}
