export function foldCharacter(character: string): string {
  if (character === "ᵗ") {
    return "t";
  }
  if (character === "ʰ") {
    return "h";
  }
  const folded = character.toLowerCase();
  return folded.length === 1 ? folded : character;
}

export function normalizeForSearch(text: string): string {
  return text.replace(/\s+/g, " ").trim().split("").map(foldCharacter).join("");
}

export function sentenceSpans(text: string, blockStarts: number[] = [0]): Array<{ start: number; end: number }> {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  return blockStarts.flatMap((blockStart, blockIndex) => {
    const blockEnd = blockStarts[blockIndex + 1] ?? text.length;
    return Array.from(segmenter.segment(text.slice(blockStart, blockEnd)), ({ segment, index }) => ({
      start: blockStart + index + segment.length - segment.trimStart().length,
      end: blockStart + index + segment.trimEnd().length,
    })).filter((span) => span.start < span.end);
  });
}
