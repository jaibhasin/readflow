import argparse
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen


LABEL = "com.readflow.bridge"


def service_config(project: Path, logs: Path) -> dict:
    return {
        "Label": LABEL,
        "ProgramArguments": [
            str(project / ".venv/bin/python"), "-m", "uvicorn", "bridge.main:app",
            "--host", "127.0.0.1", "--port", "4179",
        ],
        "WorkingDirectory": str(project),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "StandardOutPath": str(logs / "bridge.log"),
        "StandardErrorPath": str(logs / "bridge-error.log"),
    }


def launchctl(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["/bin/launchctl", *args], check=check, capture_output=True, text=True)


def healthy() -> bool:
    try:
        with urlopen("http://127.0.0.1:4179/health", timeout=1) as response:
            return response.read() == b'{"status":"ok"}'
    except (URLError, TimeoutError, OSError):
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Manage Readflow's macOS background bridge.")
    parser.add_argument("action", choices=["install", "status", "uninstall"])
    parser.add_argument("--project", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This service uses macOS launchd.")
    project = args.project.expanduser().resolve()
    plist = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
    logs = Path.home() / "Library/Logs/Readflow"
    domain = f"gui/{os.getuid()}"
    service = f"{domain}/{LABEL}"
    loaded = launchctl("print", service, check=False).returncode == 0
    if args.action == "status":
        print(f"Service: {'loaded' if loaded else 'not loaded'}; bridge: {'healthy' if healthy() else 'unavailable'}")
        return
    if args.action == "uninstall":
        if loaded:
            launchctl("bootout", service)
        plist.unlink(missing_ok=True)
        print("Automatic startup removed. Logs and your API key are preserved.")
        return
    if not (project / "bridge/main.py").is_file() or not (project / ".venv/bin/python").is_file():
        parser.error("Choose a Readflow checkout with dependencies installed using uv sync.")
    if not (project / ".env").is_file():
        parser.error("Configure your Fish Audio key in the project's .env first.")
    if not loaded and healthy():
        parser.error("A bridge is already running on port 4179. Stop its terminal command, then install again.")
    if loaded:
        launchctl("bootout", service)
    plist.parent.mkdir(parents=True, exist_ok=True)
    logs.mkdir(parents=True, exist_ok=True)
    temporary = plist.with_suffix(".tmp")
    with temporary.open("wb") as output:
        plistlib.dump(service_config(project, logs), output)
    temporary.replace(plist)
    launchctl("bootstrap", domain, str(plist))
    for _ in range(50):
        if healthy():
            print("Readflow bridge is healthy. It starts at login and restarts automatically if it exits.")
            return
        time.sleep(0.2)
    raise SystemExit(f"Service installed but bridge did not become healthy. Check {logs / 'bridge-error.log'}")


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(error.stderr.strip() or "launchctl could not update the Readflow service.") from error
