# Solve filesystem boundary

Solve's file tools and shell, factory validation, custom fold code, training
workers, search fits and champion reruns run under bubblewrap on Linux. Each gets
new user, mount, PID, IPC and UTS namespaces, dropped capabilities, a private
`/proc` and `/dev`, and an environment allowlist excluding provider credentials.
The host filesystem root, home directories, host `/proc`, host `/tmp`, `.env`,
full training archive/labels, sealed IDs and other tasks' data are not mounted.
Absolute paths, symlinks and `/proc/1/root` therefore cannot reach those files.

The agent receives the development archive, unlabelled test archive, development
manifest, task prompt and selected research, all at their original absolute paths.
Pcap descriptors retain their original paths too. Its persistent scratch and
agent-provided evidence live in `runs/<task>/solve/agent/`. Shared `solutions/`
remains writable for reusable code and git history; runtime Python notes are
writable. File edit/write tools reject writes outside those persistent roots.
Shell commands also get a private temporary filesystem: files created outside
mounted persistent roots are transient and vanish after that tool call. In
particular, truncated bash full-output files under `/tmp` are transient; redirect
important logs into the agent workspace. System runtimes, project `.venv`, its
managed interpreter, editable `libs/smartlab-eval`, JS dependencies, declarations
and lockfile are mounted read-only. No separate Python environment is created.

`python_environment` is an observed trusted controller service for inspect,
add and update. It passes structured arguments to the existing manager, preserves
its project-environment and named-PyPI checks, records originating pipeline,
invocation, attempt and Python-session IDs, and uses project `.tools/` caches.
Cancellation/timeout stops its detached process group, including uv descendants.
Use it for dependency changes; the sandbox's manager shell path is read-only.

The trusted training receipt runner stays outside the namespace; only its child
that loads agent code is sandboxed. Bubblewrap does not create a new host process
group, so existing supervisor sampling, stop and ownership verification still
cover it. The worker gets only its own trial output directory writable; source
worktrees and base mounts are read-only. Its subprocesses inherit the namespace,
including champion reruns and joblib children. A stopped namespace also removes
its descendants. A declared boundary fingerprint covers mounts, writability,
safe environment, cwd, bubblewrap path and both sandbox source hashes. It joins
`service.frameworkHash`, which is persisted in recovery metadata and checked
before retrying a dead worker. A changed policy cannot silently resume a trial.
The shared reporter records the fingerprint and supplied filesystem roots.

Whole-chain and standalone solve preflight requires bubblewrap, working user/
mount/PID namespaces, shell/git/rg/fd/uv and registered prompts. It fails closed
before any agent starts. No host configuration is changed. Bubblewrap may be
found on PATH, via `SOLVE_BWRAP`, or among existing Nix store packages. The target
SmartLab VM has not been checked offline; it needs this capability before solve
can run there.

This is a filesystem/data boundary, not a network sandbox. Network access is
shared to preserve normal agent functionality; web search and experiment status
remain observed trusted controller tools. The controller, dependency manager and
installed runtime libraries are trusted. Code and the scorer still share one
Python process inside the development-data boundary; this does not protect the
scorer from deliberately hostile code or make validation targets secret from
that code. Full labels and sealed sample bytes stay outside. Evaluation/refit
have separate existing policies; terminal refit intentionally fits all rows.
Selected research and shared reusable source are visible inputs, not scrubbed
for information a prior process deliberately copied into them.

Regression fixtures cover all file/shell tools, symlink and host-proc escapes,
factory/fit access attempts, multiprocessing fits, child-process cancellation,
changed-policy resume refusal, dependency-manager identity/group cancellation,
missing-prerequisite preflight, and ambient AGENTS marker exclusion.
