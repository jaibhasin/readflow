export function prepareSpokenText(text: string): string {
  return prepareSpokenSource(text).text;
}

export function prepareSpokenSource(source: string): { text: string; sourceOffsets: number[] } {
  let text = "";
  const sourceOffsets: number[] = [];
  let cursor = 0;
  const appendOriginal = (end: number): void => {
    for (; cursor < end; cursor += 1) {
      text += source[cursor];
      sourceOffsets.push(cursor);
    }
  };
  for (const match of source.matchAll(/\$\s*([a-z])\s*\^\s*\\text\{(st|nd|rd|th)\}\s*\$/gi)) {
    appendOriginal(match.index);
    const replacement = `${match[1]}${match[2]}`;
    text += replacement;
    sourceOffsets.push(...Array<number>(replacement.length).fill(match.index));
    cursor = match.index + match[0].length;
  }
  appendOriginal(source.length);
  return { text, sourceOffsets };
}
