# Readflow MVP plan

## Product goal

Readflow adds listening controls directly to HTML articles, blogs, and HTML research papers.
Readers can select text and use a nearby **Listen** action, or start at the top of the current article from a small floating player.
The page follows the spoken paragraph and gives the current word a subtle highlight.

## MVP experience

1. Clicking the extension toolbar icon shows a compact player near the lower right edge of the current page.
2. **Listen to article** extracts the main reading content, starts at its beginning, and skips navigation, ads, comments, and related links.
3. After activating Readflow, selecting readable text shows a small **Listen** action near the selection.
4. The player shows play/pause, 15-second back and forward controls, progress, and a close button.
5. Playback scrolls the active paragraph into view when needed and highlights the current word without changing the article's markup or layout.
6. Closing the player stops playback and removes Readflow highlights.
7. If Fish Audio rejects a request, the player shows a short, actionable error.

The article action always starts at the top of the main article.
Selection playback reads only the selected text.
The floating player stays within the current tab; navigation starts a new session and requires another toolbar click.

## Tech stack

| Part | Choice | Reason |
| --- | --- | --- |
| Browser extension | Chrome Manifest V3 | Current Chrome extension platform. |
| Content script and player | TypeScript, native DOM, CSS in a shadow root | Small UI with styles isolated from the host page. |
| Build | Vite for extension assets | Simple TypeScript bundling and local iteration. |
| Article detection | Mozilla Readability on a cloned document with text-node source IDs | Keeps main-content extraction linked to exact visible text locations. |
| Highlight | CSS Highlight API and DOM `Range` | Highlights words without inserting spans into an article. |
| Audio | Web Audio API with 44.1 kHz PCM | Plays Fish's raw PCM chunks while keeping playback time tied to submitted audio frames. |
| Local TTS bridge | Python 3.12+ managed with uv, FastAPI, Uvicorn, websockets, msgpack, python-dotenv | Uses uv to lock bridge dependencies; reads `FISH_API_KEY` from `.env` and relays Fish Audio's stream without bundling the key. |
| TTS | Fish Audio `s2.1-pro-free` timestamp stream | Supplies audio and alignment data together. |

No account system or database is needed for the local MVP.

## Data and playback logic

```text
Current page text or selection
  -> content script extracts readable text and live DOM ranges
  -> content script asks the extension service worker to listen
  -> service worker sends text to the local FastAPI bridge
  -> bridge sends text fragments to Fish Audio over a timestamped WebSocket
  -> Fish Audio returns PCM audio and alignment frames over the same WebSocket
  -> bridge relays events to the service worker as a local SSE stream
  -> service worker forwards audio chunks to the content script
  -> player buffers three seconds of audio at the selected speed, then schedules chunks consecutively with Web Audio
```

The bridge accepts requests at `POST /v1/tts/stream/with-timestamp` and connects to Fish Audio's timestamped live WebSocket with the `model: s2.1-pro-free` header.
It sends text fragments as MessagePack frames while receiving audio and alignment frames from Fish Audio.
The bridge converts audio bytes to base64 and relays each event through a local SSE response.
The service worker forwards events to the content script over a Chrome extension port.
The content script divides text at sentence boundaries into short requests and keeps a rolling buffer using up to three concurrent provider streams.
One active request is used below 2×, two at 2×, and three at 3×, with a shared three-request limit across tabs.
The player carries incomplete 16-bit PCM samples between events and waits for three seconds of audio at the current playback rate before starting.
It schedules each audio buffer after the previous one so network event boundaries do not create gaps.
Playback progress comes from the Web Audio output timestamp mapped to scheduled PCM frames, not from network arrival time.
When playback stops or the tab navigates, closing the local stream closes the Fish Audio WebSocket.
Alignment snapshots are cumulative for each request-local `chunk_seq`; a newer snapshot replaces the previous one for that chunk.
The worker holds out-of-order sections until earlier sections finish, then offsets each request's timestamps by the durations of preceding audio sections.

For a full article, Readability identifies the reading content from a cloned document.
Before extraction, temporary IDs on cloned text wrappers link each fragment to its original live text node.
The visible page remains untouched, and these IDs survive Readability rebuilding its clone during retries.
The extracted source records text-node character offsets in reading order, so repeated passages retain separate locations.
For a selection, the source records only text and offsets inside the user's selected range.
Spoken-text preparation retains an offset map back to that source.
Fish words align in order to the exact text sent to Fish, using whole words and unique nearby context to recover after mismatches.
Playback resolves highlights through saved source offsets instead of searching the full page.
Uncertain, changed, or detached text locations receive no highlight rather than pointing to another occurrence.

The player should start after its three-second playback buffer is ready.
It should update the active word from the media clock, scroll only when the active paragraph leaves a comfortable reading area, and respect manual scrolling for a short period.
The 15-second controls seek on the same media timeline, including back into audio that has already buffered.
The section scheduler uses a target buffer of 12 seconds of playback and keeps requests bounded so parallel responses cannot grow without limit.

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
