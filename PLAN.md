# Readflow MVP plan

## Product goal

Readflow adds listening controls directly to HTML articles, blogs, and HTML research papers.
Readers can select text and use a nearby **Listen** action, or start at the top of the current article from a small floating player.
The page follows the spoken paragraph and gives the current word a subtle highlight.

## MVP experience

1. On an article page, a compact player appears near the lower right edge.
2. **Listen to article** extracts the main reading content, starts at its beginning, and skips navigation, ads, comments, and related links.
3. Selecting readable text shows a small **Listen** action near the selection.
4. The player shows play/pause, 15-second back and forward controls, progress, and a close button.
5. Playback scrolls the active paragraph into view when needed and highlights the current word without changing the article's markup or layout.
6. Closing the player stops playback and removes Readflow highlights.
7. If Fish Audio rejects a request, the player shows a short, actionable error.

The article action always starts at the top of the main article.
Selection playback reads only the selected text.
The floating player stays within the current tab; navigation starts a new session.

## Tech stack

| Part | Choice | Reason |
| --- | --- | --- |
| Browser extension | Chrome Manifest V3 | Current Chrome extension platform. |
| Content script and player | TypeScript, native DOM, CSS in a shadow root | Small UI with styles isolated from the host page. |
| Build | Vite for extension assets | Simple TypeScript bundling and local iteration. |
| Article detection | Mozilla Readability on a cloned document, plus live DOM paragraph matching | Good main-content extraction while retaining links to visible text for highlighting. |
| Highlight | CSS Highlight API and DOM `Range` | Highlights words without inserting spans into an article. |
| Audio | HTMLAudioElement with MediaSource | Streams compressed audio into a normal seekable player. |
| Local TTS bridge | Python 3.12+ managed with uv, FastAPI, Uvicorn, HTTPX, python-dotenv | Uses uv to lock bridge dependencies; reads `FISH_API_KEY` from `.env` and relays Fish Audio's stream without bundling the key. |
| TTS | Fish Audio `s2.1-pro-free` timestamp stream | Supplies audio and alignment data together. |

No account system or database is needed for the local MVP.

## Data and playback logic

```text
Current page text or selection
  -> content script extracts readable text and live DOM ranges
  -> extension service worker requests local FastAPI bridge
  -> bridge calls Fish Audio with FISH_API_KEY from .env
  -> Fish Audio SSE audio and alignment events
  -> bridge and service worker relay events to the content script
  -> player buffers audio, follows paragraph, highlights spoken word
```

The Fish endpoint is `POST /v1/tts/stream/with-timestamp` with the `model: s2.1-pro-free` header.
Its response contains base64 audio chunks and cumulative alignment snapshots.
The FastAPI bridge uses an HTTPX async streaming request and returns the Fish Audio events through `StreamingResponse` as `text/event-stream`.
When playback stops or the tab navigates, the bridge closes the upstream Fish Audio request.
The client appends every audio chunk in arrival order and replaces the latest alignment snapshot for each `chunk_seq`.
It adds `chunk_audio_offset_sec` to each word's local start and end times before comparing them with the audio player's current time.

For a full article, Readability identifies the reading content from a cloned document.
The content script matches its normalized paragraphs to the live page, records text-node ranges, and excludes unmatched page chrome.
For a selection, it records ranges directly from the user's selection.
If an article cannot be matched reliably, the player should explain that it cannot follow the text rather than highlight unrelated words.

The player should start as soon as a small audio buffer is ready.
It should update the active word from the media clock, scroll only when the active paragraph leaves a comfortable reading area, and respect manual scrolling for a short period.
The 15-second controls seek on the same media timeline, including back into audio that has already buffered.
Long articles may require bounded text requests and a rolling buffer so that one request does not hold the entire article in memory.

## Local key handling

The existing `.env` contains `FISH_API_KEY` and remains untracked.
The FastAPI bridge loads it with `python-dotenv` at startup and makes Fish Audio requests on behalf of the extension.
The key never appears in the extension package, browser storage, page DOM, or logs.
The bridge binds to loopback only and accepts requests from this local extension workflow.

## Implementation order

1. Set up the extension build, manifest, FastAPI bridge, and a documented local launch flow using Uvicorn.
2. Add article extraction and selected-text detection, with the small on-page actions.
3. Stream Fish audio through the bridge and play it in the floating player.
4. Add word alignment, subtle highlighting, paragraph scrolling, and 15-second seeking.
5. Handle long articles, navigation, cancellation, API errors, and sites with unusual DOM structures.
6. Check the complete interaction on representative blogs, news articles, and HTML research papers in Chrome.

## MVP completion criteria

- A reader can load the unpacked extension, start the local bridge, and hear selected text or the current article.
- The API key remains only in the local `.env` file.
- The player starts before the full article audio has finished generating.
- Play/pause and both 15-second controls work during playback.
- Word highlighting stays close to the spoken audio, and paragraph scrolling does not fight deliberate user scrolling.
- Main-content playback excludes obvious navigation, ads, and comments on representative pages.
- Stopping, closing, or navigating cancels requests and clears temporary highlights.
