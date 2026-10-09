import importlib.util
from pathlib import Path
import plistlib
import unittest


spec = importlib.util.spec_from_file_location("build_mac_app", Path(__file__).resolve().parents[1] / "scripts/build-mac-app.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class MacAppTests(unittest.TestCase):
    def test_bundle_points_to_permanent_project_without_keys_or_login_startup(self):
        project = Path("/Users/test/Readflow project")
        metadata = plistlib.loads(plistlib.dumps(builder.app_metadata(project)))
        self.assertEqual(metadata["ReadflowProjectDirectory"], str(project))
        self.assertEqual(metadata["CFBundleExecutable"], "Readflow")
        self.assertEqual(metadata["CFBundleIdentifier"], "com.readflow.app")
        self.assertNotIn("LSUIElement", metadata)
        self.assertNotIn("LSEnvironment", metadata)

    def test_builder_rejects_unrelated_output_before_writing(self):
        with self.assertRaisesRegex(ValueError, "Readflow.app"):
            builder.build_app(Path("/missing"), Path("/tmp/Another.app"))
