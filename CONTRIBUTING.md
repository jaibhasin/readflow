# Contributing to Readflow

Readflow is a local Chrome extension with a Python speech bridge.
Start with the [README](README.md) for setup and the [project plan](PLAN.md) for the architecture.

## Development

Keep changes focused and use clear names and short functions.
Add unit tests for new behavior and regressions.
Do not commit `.env`, API keys, generated extension assets, or diagnostics containing private reading text.
Preserve the bundled [third-party notices](extension/THIRD_PARTY_NOTICES.md).

From the repository root, install the locked dependencies and run the checks:

```sh
npm ci
uv sync --locked
npm run check
npm run build
node --experimental-strip-types --test tests/*.test.mjs
uv run --no-sync python -m unittest discover -s tests -p 'test_*.py'
git diff --check
```

After rebuilding, reload Readflow at `chrome://extensions` and refresh the article tab.
For player or highlighting changes, check the behavior on an actual article page with the bridge running.
GitHub Actions runs the automated checks on pushes and pull requests without a Fish Audio key.
The synthetic browser check is documented in the [README](README.md#development).

## Reporting bugs

[Open an issue](https://github.com/jaibhasin/readflow/issues) with the steps to reproduce, what you expected, and what happened.
Include your browser version, operating system, and an article URL if it is public.
For audio issues, include the playback speed and whether you were listening to an article or a selection.
Review screenshots and exported diagnostics for private text before attaching them.
Never include your API key.
