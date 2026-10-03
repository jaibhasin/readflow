# Preserve extracted text locations

## Goal

Repeated words and sentences must highlight their own occurrence in the chosen article or selection.
Playback must stop searching the full page for the spoken text.

## Implementation

1. Add temporary text-node IDs to the cloned document passed to Readability.
   Keep an ID-to-live-text-node map without changing the visible page.
   Readability's extracted content retains those IDs, including when it rebuilds its cloned DOM.
2. Build a reading source containing the extracted text, sentence boundaries, and exact live text offsets.
   Build selected-text sources directly from the selected range.
   Leave unanchored extracted text unmapped rather than guessing a location.
3. Align Fish word timestamps to the exact spoken source text in order.
   Preserve offsets through the existing spoken-text preparation.
   Resolve sentence highlights using the saved source locations rather than a page-wide search.
4. Verify repeated occurrences, inline formatting, selection boundaries, removed page content, and alignment mismatches.
   Check types, build output, and browser behavior with deterministic audio events.

## Scope

Keep the existing sentence cue appearance, sentence segmentation policy, audio clock, seeking, and playback controls.
Selection ranges become part of the source map, removing the need to clip page-wide ranges during playback.
Changing highlight colors or sentence capitalization handling is a separate milestone.

## Commits

Commit this plan, the source extraction map, spoken-offset alignment, playback integration, and any browser-proven corrections separately.
