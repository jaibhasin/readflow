import { sourceRanges, type ReadingSource } from "./reading-source.ts";
import type { prepareSpokenSource } from "./spoken-text.ts";
import { alignSpokenWords } from "./word-alignment.ts";

export type SentenceTiming = { sentenceKey: string; start: number; ranges: Range[] };

export function mapSentenceTimings(
  source: ReadingSource,
  spoken: ReturnType<typeof prepareSpokenSource>,
  segments: Array<{ text: string; start: number; end: number }>,
): SentenceTiming[] {
  const offsets = alignSpokenWords(spoken.text, segments.map((segment) => segment.text));
  const cachedRanges = new Map<string, Range[]>();
  return segments.flatMap((segment, index) => {
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end)) {
      return [];
    }
    const offset = offsets[index];
    const sourceOffset = offset === null ? undefined : spoken.sourceOffsets[offset];
    const sentence = sourceOffset === undefined ? undefined : source.sentences.find((span) => span.start <= sourceOffset && sourceOffset < span.end);
    if (!sentence) {
      return [{ sentenceKey: "", start: segment.start, ranges: [] }];
    }
    const sentenceKey = `${sentence.start}:${sentence.end}`;
    let ranges = cachedRanges.get(sentenceKey);
    if (!ranges) {
      ranges = sourceRanges(source, sentence.start, sentence.end);
      cachedRanges.set(sentenceKey, ranges);
    }
    return [{ sentenceKey: ranges.length ? sentenceKey : "", start: segment.start, ranges }];
  });
}
