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

export function locateWordOffsets(
  pageText: string,
  words: string[],
  startAt: number,
  maxGap = 80,
): Array<number | null> {
  let cursor = startAt;
  return words.map((word) => {
    const normalizedWord = normalizeForSearch(word);
    if (!normalizedWord) {
      return null;
    }
    const position = pageText.indexOf(normalizedWord, cursor);
    if (position < 0 || position - cursor > maxGap) {
      return null;
    }
    cursor = position + normalizedWord.length;
    return position;
  });
}
