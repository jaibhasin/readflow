# Readflow 📼

> Listen to web articles without losing your pace.

[![CI](https://github.com/jaibhasin/readflow/actions/workflows/ci.yml/badge.svg)](https://github.com/jaibhasin/readflow/actions/workflows/ci.yml)
[![Chrome](https://img.shields.io/badge/Chrome-Manifest_V3-4285F4)](extension/manifest.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6)](package.json)
[![Python](https://img.shields.io/badge/Python-3.12%2B-3776AB)](pyproject.toml)
[![Fish Audio](https://img.shields.io/badge/voice-Fish_Audio-00897B)](https://fish.audio/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Readflow turns web articles and selected passages into speech, with a small cassette-style player that lives on the page.
Listen, follow the highlighted sentence, and return to unfinished reads when you have time.

- **Read what you choose.** Listen to the main article or just a selected passage.
- **Keep your place.** Sentence highlighting and automatic scrolling follow the audio, with a pause in following when you scroll yourself.
- **Control the pace.** Play, pause, skip 15 seconds, or listen from 0.75× to 3× with pitch-preserving speed changes.
- **Jump to a word.** Double-click a word during article listening to continue from there.
- **Make it yours.** Browse Fish Audio voices and save favorites.
- **Come back later.** Save articles and resume unfinished articles or selections from your reading list.

**Current status:** a local project loaded as an unpacked Chrome extension.
It requires a running Python bridge, internet access, and your own Fish Audio API key.
PDF reading and Chrome Web Store installation are not available yet.

[Get started](#requirements) · [Reading list](#pending-and-future-reads) · [Privacy](#privacy-and-data) · [Contributing](CONTRIBUTING.md)

## Requirements

- Node.js 22.13 or newer
- Python 3.12 or newer
- [uv](https://docs.astral.sh/uv/)
- Google Chrome
- A Fish Audio account with an API key and access to speech generation

Clone the repository and run the setup commands below from its root.

```sh
git clone https://github.com/jaibhasin/readflow.git
cd readflow
```

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

### Automatic startup on macOS

To keep the bridge available without a terminal, install a background service once after `uv sync` and configuring `.env`.
Stop any bridge you already started in a terminal before installing.
Choose a permanent checkout rather than a temporary worktree; the service uses that folder and its Python environment.

```sh
python3 scripts/bridge-service.py install
```

The bridge starts immediately, starts again when you log in, and restarts if it exits.
It listens only on `127.0.0.1:4179` and continues reading the key from the project's `.env`.
Your Mac must be awake and connected to the internet to generate speech.
Logs are stored in `~/Library/Logs/Readflow/`.

```sh
python3 scripts/bridge-service.py status
python3 scripts/bridge-service.py uninstall
```

Uninstalling removes automatic startup and stops the managed bridge while preserving your key and logs.
If you move the checkout or recreate its Python environment, run the install command again.

## Build the Chrome extension

Install the JavaScript dependencies once.

```sh
npm ci
```

Build the extension into `dist/`.

```sh
npm run build
```

Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select this project's `dist/` folder.
After rebuilding, click **Reload** on the Readflow extension card, then refresh the article tab so Chrome replaces its old page script.
Keep the local bridge running while listening, or use the macOS background service above.

## Listen on the page

Open an article page after loading the extension.
Pin Readflow in Chrome's extensions menu, then click its toolbar icon to show the compact Walkman on the current page.
Click **▶** to listen, or **⌃** to expand the player.
Opening websites does not show the player or start listening automatically.
The player can also read selected passages on ordinary pages without a detected article.
Chrome's internal pages and other protected pages cannot show the player.

| Action | How |
| --- | --- |
| Listen to an article | Choose **Listen to article** in the player. |
| Listen to a passage | Select text and choose **Listen**. |
| Navigate audio | Use **Back 15 seconds**, **Pause**, **Forward 15 seconds**, or **Stop**. |
| Start at a word | Double-click a word during article listening, including while paused. |
| Change speed | Click the speed button to cycle from 0.75× through 3×. |
| Choose a voice | Open the voice button on the cassette label to browse and save favorites. |
| Shrink the player | Choose **−** for a compact player, then **⌃** to expand it. |

The current sentence is highlighted as it is spoken, and the page follows it when it leaves the reading area.
Manual scrolling or interacting with the page pauses automatic following for four seconds; dragging or selecting text holds it until you release.

<details>
<summary>Playback details and buffering behavior</summary>

Words with cached audio seek immediately; words that have not been generated start a new stream from that point, skipping the intervening paragraphs.
You can still select a passage and choose **Listen** to read just that selection.
Paused listening sessions keep their background connection alive when you switch tabs.
If the background worker unexpectedly restarts, Readflow tries once to reconnect at the current word and preserves the pause state.
Reloading or updating the extension itself still requires refreshing an already-open article tab.
While audio plays, Readflow smoothly brings the spoken line into view only when it leaves a comfortable reading area, including inside scrollable article panels.
Scrolling or interacting with the page gives you four seconds before automatic following resumes; dragging or selecting text holds it until you release.
Automatic following rests while audio is paused or buffering and uses instant scrolling when your system requests reduced motion.
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
Changing speed or seeking within cached audio reprocesses it locally and does not request the same text again.
Readflow converts inline ordinal math such as `$n^\text{th}$` to “nth” before sending it to Fish.
Other formulas are left as written until Readflow has a reliable spoken form for them.

</details>

## Pending and future reads

Click the Readflow toolbar icon, expand the Walkman with **⌃**, and choose **Reads** to view your reading list.
Search your reads by title or site, including completed articles and passages.
**In progress** shows unfinished articles and selected passages, the percentage read, and estimated listening time remaining at 1× (180 words per minute).
Hover over the time estimate to see the words left.
Progress follows the audio you have heard, including when you pause, stop, or seek.
Readflow saves progress every five seconds and when you pause, stop, or leave the page.

Choose **Save for later** in the article player to add an article to **To read** without starting audio.
Click a read card, **Resume**, or **Start reading** to open its source link in a new tab, then summon Readflow from the toolbar and click **▶** to resume.
Resuming starts at the beginning of the unfinished sentence.
Selected passages can also be resumed.
If an article's text changes, Readflow offers to start its current text rather than applying the old progress to different content.

Finished listens move to **Completed reads**.
**Read again** restarts them, and **Remove** deletes a read and its saved text.
Text and progress stay in local extension storage in this browser profile; audio is not saved.
Resuming generates new audio for the remaining text and requires the local bridge.
Existing listens from before this feature are not added retroactively.

## View listen diagnostics

Click **Debug** on an article page or in the reading list to see the last 10 listens, including the source, text and audio counts, and whether the request finished or stopped.
The summary is saved only in this browser profile.
Turn on **Record detailed trace for next listen** before listening to save the exact text, each Fish text fragment, provider timing, and returned word timestamps for one listen.
Open a listen and expand its events to inspect the saved text and timestamp snapshots, or export that listen as JSON.
Detailed recording turns itself off after one listen.
No audio data or Fish API key is saved, and **Clear all** removes the local diagnostics.

## Privacy and data

The extension sends the article or selected text you choose to listen to through the local bridge to Fish Audio for speech generation.
Speech generation is an online service; Fish Audio's account limits and pricing apply.
Your API key stays in the bridge's untracked `.env` file and is never bundled into the extension.
Keep the bridge bound to `127.0.0.1` as shown in the setup command.

Saved reads contain article or selection text, source URLs, and reading progress in local extension storage.
Voice choices and diagnostics also stay in this browser profile.
Audio is buffered for the current session and is not saved across browser restarts.
Optional detailed diagnostics include the exact text sent for a listen, so review exported JSON before sharing it.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| The player does not appear | Use an HTML article page rather than a PDF, Chrome settings page, or the Chrome Web Store. Reload the extension and refresh the article tab after rebuilding. |
| Listening cannot connect | Keep the bridge running and check `curl http://127.0.0.1:4179/health`. |
| Fish Audio rejects the request | Check `FISH_API_KEY` in `.env`, restart the bridge, and check your Fish Audio account access. |
| Audio pauses to buffer at a higher speed | Try a lower speed so speech generation can keep up. |
| A saved read needs new audio | Resume with the bridge running; saved reads store text and progress rather than audio. |

## Check the bridge stream

With the bridge running and `FISH_API_KEY` configured, send a short request.

```sh
curl -N http://127.0.0.1:4179/v1/tts/stream/with-timestamp \
  -H 'Content-Type: application/json' \
  -d '{"text":"This is a Readflow streaming check."}'
```

Fish Audio events should arrive as the service generates audio and timestamp data.

## Run checks

GitHub Actions runs type checking, the production build, all JavaScript unit tests, the browser playback check, and Python bridge tests on every push and pull request.
The workflow can also be started manually from GitHub's **Actions** tab.
CI uses synthetic audio and mocked Fish connections, so it needs no Fish API key.

The TypeScript and DOM unit tests below require Node.js 22.13 or newer.

```sh
npm run check
npm run build
node --experimental-strip-types --test tests/*.test.mjs
uv run python -m unittest discover -s tests -p 'test_*.py'
```

For a browser playback check, build first, then run `node tests/playback-browser.mjs` with Chromium installed (or set `CHROMIUM_PATH` to its executable).
This uses synthetic audio and a controlled extension port with real Web Audio to check a 45-second frozen-tab pause, word seeking, disconnect recovery, and selected-text listening.
It requires free local ports 4179, 4180, and 9224; stop the local bridge first.
It does not test Chrome's extension service-worker lifecycle or live Fish Audio.

## Project guide

| Path | Purpose |
| --- | --- |
| [`extension/`](extension/) | On-page player, article extraction, audio processing, and reading list. |
| [`bridge/`](bridge/) | Local FastAPI service that keeps the API key separate from the extension. |
| [`tests/`](tests/) | JavaScript and Python tests, plus the browser playback check. |
| [`PLAN.md`](PLAN.md) | Architecture and the original MVP plan. |
| [`FUTURE_ENHANCEMENTS.md`](FUTURE_ENHANCEMENTS.md) | Future work. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Development checks and bug reports. |

## License

Readflow's original code is licensed under [MIT](LICENSE).
Bundled third-party software retains its own licenses, including SoundTouchJS under LGPL-2.1.
See [third-party notices](extension/THIRD_PARTY_NOTICES.md) for its license and source links.
