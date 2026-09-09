"""Environment integration tests never install into the repository's .venv."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import zipfile

MANAGER = Path(__file__).resolve().parents[1] / "python_environment.py"
spec = importlib.util.spec_from_file_location("python_environment", MANAGER)
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)


class EnvironmentTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.directory = self.root / ".venv"
        (self.directory / "bin").mkdir(parents=True)
        (self.directory / "bin/python").touch()
        (self.directory / "pyvenv.cfg").write_text("include-system-site-packages = false\n")
        (self.root / "pyproject.toml").write_text('[project]\ndependencies = ["demo>=1,<3"]\n')
        (self.root / "uv.lock").write_text('version = 1\n')
        environment = patch.dict(os.environ, {"VENV_DIR": str(self.directory),
                                             "PIPELINE_RUN_ID": "pipeline-1",
                                             "PIPELINE_STAGE_INVOCATION_ID": "invocation-1",
                                             "PIPELINE_AGENT_ATTEMPT": "2",
                                             "PIPELINE_PYTHON_SESSION_ID": "session-1"})
        environment.start()
        self.addCleanup(environment.stop)
        self.env = manager.Environment(self.root)
        self.live = {"python_version": "3.13.5", "executable": str(self.env.python),
                     "prefix": str(self.directory), "base_prefix": "/base-python",
                     "system_site_packages": False, "packages": [{"name": "demo", "version": "1"}]}
        probe = patch.object(self.env, "live_inventory", side_effect=lambda: dict(self.live))
        self.probe = probe.start()
        self.addCleanup(probe.stop)

    def records(self):
        return [json.loads(line) for line in (self.env.state / "changes.jsonl").read_text().splitlines()]

    def test_requirements_reject_install_options_paths_and_urls(self):
        for value in ["numpy", "demo[plot]>=1,<3", "scikit-learn~=1.9", "demo==1.0.*"]:
            self.assertEqual(manager.requirement(value), value)
        for value in ["--system", "-r", "../wheel", "file:///wheel", "demo @ https://example.com",
                      "git+https://example.com", "demo; echo bad", ""]:
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                manager.requirement(value)

    def test_guards_run_before_uv_mutations(self):
        for field, value in [("prefix", "/other"), ("base_prefix", str(self.directory)),
                             ("system_site_packages", True)]:
            with self.subTest(field=field), patch.dict(self.live, {field: value}), patch.object(self.env, "uv") as uv:
                with self.assertRaises(RuntimeError):
                    self.env.add(["demo"], "Guard test")
                uv.assert_not_called()
                self.assertEqual(self.records()[-1]["outcome"], "failure")

    def test_rejects_external_symlinked_or_missing_environments(self):
        with patch.object(self.env, "uv") as uv:
            self.env.directory = self.root / "other"
            with self.assertRaisesRegex(RuntimeError, "VENV_DIR"):
                self.env.sync()
            self.env.directory = self.directory
            shutil.rmtree(self.directory)
            self.directory.symlink_to(self.root, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "VENV_DIR"):
                self.env.sync()
            self.directory.unlink()
            self.directory.mkdir()
            with self.assertRaisesRegex(RuntimeError, "pyvenv.cfg"):
                self.env.sync()
            uv.assert_not_called()

    def test_uv_overrides_cannot_redirect_or_skip_installation(self):
        with patch.dict(os.environ, {"UV_PROJECT": "/other", "UV_PROJECT_ENVIRONMENT": "/other",
                                    "UV_PYTHON": "/system/python", "UV_NO_SYNC": "1",
                                    "UV_FROZEN": "1", "UV_CONFIG_FILE": "/other/uv.toml",
                                    "PYTHONPATH": "/injected", "VIRTUAL_ENV": "/other"}), \
                patch.object(manager.shutil, "which", return_value="/bin/uv"), \
                patch.object(manager.subprocess, "run") as run:
            self.env.uv("sync")
            args, kwargs = run.call_args
            self.assertEqual(args[0], ["/bin/uv", "sync", "--project", str(self.root)])
            self.assertEqual(kwargs["cwd"], self.root)
            env = kwargs["env"]
            self.assertEqual(env["UV_PROJECT_ENVIRONMENT"], str(self.directory))
            self.assertEqual(env["UV_PYTHON"], str(self.env.python))
            self.assertEqual(env["VIRTUAL_ENV"], str(self.directory))
            self.assertEqual(env["UV_PYTHON_DOWNLOADS"], "never")
            for key in ["UV_NO_SYNC", "UV_FROZEN", "UV_CONFIG_FILE", "UV_PROJECT", "PYTHONPATH"]:
                self.assertNotIn(key, env)

    def test_probe_ignores_pythonpath_and_user_site(self):
        with patch.object(manager.subprocess, "run", return_value=subprocess.CompletedProcess(
                [], 0, json.dumps(self.live), "")) as run:
            manager.Environment.live_inventory(self.env)
            self.assertEqual(run.call_args.args[0][:3], [str(self.env.python), "-I", "-c"])

    def test_health_comes_from_uv_including_markers_and_constraints(self):
        self.env.project.write_text('[project]\ndependencies = ["demo>=1,<3", "absent; python_version < \'3\'"]\n')
        for lock_status, sync_status in [(0, 0), (1, 0), (0, 1), (1, 1)]:
            with self.subTest(lock=lock_status, sync=sync_status), patch.object(self.env, "uv", side_effect=[
                subprocess.CompletedProcess([], lock_status, "", "lock stale"),
                subprocess.CompletedProcess([], sync_status, "", "environment drift"),
            ]) as uv:
                inventory = self.env.inspect()
                self.assertEqual(inventory["healthy"], lock_status == sync_status == 0)
                self.assertEqual(inventory["declared_dependencies"], self.env.declared())
                self.assertEqual(inventory["managed_packages"], self.live["packages"],
                                 "already-running sessions still need the derived compatibility field")
                self.assertNotIn("missing_defaults", inventory)
                self.assertEqual(uv.call_args_list[0].args, ("lock", "--check"))
                self.assertEqual(uv.call_args_list[1].args, ("sync", "--check", "--frozen"))
                if lock_status:
                    self.assertIn("lock stale", inventory["dependency_errors"])
                if sync_status:
                    self.assertIn("environment drift", inventory["dependency_errors"])

    def test_ensure_never_repairs_a_running_environment(self):
        with patch.object(self.env, "inspect", return_value={"healthy": False, "dependency_errors": "drift"}), \
                patch.object(self.env, "sync") as sync:
            with self.assertRaisesRegex(RuntimeError, "no runs"):
                self.env.ensure()
            sync.assert_not_called()

    def test_change_records_reasons_identity_and_transitive_updates(self):
        project_before = self.env.project.read_bytes()

        def uv(*args, **kwargs):
            if "--upgrade-package" in args:
                self.assertEqual(self.records()[-1]["outcome"], "started")
                self.assertEqual(args, ("sync", "--upgrade-package", "demo"))
                self.live["packages"] = [{"name": "demo", "version": "2"}, {"name": "helper", "version": "1"}]
                self.env.lock.write_text('version = 2\n')
            return subprocess.CompletedProcess([], 0, "", "")

        with patch.object(self.env, "uv", side_effect=uv):
            self.env.update(["demo"], "Need the compatible fix")
        start, end = self.records()
        self.assertEqual(start["operation_id"], end["operation_id"])
        self.assertEqual(end["outcome"], "success")
        self.assertEqual(end["reason"], "Need the compatible fix")
        self.assertEqual(end["pipeline_run_id"], "pipeline-1")
        self.assertEqual(end["stage_invocation_id"], "invocation-1")
        self.assertEqual(end["attempt"], "2")
        self.assertEqual(end["session_id"], "session-1")
        self.assertEqual(end["package_changes"], [{"name": "demo", "before": "1", "after": "2"},
                                                   {"name": "helper", "before": None, "after": "1"}])
        self.assertNotEqual(end["before"]["lock_sha256"], end["after"]["lock_sha256"])
        self.assertEqual(self.env.project.read_bytes(), project_before)

    def test_failed_install_captures_partial_changes(self):
        def fail(*args, **kwargs):
            self.live["packages"] = []
            self.env.project.write_text('[project]\ndependencies = ["demo>=2"]\n')
            raise subprocess.CalledProcessError(1, ["uv", "add"], stderr="installation failed")

        with patch.object(self.env, "uv", side_effect=fail), self.assertRaisesRegex(RuntimeError, "installation failed"):
            self.env.add(["demo>=2"], "Need a newer API")
        end = self.records()[-1]
        self.assertEqual(end["outcome"], "failure")
        self.assertNotEqual(end["before"]["project_sha256"], end["after"]["project_sha256"])
        self.assertEqual(end["package_changes"], [{"name": "demo", "before": "1", "after": None}])

    def test_rejects_empty_reason_and_invalid_packages_before_uv(self):
        with patch.object(self.env, "uv") as uv:
            for packages, reason in [(["demo"], "  "), ([], "why"), (["--system"], "why")]:
                with self.subTest(packages=packages), self.assertRaises((ValueError, argparse.ArgumentTypeError)):
                    self.env.update(packages, reason)
            uv.assert_not_called()


UV = shutil.which("uv") or str(MANAGER.parents[2] / ".devbox/nix/profile/default/bin/uv")


@unittest.skipUnless(Path(UV).is_file(), "uv is required for the offline resolver integration test")
class ResolverIntegrationTests(unittest.TestCase):
    def test_offline_compatible_update_drift_and_conflict(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            wheels = root / "wheels"
            wheels.mkdir()

            def wheel(name, version, requires=()):
                with zipfile.ZipFile(wheels / f"{name}-{version}-py3-none-any.whl", "w") as archive:
                    info = f"{name}-{version}.dist-info"
                    archive.writestr(f"{info}/METADATA", f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n" +
                                     "".join(f"Requires-Dist: {value}\n" for value in requires))
                    archive.writestr(f"{info}/WHEEL", "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
                    archive.writestr(f"{info}/RECORD", "")

            wheel("demo", "1.0", ["helper>=1,<3"])
            wheel("helper", "1.0")
            project = root / "pyproject.toml"
            project.write_text('[project]\nname = "fixture"\nversion = "0.1"\nrequires-python = ">=3.13"\n'
                               'dependencies = ["demo>=1,<3", "absent; python_version < \'3\'"]\n'
                               '[tool.uv]\npackage = false\nno-index = true\nfind-links = ["./wheels"]\n'
                               f'cache-dir = "{root}/cache"\n')
            subprocess.run([sys.executable, "-I", "-m", "venv", "--without-pip", str(root / ".venv")], check=True)
            with patch.dict(os.environ, {"VENV_DIR": str(root / ".venv")}), \
                    patch.object(manager.shutil, "which", return_value=str(Path(UV).resolve())):
                env = manager.Environment(root)
                self.assertTrue(env.sync()["healthy"])
                original = project.read_bytes()
                wheel("demo", "2.0", ["helper>=2,<3"])
                wheel("helper", "2.0")
                wheel("demo", "3.0")
                updated = env.update(["demo"], "Exercise compatible upgrades")
                self.assertTrue(updated["healthy"])
                self.assertIn({"name": "demo", "version": "2.0"}, updated["packages"])
                self.assertIn({"name": "helper", "version": "2.0"}, updated["packages"])
                self.assertEqual(project.read_bytes(), original)
                locked = env.lock.read_bytes()
                with self.assertRaises(RuntimeError):
                    env.update(["demo==3.0"], "Exercise an incompatible request")
                self.assertEqual(env.lock.read_bytes(), locked)
                self.assertEqual(project.read_bytes(), original)
                # Introduce an undeclared distribution without using pip.
                site = next((root / ".venv/lib").glob("python*/site-packages"))
                extra = site / "unexpected-1.0.dist-info"
                extra.mkdir()
                (extra / "METADATA").write_text("Metadata-Version: 2.1\nName: unexpected\nVersion: 1.0\n")
                drift = env.inspect()
                self.assertTrue(drift["lock_current"])
                self.assertFalse(drift["environment_matches_lock"])
                with self.assertRaises(RuntimeError):
                    env.ensure()
                self.assertTrue(extra.exists(), "readiness checks must not remove packages")
                project.write_text(project.read_text().replace("demo>=1,<3", "demo>=3"))
                self.assertFalse(env.inspect()["lock_current"])
                config = root / ".venv/pyvenv.cfg"
                config.write_text(config.read_text().replace("include-system-site-packages = false",
                                                            "include-system-site-packages\t=\ttrue"))
                with self.assertRaisesRegex(RuntimeError, "system site-packages"):
                    env.check_environment()


if __name__ == "__main__":
    unittest.main()
