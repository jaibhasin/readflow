from pathlib import Path
import socket
import subprocess
import sys
import time
import unittest
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1]


class AppRunnerTests(unittest.TestCase):
    def test_bridge_stops_when_app_pipe_closes(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        process = subprocess.Popen(
            [sys.executable, str(ROOT / "macos/bridge_runner.py"), "--project", str(ROOT), "--port", str(port)],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        try:
            ready = False
            for _ in range(100):
                if process.poll() is not None:
                    break
                try:
                    with urlopen(f"http://127.0.0.1:{port}/health", timeout=0.2) as response:
                        ready = response.read() == b'{"status":"ok"}'
                        break
                except (URLError, TimeoutError):
                    time.sleep(0.05)
            self.assertTrue(ready, "app-owned bridge starts and serves health")
            process.stdin.close()
            self.assertEqual(process.wait(timeout=6), 0, process.stderr.read().decode())
            with socket.socket() as connection:
                connection.settimeout(0.2)
                self.assertNotEqual(connection.connect_ex(("127.0.0.1", port)), 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            process.stderr.close()
