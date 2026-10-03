import { normalizeForSearch } from "./text-map.ts";

function wordTokens(text: string): Array<{ text: string; start: number }> {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  return Array.from(segmenter.segment(text)).filter((segment) => segment.isWordLike).map((segment) => ({
    text: segment.segment,
    start: segment.index,
  }));
}

export function alignSpokenWords(source: string, words: string[]): Array<number | null> {
  const sourceTokens = wordTokens(normalizeForSearch(source));
  const spokenTokens = words.flatMap((word, wordIndex) => wordTokens(normalizeForSearch(word)).map((token) => ({ ...token, wordIndex })));
  const tokenOffsets: Array<number | null> = Array(spokenTokens.length).fill(null);
  let sourceIndex = 0;
  let spokenIndex = 0;
  let needsAnchor = false;
  while (spokenIndex < spokenTokens.length && sourceIndex < sourceTokens.length) {
    if (!needsAnchor && sourceTokens[sourceIndex].text === spokenTokens[spokenIndex].text) {
      tokenOffsets[spokenIndex] = sourceTokens[sourceIndex].start;
      sourceIndex += 1;
      spokenIndex += 1;
      continue;
    }
    needsAnchor = true;
    const anchorLength = Math.min(3, spokenTokens.length - spokenIndex);
    const candidates: number[] = [];
    if (anchorLength >= 2) {
      for (let candidate = sourceIndex; candidate < Math.min(sourceIndex + 9, sourceTokens.length); candidate += 1) {
        if (Array.from({ length: anchorLength }, (_, offset) =>
          sourceTokens[candidate + offset]?.text === spokenTokens[spokenIndex + offset].text,
        ).every(Boolean)) {
          candidates.push(candidate);
        }
      }
    }
    if (candidates.length === 1) {
      sourceIndex = candidates[0];
      needsAnchor = false;
      continue;
    }
    spokenIndex += 1;
  }
  const offsetsByWord: Array<Array<number | null>> = words.map(() => []);
  for (const [index, token] of spokenTokens.entries()) {
    offsetsByWord[token.wordIndex].push(tokenOffsets[index]);
  }
  return offsetsByWord.map((offsets) => offsets.length && offsets.every((offset) => offset !== null) ? offsets[0] : null);
}
