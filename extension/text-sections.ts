export type TextSection = {
  index: number;
  text: string;
  start: number;
  end: number;
};

const FIRST_SECTION_TARGET = 150;
const SECTION_TARGET = 230;
const MAX_SENTENCE_LENGTH = 320;

export function splitTextSections(text: string): TextSection[] {
  if (!text.trim()) {
    return [];
  }

  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  const sentences = Array.from(segmenter.segment(text), ({ segment, index }) =>
    splitLongSentence(segment, index),
  ).flat();
  const groups: Array<{ text: string; start: number; end: number }> = [];
  let current: { text: string; start: number; end: number } | null = null;

  for (const sentence of sentences) {
    const target = groups.length === 0 ? FIRST_SECTION_TARGET : SECTION_TARGET;
    if (current && current.text.length + sentence.text.length > target) {
      groups.push(current);
      current = null;
    }

    if (!current) {
      current = { ...sentence };
    } else {
      current.text += sentence.text;
      current.end = sentence.end;
    }
  }

  if (current) {
    groups.push(current);
  }

  return groups.map((section, index) => ({ index, ...section }));
}

function splitLongSentence(text: string, start: number): Array<{ text: string; start: number; end: number }> {
  if (text.length <= MAX_SENTENCE_LENGTH) {
    return [{ text, start, end: start + text.length }];
  }

  const pieces: Array<{ text: string; start: number; end: number }> = [];
  const words = /\S+\s*/gu;
  let match: RegExpExecArray | null;
  let piece = "";
  let pieceStart = 0;

  while ((match = words.exec(text)) !== null) {
    if (match[0].length > MAX_SENTENCE_LENGTH) {
      const characters = Array.from(match[0]);
      let offset = 0;
      let relativeOffset = 0;
      while (offset < characters.length) {
        let part = "";
        while (offset < characters.length && part.length + characters[offset].length <= MAX_SENTENCE_LENGTH) {
          part += characters[offset++];
        }
        if (piece) {
          pieces.push({ text: piece, start: start + pieceStart, end: start + pieceStart + piece.length });
          piece = "";
        }
        pieces.push({ text: part, start: start + match.index + relativeOffset, end: start + match.index + relativeOffset + part.length });
        relativeOffset += part.length;
      }
      pieceStart = match.index + match[0].length;
      continue;
    }
    if (piece && piece.length + match[0].length > MAX_SENTENCE_LENGTH) {
      pieces.push({ text: piece, start: start + pieceStart, end: start + pieceStart + piece.length });
      pieceStart = match.index;
      piece = "";
    }
    if (!piece) {
      pieceStart = match.index;
    }
    piece += match[0];
  }

  if (piece) {
    pieces.push({ text: piece, start: start + pieceStart, end: start + pieceStart + piece.length });
  }
  return pieces;
}
