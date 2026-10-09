import importlib.util
from pathlib import Path
import plistlib
import unittest


spec = importlib.util.spec_from_file_location("bridge_service", Path(__file__).resolve().parents[1] / "scripts/bridge-service.py")
service = importlib.util.module_from_spec(spec)
spec.loader.exec_module(service)


class BridgeServiceTests(unittest.TestCase):
    def test_service_uses_absolute_arguments_and_loopback_without_secrets(self):
        project = Path("/Users/test/Readflow project")
        logs = Path("/Users/test/Library/Logs/Readflow")
        config = plistlib.loads(plistlib.dumps(service.service_config(project, logs)))
        self.assertEqual(config["WorkingDirectory"], str(project))
        self.assertEqual(config["ProgramArguments"][0], str(project / ".venv/bin/python"))
        self.assertEqual(config["ProgramArguments"][-4:], ["--host", "127.0.0.1", "--port", "4179"])
        self.assertTrue(config["RunAtLoad"])
        self.assertTrue(config["KeepAlive"])
        self.assertNotIn("EnvironmentVariables", config)
        self.assertEqual(config["StandardErrorPath"], str(logs / "bridge-error.log"))
