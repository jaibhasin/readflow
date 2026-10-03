import { adaptiveHighlightPalette } from "./highlight-colors.ts";

type HighlightValue = Set<Range> & { priority: number };
export type PageSentenceHighlighter = {
  set(ranges: Range[], selectionRange?: Range): void;
  clear(): void;
};

export function createPageHighlighter(document: Document): PageSentenceHighlighter | null {
  const view = document.defaultView!;
  const registry = (view.CSS as unknown as {
    highlights?: { set(name: string, value: HighlightValue): void };
  } | undefined)?.highlights;
  const Constructor = (view as unknown as { Highlight?: new () => HighlightValue }).Highlight;
  if (!registry || !Constructor) return null;

  const sentence = new Constructor();
  const passage = new Constructor();
  const selectedSentence = new Constructor();
  selectedSentence.priority = 1;
  registry.set("readflow-current-sentence", sentence);
  registry.set("readflow-selected-passage", passage);
  registry.set("readflow-selected-sentence", selectedSentence);
  const savedStyles = new Map<HTMLElement | SVGElement, Array<[string, string, string]>>();
  const sentenceColor = "--readflow-current-sentence-highlight";
  const passageColor = "--readflow-selected-passage-highlight";

  const applyPalette = (range: Range): void => {
    const root = range.commonAncestorContainer;
    const walker = document.createTreeWalker(root, view.NodeFilter.SHOW_TEXT);
    let node: Node | null = root.nodeType === view.Node.TEXT_NODE ? root : walker.nextNode();
    const elements = new Set<Element>();
    while (node) {
      if (node.parentElement && range.intersectsNode(node)) elements.add(node.parentElement);
      node = walker.nextNode();
    }
    for (const element of elements) {
      if (!(element instanceof view.HTMLElement || element instanceof view.SVGElement)) continue;
      if (!savedStyles.has(element)) {
        savedStyles.set(element, [sentenceColor, passageColor].map(name => [
          name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name),
        ]));
      }
      const palette = adaptiveHighlightPalette(element);
      element.style.setProperty(sentenceColor, palette.sentence);
      element.style.setProperty(passageColor, palette.passage);
    }
  };
  const restoreStyles = (): void => {
    for (const [element, properties] of savedStyles) {
      for (const [name, value, priority] of properties) {
        if (value) element.style.setProperty(name, value, priority);
        else element.style.removeProperty(name);
      }
    }
    savedStyles.clear();
  };

  return {
    set(ranges, selectionRange) {
      sentence.clear();
      selectedSentence.clear();
      // Selection colors stay local to each text surface, even across mixed themes.
      if (!selectionRange || !passage.has(selectionRange)) {
        restoreStyles();
        passage.clear();
        if (selectionRange) {
          applyPalette(selectionRange);
          passage.add(selectionRange);
        }
      }
      for (const range of ranges) {
        applyPalette(range);
        (selectionRange ? selectedSentence : sentence).add(range);
      }
    },
    clear() {
      sentence.clear();
      passage.clear();
      selectedSentence.clear();
      restoreStyles();
    },
  };
}
