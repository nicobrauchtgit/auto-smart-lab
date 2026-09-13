# Python environment for pipeline agents

Devbox owns the interpreter and the virtualenv. Its Python plugin creates this
project's `.venv`, exposed as `VENV_DIR`. uv owns the dependencies inside it.
There is no separate pipeline environment or container.

- `pyproject.toml` (repo root) declares what the pipeline depends on directly.
- `uv.lock` (repo root) records the full resolved graph with versions and hashes.
- `UV_PROJECT_ENVIRONMENT` points uv at Devbox's `.venv`, so uv never creates a
  second environment, and `UV_PYTHON_DOWNLOADS=never` stops it fetching its own
  interpreter.

`pyproject.toml` is the single source of declared dependencies. The lock records
resolved versions; inspection measures what is actually installed. File edits
and installs outside the manager can cause drift, which startup checks reject.
Do not maintain package inventories in Markdown or generated requirements files.

```bash
devbox run python-setup                       # resolve declarations and sync
uv tree --locked                             # read the dependency graph
python agent/setup/python_environment.py inspect --json
python agent/setup/python_environment.py add seaborn --reason "Plot feature distributions for spam1"
python agent/setup/python_environment.py update seaborn --reason "Use a compatible bug fix"
```

Inside the Devbox shell the same commands work without `devbox run`. Agents
receive the interpreter, declared dependencies, and both file paths in their
runtime prompt.

The Devbox startup hook sets `VIRTUAL_ENV` and prepends `$VENV_DIR/bin` to `PATH`
directly, so it works in Fish, Bash, and Zsh without sourcing a shell-specific
activation script.

Shell startup runs `ensure`, a read-only readiness check. Run setup explicitly
when the environment needs repair and no ongoing runs are using it. Setup keeps
existing locked versions where compatible; `update` requests newer resolutions
for selected packages within the declared constraints. Neither command changes
the interpreter or creates another pipeline environment.

## What the manager adds over plain uv

`agent/setup/python_environment.py` is a thin wrapper. It delegates resolution,
locking, and installation to uv, and adds:

- `changes.jsonl` records setup, add, and update requests with their reasons,
  pipeline run, stage invocation, attempt, and session identity. Each operation
  has a durable start record and a success or failure record with declaration
  and lock hashes, before/after inventories, and package version changes.
- Guards require `VENV_DIR` to identify this project's `.venv`, reject a symlinked
  environment or system site-packages, and check the interpreter's virtualenv
  prefix before uv can modify anything. uv receives explicit project and Python
  paths, with inherited uv overrides removed and Python downloads disabled.
- A shared file lock keeps inspections consistent with manager mutations and
  serializes installations. It does not lock arbitrary training processes or
  direct uv commands. Coordinate explicit changes with other active runs.

`inspect` enumerates the live environment with `importlib.metadata` rather than
reading a cached file, and reports two distinct drifts:

| Field | Meaning | Fix |
| --- | --- | --- |
| `lock_current` | `uv.lock` agrees with `pyproject.toml` | manager `setup` |
| `environment_matches_lock` | installed packages match `uv.lock` | manager `setup` |

`healthy` requires both. A package installed with raw `pip` sets
`environment_matches_lock` to false and is removed by the next explicit sync.
uv evaluates version constraints, extras, and platform markers; the manager does
not maintain a separate list of required packages.

## Shared records

- `changes.jsonl`: change requests, reasons, success or failure, and the
  invoking pipeline/stage/attempt identity when available.
- `NOTES.md`: agent-editable usage advice for later agents. Usage notes only;
  version claims belong in the lock.

The shared session runner inspects the real environment at startup, supplies the
declared requirements, and records typed environment input including file hashes
and both drift flags. At session completion, failure, or cancellation it imports
new audit records as `runtime_dependency_change` events, including reasons and
whether this session requested the change. It also records the final inventory
even when it has drifted. Audit read failures are explicit trace events.

An interrupted operation can have a start record without an outcome. uv may fail
after updating files or packages; the manager records the observed state rather
than assuming rollback. Do not truncate the audit history during active runs.

Run `npm test` and `npm run test:py` for the TypeScript and Python tests. Environment
tests use temporary fixtures and leave the project's installed packages alone.

`AGENTS.md` remains development guidance and is not loaded into pipeline agents.
Runtime instructions live in `agent/prompts/shared/python-environment.md`.

Local library availability does not establish what a remote submission server
can run. Check task-specific requirements before submitting executable code.
