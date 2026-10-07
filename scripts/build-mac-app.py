import argparse
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[1]


def app_metadata(project: Path) -> dict:
    return {
        "CFBundleName": "Readflow",
        "CFBundleDisplayName": "Readflow",
        "CFBundleIdentifier": "com.readflow.app",
        "CFBundleExecutable": "Readflow",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": "0.1.0",
        "CFBundleVersion": "1",
        "LSMinimumSystemVersion": "13.0",
        "NSHighResolutionCapable": True,
        "ReadflowProjectDirectory": str(project),
    }


def build_app(project: Path, output: Path) -> None:
    if output.name != "Readflow.app":
        raise ValueError("The output must be named Readflow.app.")
    if not (project / "bridge/main.py").is_file() or not (project / ".venv/bin/python").is_file():
        raise ValueError("Choose a permanent Readflow checkout with uv sync completed.")
    if not (project / ".env").is_file():
        raise ValueError("Configure the project's .env before installing the app.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".readflow-app-", dir=output.parent) as temporary:
        staging = Path(temporary) / "Readflow.app"
        contents = staging / "Contents"
        executable = contents / "MacOS/Readflow"
        resources = contents / "Resources"
        executable.parent.mkdir(parents=True)
        resources.mkdir()
        with (contents / "Info.plist").open("wb") as metadata:
            plistlib.dump(app_metadata(project), metadata)
        shutil.copy2(ROOT / "macos/bridge_runner.py", resources / "bridge_runner.py")
        subprocess.run([
            "xcrun", "swiftc", "-parse-as-library", "-swift-version", "5", "-O",
            "-target", f"{subprocess.check_output(['uname', '-m'], text=True).strip()}-apple-macosx13.0",
            "-framework", "AppKit", "-module-cache-path", str(Path(temporary) / "swift-cache"),
            str(ROOT / "macos/Readflow.swift"), "-o", str(executable),
        ], check=True)
        subprocess.run(["codesign", "--force", "--sign", "-", str(staging)], check=True)
        if output.exists():
            with (output / "Contents/Info.plist").open("rb") as existing:
                if plistlib.load(existing).get("CFBundleIdentifier") != "com.readflow.app":
                    raise ValueError("Refusing to replace an app with a different bundle identifier.")
            backup = output.with_name("Readflow.previous.app")
            if backup.exists():
                raise ValueError(f"Move the previous backup first: {backup}")
            output.rename(backup)
        try:
            staging.rename(output)
        except OSError:
            backup = output.with_name("Readflow.previous.app")
            if backup.exists() and not output.exists():
                backup.rename(output)
            raise
    print(f"Installed {output}")
    print("Open Readflow to start listening. Quit it to stop its server.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a local Readflow app for macOS.")
    parser.add_argument("--project", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path, default=ROOT / "build/macos/Readflow.app")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("Building the app requires macOS and Xcode Command Line Tools.")
    try:
        build_app(args.project.expanduser().resolve(), args.output.expanduser().resolve())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
