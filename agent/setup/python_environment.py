#!/usr/bin/env python3
"""Manage the pipeline's Python environment through uv.

`pyproject.toml` declares what the pipeline depends on and `uv.lock` records the
resolved transitive graph with hashes. This script delegates dependency resolution
to uv and adds:

- an audit trail in `changes.jsonl` recording dependency changes, reasons, and which
  pipeline run asked for it, and
- a guard that refuses to touch anything other than Devbox's `VENV_DIR`.

`inspect` still enumerates the live environment rather than reading a cached
file, and reports whether the lockfile and the installed set still agree.
"""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tomllib
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]


def requirement(value):
    # Named PyPI requirements only. No pip options, URLs, local paths, or VCS code.
    pattern = r"[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9_,.-]+\])?(?:(?:==|!=|~=|>=|<=|>|<)[A-Za-z0-9.*+!_-]+(?:\.[A-Za-z0-9.*+!_-]+)*(?:,(?:==|!=|~=|>=|<=|>|<)[A-Za-z0-9.*+!_-]+(?:\.[A-Za-z0-9.*+!_-]+)*)?)?"
    if not re.fullmatch(pattern, value):
        raise argparse.ArgumentTypeError("Use a package name or version constraint, not a URL, path, or pip option")
    return value


def normalize(name):
    return re.sub(r"[-_.]+", "-", name.lower())


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class Environment:
    def __init__(self, root=ROOT):
        self.root = Path(root).resolve()
        self.directory = Path(os.environ.get("VENV_DIR", self.root / ".venv"))
        if not self.directory.is_absolute():
            self.directory = self.root / self.directory
        self.python = self.directory / "bin" / "python"
        self.state = self.root / "agent" / "runtime" / "python"
        self.project = self.root / "pyproject.toml"
        self.lock = self.root / "uv.lock"

    @contextmanager
    def installation_lock(self, shared=False):
        self.state.mkdir(parents=True, exist_ok=True)
        with (self.state / ".install.lock").open("a") as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_SH if shared else fcntl.LOCK_EX)
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def check_environment(self):
        expected = self.root / ".venv"
        if self.directory.resolve() != expected or expected.is_symlink():
            raise RuntimeError(f"VENV_DIR must identify this project's Devbox environment: {expected}")
        if not (self.directory / "pyvenv.cfg").is_file():
            raise RuntimeError("Devbox environment is missing pyvenv.cfg; run devbox run python-setup")
        if not self.python.exists():
            raise RuntimeError(f"Devbox Python is not ready at {self.python}; run devbox run python-setup")
        # Verify the interpreter before uv can install, replace, or remove anything.
        result = self.live_inventory()
        if (Path(result["prefix"]).resolve() != expected
                or Path(result["base_prefix"]).resolve() == expected):
            raise RuntimeError("Refusing to inspect or modify a different or non-virtual Python environment")
        if result["system_site_packages"]:
            raise RuntimeError("Devbox Python must not include system site-packages")
        return result

    def live_inventory(self):
        code = (
            "import importlib.metadata as m,json,sys,platform,pathlib; "
            "cfg=pathlib.Path(sys.prefix,'pyvenv.cfg'); "
            "print(json.dumps({'python_version':platform.python_version(),"
            "'executable':sys.executable,'prefix':sys.prefix,'base_prefix':sys.base_prefix,"
            "'system_site_packages':any(k.strip().lower() == 'include-system-site-packages' "
            "and v.strip().lower() == 'true' for k,sep,v in "
            "(line.partition('=') for line in cfg.read_text().splitlines())) if cfg.exists() else True,"
            "'packages':sorted([{'name':d.metadata['Name'],'version':d.version} "
            "for d in m.distributions()],key=lambda p:(p['name'].lower(),p['version']))}))"
        )
        completed = subprocess.run([str(self.python), "-I", "-c", code], cwd=self.root,
                                   capture_output=True, text=True, check=True)
        return json.loads(completed.stdout)

    def uv(self, *args, check=True):
        """Run uv against Devbox's virtualenv, never a uv-managed one."""
        executable = shutil.which("uv")
        if not executable:
            raise RuntimeError("uv is not on PATH; it is a Devbox package, so enter the Devbox shell")
        # Project configuration controls uv. Do not inherit flags that redirect,
        # skip, or broaden a sync, or Python paths from an agent's shell.
        environment = {
            **{key: value for key, value in os.environ.items()
               if not key.startswith(("UV_", "PYTHON"))},
            "UV_PROJECT_ENVIRONMENT": str(self.directory),
            "UV_PYTHON": str(self.python),
            "UV_PYTHON_DOWNLOADS": "never",
            "UV_PYTHON_PREFERENCE": "only-system",
            "VIRTUAL_ENV": str(self.directory),
        }
        return subprocess.run([executable, *args, "--project", str(self.root)], cwd=self.root, env=environment,
                              capture_output=True, text=True, check=check)

    def declared(self):
        """Direct dependencies from pyproject.toml: what the pipeline relies on."""
        with self.project.open("rb") as handle:
            document = tomllib.load(handle)
        return document["project"].get("dependencies", [])

    def inspect(self, locked=False):
        """Enumerate the live environment. Never reads a cached inventory."""
        if not locked:
            with self.installation_lock(shared=True):
                return self.inspect(locked=True)
        result = self.check_environment()
        declared = self.declared()
        # Two different questions: does the lock still match pyproject.toml, and
        # does the installed environment still match the lock. Either can drift
        # if someone edits a file or installs a package outside uv.
        lock_check = self.uv("lock", "--check", check=False)
        synced = self.uv("sync", "--check", "--frozen", check=False)
        result.update({
            "schema_version": 1,
            "declared_dependencies": declared,
            "project_sha256": self.file_hash(self.project),
            "lock_sha256": self.file_hash(self.lock),
            "lock_current": lock_check.returncode == 0,
            "environment_matches_lock": synced.returncode == 0,
            "dependency_errors": "\n".join((r.stdout + r.stderr).strip()
                                             for r in (lock_check, synced) if r.returncode != 0),
        })
        # uv evaluates version constraints, extras, and platform markers.
        result["healthy"] = result["lock_current"] and result["environment_matches_lock"]
        # Already-running sessions still consume this field. Derive it from the
        # declarations so their next inspection works without a second inventory.
        direct_names = {normalize(re.split(r"[\[<>=!~; @]", entry)[0]) for entry in declared}
        result["managed_packages"] = [p for p in result["packages"] if normalize(p["name"]) in direct_names]
        result["fingerprint"] = digest({"python_version": result["python_version"], "packages": result["packages"]})
        return result

    @staticmethod
    def file_hash(path):
        return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None

    def snapshot(self):
        inventory = self.check_environment()
        return {"packages": inventory["packages"], "python_version": inventory["python_version"],
                "project_sha256": self.file_hash(self.project), "lock_sha256": self.file_hash(self.lock),
                "declared_dependencies": self.declared()}

    def record_change(self, operation_id, action, packages, reason, outcome, before, after=None, error=None):
        """The audit trail uv does not keep: why, and on whose behalf."""
        event = {"schema_version": 1, "operation_id": operation_id,
                 "time": datetime.now(timezone.utc).isoformat(),
                 "action": action, "requested_packages": packages, "reason": reason,
                 "outcome": outcome, "before": before, "after": after,
                 "pipeline_run_id": os.environ.get("PIPELINE_RUN_ID"),
                 "stage_invocation_id": os.environ.get("PIPELINE_STAGE_INVOCATION_ID"),
                 "attempt": os.environ.get("PIPELINE_AGENT_ATTEMPT"),
                 "session_id": os.environ.get("PIPELINE_PYTHON_SESSION_ID")}
        if before is not None and after is not None:
            old = {normalize(p["name"]): p["version"] for p in before["packages"]}
            new = {normalize(p["name"]): p["version"] for p in after["packages"]}
            event["package_changes"] = [{"name": name, "before": old.get(name), "after": new.get(name)}
                                        for name in sorted(old.keys() | new.keys()) if old.get(name) != new.get(name)]
        if error:
            event["error"] = error
        self.state.mkdir(parents=True, exist_ok=True)
        with (self.state / "changes.jsonl").open("a", encoding="utf8") as handle:
            handle.write(json.dumps(event) + "\n")
            handle.flush()
            os.fsync(handle.fileno())

    def sync(self):
        """Make the environment match the lock exactly."""
        return self.change("setup", [], "Sync declared dependencies and uv.lock", ["sync"])

    def add(self, packages, reason):
        """Add packages through uv so pyproject.toml and uv.lock move together."""
        return self.change("add", packages, reason, ["add", *packages])

    def update(self, packages, reason):
        """Update selected resolutions within pyproject.toml's constraints."""
        return self.change("update", packages, reason,
                           ["sync", *[arg for package in packages for arg in ("--upgrade-package", package)]])

    def change(self, action, packages, reason, command):
        packages = [requirement(value) for value in packages]
        if action != "setup" and not packages:
            raise ValueError("Name at least one package")
        if not reason.strip():
            raise ValueError("A non-empty reason is required")
        with self.installation_lock():
            operation_id = str(uuid4())
            before = None
            try:
                before = self.snapshot()
                # A durable request survives interruption during uv execution.
                self.record_change(operation_id, action, packages, reason, "started", before)
                result = self.uv(*command)
                print(result.stderr, end="", file=sys.stderr)
                inventory = self.inspect(locked=True)
                if not inventory["healthy"]:
                    raise RuntimeError(f"Environment check failed: {inventory['dependency_errors']}")
                self.record_change(operation_id, action, packages, reason, "success", before, self.snapshot())
                return inventory
            except Exception as error:
                # Installation can fail after files or packages changed. Capture
                # the actual state instead of claiming the request was atomic.
                message = _message(error)
                try:
                    after = self.snapshot()
                except Exception:
                    after = None
                self.record_change(operation_id, action, packages, reason, "failure", before, after, message)
                raise RuntimeError(message) from error

    def ensure(self):
        """Check startup without changing packages underneath an ongoing run."""
        inventory = self.inspect()
        if not inventory["healthy"]:
            raise RuntimeError(f"{inventory['dependency_errors']}\nRun devbox run python-setup when no runs are using the environment")
        return inventory


