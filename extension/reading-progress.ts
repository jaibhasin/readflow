import { alignSpokenWords } from "./word-alignment.ts";
import type { prepareSpokenSource } from "./spoken-text.ts";

export function mapReadingOffsets(
  spoken: ReturnType<typeof prepareSpokenSource>,
  segments: Array<{ text: string; start: number; end: number }>,
): Array<{ start: number; offset: number }> {
  const offsets = alignSpokenWords(spoken.text, segments.map((segment) => segment.text));
  return segments.flatMap((segment, index) => {
    const offset = offsets[index];
    const sourceOffset = offset === null ? undefined : spoken.sourceOffsets[offset];
    return sourceOffset === undefined || !Number.isFinite(segment.start) ? [] : [{ start: segment.start, offset: sourceOffset }];
  });
}
