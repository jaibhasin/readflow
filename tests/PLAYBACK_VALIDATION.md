# Pitch-preserving playback validation

Validated on 2026-10-03 in the Readflow worktree.

- `npm run check` and `npm run build` passed.
- `node --experimental-strip-types --test tests/*.test.mjs` passed all 27 tests.
- `/Users/jaibhasin/Desktop/readflow/.venv/bin/python -m unittest discover -s tests -p 'test_*.py'` passed both bridge tests.

The DSP tests cover pitch and duration at every available speed, identical output across network chunk boundaries, exact original samples at 1×, short audio, and the final voiced tail.
A 220 Hz input stayed within 2 Hz at speeds from 0.75× through 3× in the synthetic signal tests.
The text section tests verify ordered, lossless splitting, bounded long sections, and exact source offsets.
Type checking, production build, all 33 JavaScript tests, and both bridge unit tests passed after adding parallel section requests.
A local macOS speech sample lasted 12.937 seconds originally and 9.241 seconds at 1.4×.
Autocorrelation measurements on 47 matched voiced windows found a median pitch of 149 Hz originally and 150 Hz after processing, with a median shift of zero semitones.
These measurements establish pitch behavior, not subjective voice quality at 2× or 3×.

A temporary local browser fixture ran the built `dist/content.js` with real Web Audio and a controlled PCM stream in place of the extension port.
Four seconds of source audio produced 2.857 seconds of scheduled output at 1.4×.
Every scheduled AudioBufferSourceNode retained playbackRate 1.
Pause/resume, replay, changing speed while paused, forward seeking into cached audio, and waiting for unreceived audio were exercised without another stream request.
The pending forward seek displayed buffering at the requested target and resumed after sufficient audio arrived.
The browser reported no console errors.

The fixture does not establish Chrome extension installation, live Fish service behavior, or subjective listening quality through the user's output device.
Load this worktree's `dist/` folder in Chrome, refresh the article tab, and compare the same voice at 1×, 1.2×, and 1.4× for a final listening check.

## Reconnection and word seeking

Validated on 2026-10-04 on branch `fix/reconnect-and-double-click-seek`.

Type checking, the production build, all 62 JavaScript unit tests, both Python bridge tests, and `git diff --check` passed.
The new source-location tests cover repeated paragraphs, navigation exclusions, inline formatting, collapsed whitespace, stale nodes, selection boundaries, and original offsets after starting mid-article.
The session test simulates ten minutes without content-script messages and verifies worker API activity before Chrome's 30-second idle cutoff and cleanup on disconnect.

`node tests/playback-browser.mjs` passed in Chromium with the built content script, real Web Audio, synthetic PCM, and a controlled extension port.
It verifies a 45-second frozen-tab pause, cached word seeking without a new speech request, an uncached word starting a request at that word, recovery preserving the current word and pause state, a bounded retry, selected-text listening, seek-listener cleanup, and cached playback after stream completion and disconnect.

The environment's administrator policy blocks loading unpacked extensions, so these browser checks simulate the port rather than testing an installed extension's worker.
Actual worker lifecycle behavior and live Fish Audio still need a check in the user's installed Chrome extension.

After merging the newer saved-reading, voice-switching, and auto-scroll changes from `main`, the JavaScript suite runs with Node's default isolation so Chrome mocks remain local to each test file.
Additional playback regressions cover cached seeking after a saved resume, seeking backward into earlier article text, and reconnecting at the absolute article offset while preserving pause state.

## Accurate saved reading after a paragraph jump

Validated on 2026-10-04 on branch `codex/fix-resume-reading`.

`npm run check`, `npm run build`, `node --experimental-strip-types --test tests/*.test.mjs`, both Python bridge tests, and `git diff --check` passed.
The JavaScript suite contains 104 passing tests.
New regressions cover jumping two paragraphs ahead and reopening the article at the audible word, resuming without repeating its sentence, saving a rewind to the beginning, saving before a hidden tab throttles animation frames, and exact later-section checkpoints when earlier audio has no word timestamps.

A temporary fixture ran the built content script in isolated Google Chrome with real Web Audio, synthetic PCM, a controlled extension port, and the bundled reading-list store persisted across reloads.
It verified jumping from the first paragraph to a word two paragraphs ahead, pausing and saving there, reloading the page, resuming from the exact saved word, and highlighting the jumped-to paragraph.
Rewinding the resumed audio to its beginning and resuming again in the same tab preserved its original article offset.
The fixture used separate local ports so the running Fish Audio bridge was unaffected.

These checks do not establish installed-extension worker behavior or live Fish Audio playback.
Load this worktree's `dist/` in Chrome, reload the extension, refresh the article, and repeat the paragraph-jump and resume flow for a live provider check.
