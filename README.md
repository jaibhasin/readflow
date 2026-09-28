# Readflow

Readflow is a Chrome extension that reads articles and selected text aloud.

The extension identifies likely article text and selected text, then shows a **Listen** action.
It streams Fish Audio speech through a local Python bridge and starts playback after buffering 100 ms of audio.

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
Keep the local bridge running while listening.

On an article page, choose **Listen to article** to read the article.
Select text and choose **Listen** to read only that selection.
Use **Pause** or **Stop** in the small player while audio is playing.

## Check the bridge stream

With the bridge running and `FISH_API_KEY` configured, send a short request.

```sh
curl -N http://127.0.0.1:4179/v1/tts/stream/with-timestamp \
  -H 'Content-Type: application/json' \
  -d '{"text":"This is a Readflow streaming check."}'
```

Fish Audio events should arrive as the service generates audio and timestamp data.

## Run checks

```sh
npm run check
npm run build
```
