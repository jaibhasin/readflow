# Readflow

Readflow is a Chrome extension that reads articles and selected text aloud.

The extension identifies likely article text and selected text, then shows a **Listen** action.
It streams Fish Audio speech through a local Python bridge and starts playback after a small audio buffer is ready.

## Requirements

- Node.js 20 or newer
- Python 3.12 or newer
- [uv](https://docs.astral.sh/uv/)
- Google Chrome

## Configure Fish Audio

Copy the example environment file and add your Fish Audio key to `.env`.

```sh
cp .env.example .env
```

Set `FISH_API_KEY` in `.env` before starting the bridge.

The key stays in the local bridge and is never included in the extension build.

## Start the local bridge

Install the locked Python dependencies once.

```sh
uv sync
```

Start the bridge from the project root.

```sh
uv run uvicorn bridge.main:app --host 127.0.0.1 --port 4179
```

Check that it is running in another terminal.

```sh
curl http://127.0.0.1:4179/health
```

The response should be `{"status":"ok"}`.

## Build the Chrome extension

Install the JavaScript dependencies once.

```sh
npm install
```

Build the extension into `dist/`.

```sh
npm run build
```

Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select this project's `dist/` folder.
After rebuilding, click **Reload** on the Readflow extension card, then refresh the article tab so Chrome replaces its old page script.
Keep the local bridge running while listening.

On an article page, choose **Listen to article** to read the article.
Select text and choose **Listen** to read only that selection.
Use **Back 15 seconds**, **Pause**, **Forward 15 seconds**, or **Stop** in the small player while audio is playing.
The cassette label shows the article title and site, and its reels turn while audio is playing.
Choose **−** to shrink the player to a compact view with status and play or pause, then **⌃** to expand it.
The speed button cycles through 0.75×, 1×, 1.1×, 1.2×, 1.3×, 1.4×, 1.5×, 2×, and 3×.
Speed changes apply locally using continuous SoundTouch time stretching, preserving voice pitch.
At 1× the original PCM passes through unchanged.
The processor keeps its overlap across incoming chunks, drains its final audio tail, and maps playback time back to the original timestamps for sentence highlighting.
Seeking or changing speed restarts processing from the current position using cached original audio.
Processing uses small tasks so a long cached article does not block the player controls.
If **Forward 15 seconds** reaches audio that has not arrived yet, playback waits at that target until enough audio is buffered.
Each Listen action splits text at sentence boundaries into short ordered sections and sends each section as a separate request through the local bridge.
At 1× and speeds below 2×, Readflow requests one section at a time; at 2× it can request two at once, and at 3× it can request three at once.
The extension limits all tabs together to three active Fish requests and starts more sections as the rolling buffer drains.
Playback begins after three seconds of audio at the selected speed are ready, and waits if generation later falls behind.
Audio sections are played in their original order, and their word timestamps are offset onto one continuous article timeline.
Changing speed or seeking reprocesses cached audio locally and does not request the same text again.
Readflow converts inline ordinal math such as `$n^\text{th}$` to “nth” before sending it to Fish.
Other formulas are left as written until Readflow has a reliable spoken form for them.

## View listen diagnostics

Click **Debug** on an article page or the Readflow toolbar icon to see the last 10 listens, including the source, text and audio counts, and whether the request finished or stopped.
The summary is saved only in this browser profile.
Turn on **Record detailed trace for next listen** before listening to save the exact text, each Fish text fragment, provider timing, and returned word timestamps for one listen.
Open a listen and expand its events to inspect the saved text and timestamp snapshots, or export that listen as JSON.
Detailed recording turns itself off after one listen.
No audio data or Fish API key is saved, and **Clear all** removes the local diagnostics.

## Check the bridge stream

With the bridge running and `FISH_API_KEY` configured, send a short request.

```sh
curl -N http://127.0.0.1:4179/v1/tts/stream/with-timestamp \
  -H 'Content-Type: application/json' \
  -d '{"text":"This is a Readflow streaming check."}'
```

Fish Audio events should arrive as the service generates audio and timestamp data.

## Run checks

The TypeScript unit tests below require Node.js 22.6 or newer.

```sh
npm run check
npm run build
node --experimental-strip-types --test tests/*.test.mjs
```
