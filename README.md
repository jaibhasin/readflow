# Readflow 📼

Listen to web articles or selected text with a cassette-style Chrome player.
Click the extension icon to show it, then press Play.
Nothing appears automatically when you open a website.

[![CI](https://github.com/jaibhasin/readflow/actions/workflows/ci.yml/badge.svg)](https://github.com/jaibhasin/readflow/actions/workflows/ci.yml)

- Follow the highlighted sentence or double-click a word to listen from there.
- Pause, skip 15 seconds, and change speed from 0.75× to 3× while preserving pitch.
- Choose Fish Audio voices and save favorites.
- Save articles and passages, then resume them from **Reads**.
- On Mac, open Readflow from Applications when needed and quit it to stop its Python server.

Readflow currently runs as an unpacked Chrome extension.
It needs internet access and your own Fish Audio API key; provider usage charges may apply.
PDF reading and Chrome Web Store installation are not available yet.

## First-time setup

You need **Chrome**, **Node.js 22.13+**, **Python 3.12+**, [uv](https://docs.astral.sh/uv/), and a [Fish Audio](https://fish.audio/) API key with speech-generation access.
Run these commands in Terminal:

```sh
git clone https://github.com/jaibhasin/readflow.git
cd readflow
npm ci
uv sync --locked
cp .env.example .env
```

Open `.env` in a text editor and replace the placeholder after `FISH_API_KEY=` with your key.
Keep this checkout in a permanent location.

### 1. Start Readflow

**On macOS 13+:** install Apple's Command Line Tools if needed with `xcode-select --install`, then build the app:

```sh
python3 scripts/build-mac-app.py --output "$HOME/Applications/Readflow.app"
```

Open **Readflow** from your user Applications folder or Spotlight and wait for **Ready to listen**.
Quit with **Quit Readflow**, Command-Q, or the window's close button to stop the server.
Minimizing keeps it running; it does not start at login.
While open, it uses memory, and speech generation and playback use CPU, network, and battery.
App logs are at `~/Library/Logs/Readflow/app-bridge.log`.

**On other systems, or without the Mac app:** keep this command running in Terminal while listening:

```sh
uv run uvicorn bridge.main:app --host 127.0.0.1 --port 4179
```

Press Control-C when finished.
Use either the app or the Terminal server at a time.

### 2. Load the Chrome extension

```sh
npm run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the project's `dist` folder.
3. Pin Readflow from Chrome's extensions menu.
4. Open a website, click the Readflow icon, then press **▶**.

Use **⌃** to expand the player for article listening, voice choices, **Reads**, and **Debug**.
To listen to a passage, activate Readflow first, then select text and choose **Listen**.
Chrome settings pages, the Chrome Web Store, and other protected pages cannot show the player.

## Update an existing installation

**You do not need to clone again.**
Quit Readflow, stop any manually started server, and run these commands from your existing checkout after the PR is merged:

```sh
git switch main
git pull --ff-only
npm ci
uv sync --locked
npm run build
```

Keep your existing `.env`; do not replace it with the example file again.
If Git reports local changes or diverged branches, resolve them before switching or pulling.

At `chrome://extensions`, click **Reload** on Readflow's card, then refresh your website tab.
For Mac app changes, rebuild with the app command above and reopen Readflow.
The builder preserves the previous app as `Readflow.previous.app`; move that backup elsewhere before a later rebuild.
Rebuild the app if you move the checkout, because it remembers the project's location.

If you previously enabled the always-on service, remove it before using the app:

```sh
python3 scripts/bridge-service.py uninstall
```

<details>
<summary>Optional: always-on startup on macOS</summary>

Choose this only if you want the bridge running even when the Readflow app is closed.
Quit the app and stop any Terminal server before installing the service from your permanent checkout:

```sh
python3 scripts/bridge-service.py install
python3 scripts/bridge-service.py status
```

The service starts at login and restarts the bridge if it exits.
Remove it with `python3 scripts/bridge-service.py uninstall`; your key and logs are preserved.
Reinstall it if you move the checkout or recreate its Python environment.

</details>

## Privacy

- Your chosen article or passage is sent through the local bridge to Fish Audio to generate speech.
- Your key stays in the local, Git-ignored `.env`; it is not bundled into the extension or Mac app.
- Saved text, URLs, progress, voice preferences, and diagnostics stay in this Chrome profile.
- Audio is buffered for the current session and is not saved for later playback.
- Optional detailed diagnostics contain reading text, so review exports before sharing them.
- Keep the bridge bound to `127.0.0.1`, and never commit keys, logs, or private diagnostics.

## Troubleshooting

| Problem | Try this |
| --- | --- |
| No player | Click the extension icon on a regular website; reload the extension and refresh the tab after updating. |
| Cannot connect | Open the Mac app or start the Terminal server; `curl http://127.0.0.1:4179/health` should return `{"status":"ok"}`. |
| Mac app cannot start | Check that the permanent checkout, `.venv`, and `.env` exist; use **View Log** and **Try Again**. |
| Fish Audio rejects a request | Check the key and account access, then restart Readflow. |
| Buffering at high speed | Lower the speed so speech generation can keep up. |
| Resume needs new audio | Keep Readflow running; saved reads store text and progress, not audio. |

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and bug reports.
CI checks the extension, browser playback, Python bridge, and native Mac app build without a real Fish key.

For the real-browser playback check, build the extension first:

```sh
CHROMIUM_PATH="/path/to/chrome" node tests/playback-browser.mjs
```

It uses synthetic audio and checks pause, word seeking, recovery, and selected-text listening.
Port 9224 must be free; this does not test live Fish Audio or Chrome's actual service-worker lifecycle.

## License

[MIT](LICENSE) for Readflow's original code.
Bundled dependencies retain their own licenses; see [third-party notices](extension/THIRD_PARTY_NOTICES.md).
