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
Changing highlight colors is a separate milestone.
The PR integration preserves the sentence capitalization fix already merged into main.
It also preserves main's persistent selected-passage background and spoken-sentence styling.

## Commits

Commit this plan, the source extraction map, spoken-offset alignment, playback integration, and any browser-proven corrections separately.

## Completed validation

Source extraction, spoken-offset alignment, and playback integration are implemented.
Regression tests cover repeated paragraphs, navigation duplicates, inline formatting, selections, whitespace, math cleanup, ambiguous word matches, changed DOM nodes, Readability retries, and hidden text.
TypeScript checking and the production build pass.
The actual built player was checked in the in-app browser using synthetic PCM and controlled timestamps.
The first occurrence highlighted at 9 seconds, seeking forward highlighted the second at 24 seconds, and rewinding returned to the first.
Selected-text playback highlighted only the second selected “Keep going.”
After the PR merge, a fresh browser check confirmed the full second passage keeps its background while the spoken sentence advances.
The original page had zero temporary source-marker attributes.
These browser checks validate mapping and controls; live Fish Audio synchronization has not been tested in this milestone.

Run the local checks from the repository root:

```sh
npm run check
npm run build
node --experimental-strip-types --test tests/*.test.mjs
```

To try the extension, reload this checkout's built `dist/` extension in Chrome and refresh the article tab.
Listen to an article with repeated sentences, then select its second occurrence and listen again.