def _message(error):
    message = str(error)
    if isinstance(error, subprocess.CalledProcessError):
        message += "\n" + (error.stdout or "") + (error.stderr or "")
    return message.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("setup", help="resolve declared dependencies and sync the environment")
    commands.add_parser("ensure", help="check readiness without changing the environment")
    inspect = commands.add_parser("inspect", help="report the live environment")
    inspect.add_argument("--json", action="store_true")
    add = commands.add_parser("add", help="add a package through uv")
    add.add_argument("packages", nargs="+", type=requirement)
    add.add_argument("--reason", required=True)
    update = commands.add_parser("update", help="update packages within declared constraints")
    update.add_argument("packages", nargs="+", type=requirement)
    update.add_argument("--reason", required=True)
    args = parser.parse_args()
    environment = Environment()
    try:
        if args.command == "setup":
            inventory = environment.sync()
        elif args.command == "ensure":
            inventory = environment.ensure()
        elif args.command == "add":
            inventory = environment.add(args.packages, args.reason)
        elif args.command == "update":
            inventory = environment.update(args.packages, args.reason)
        else:
            inventory = environment.inspect()
        if args.command == "inspect" and args.json:
            print(json.dumps(inventory, indent=2))
        else:
            print(f"[python-environment] Devbox Python {inventory['python_version']}: "
                  f"{len(inventory['packages'])} packages, healthy={inventory['healthy']}. "
                  f"Declared in {environment.project}, locked in {environment.lock}")
    except (RuntimeError, subprocess.SubprocessError, OSError, ValueError) as error:
        print(f"[python-environment] {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
