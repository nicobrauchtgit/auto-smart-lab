# The experiment

This repository compares two arms under `harness/`: a minimal agent
(`harness/minimal/`) and the task-adapted harness (`harness/finetuned/`). Each arm
keeps its code, its configuration (`pipeline.config.json` at the top of its folder)
and its docs in its own folder; `experiment/` holds the switch, the run locations
and the boundary tests; run state goes to `runs/minimal/` and `runs/finetuned/`.
[docs/experiment.md](docs/experiment.md) has how to run each, what differs and what
must stay the same. Agents must not leave their run location, and neither arm may
read the other: keep the boundary tests passing. The sections below describe the
finetuned harness; paths in them are relative to `harness/finetuned/` unless they
start with `runs/`. `harness/minimal/CLAUDE.md` has the minimal arm's rules. Do not
add coaching to the minimal arm.

# Current state and next tasks

[docs/cleanup-plan.md](docs/cleanup-plan.md) is the work queue: current state,
open decisions and the prioritized packages. The finetuned design is
[expert-team-v2.md](harness/finetuned/docs/expert-team-v2.md), accepted
2026-11-11; its contract appendix is
[expert-team.md](harness/finetuned/docs/expert-team.md). Run project commands
through `./dev` (see that file).

# Harness development

The current code still runs the old design until P6 and P7 land: an LLM
orchestrator calling registered research, solve, evaluate, refit and submit
stages through `agent/pipeline/executor.ts`. Keep it working while it runs, and
follow [the pipeline integration contract](harness/finetuned/docs/pipeline-integration.md)
when changing it. Configured chains stop before submit; only an explicit
controller submission policy authorizes uploads.

New work follows expert-team-v2.md: one lead agent drives the run and calls
blocking scouts (data, ideas, validation); there is no LLM orchestrator and no
fixed stage chain. The agent's pipeline is any object with `fit`/`predict`
(`fit_predict` for batch clustering), declared in `solutions/tasks/<id>.py`
under `runs/finetuned/solutions/`. The agent chooses features, estimator,
hyperparameters and cross-validation scheme. The harness owns seeds, folds,
fits, predictions and measurements; harness-run trials are the measurement and
the only promotion evidence. Labels of the withheld rows never reach an agent;
they join training only at the terminal refit. Follow
[the harness-owned training contract](harness/finetuned/docs/harness-owned-training.md).
Add primitives and measurements, not constraints on model design.

Langfuse Cloud is the shared observability backend; JSONL is emergency-only.
Use `agent/telemetry/` and pipeline reporters, declare `observability` setup, and
preserve authoritative harness/recovery records. See [telemetry](harness/finetuned/docs/telemetry.md).
Record lifecycle, typed configuration and input metadata, results and every
agent session under shared run and invocation IDs. Standalone commands use the
same instrumented execution path. Never treat a finished agent session as
success: the harness validates the result.

`agent/pi_sdk.ts` is an observability experiment, not the main pipeline.

## Setup checks for new features

Every new stage, tool, provider, or integration must declare its prerequisites
in the shared preflight (`agent/pipeline/setup.ts` and the stage's
`setupRequirements`). Check required credentials, service access, unit/task
files, executables, and Python dependencies before any agent session starts.
Check the entire requested stage chain, including later stages, and use the same
path for standalone commands. Do not require credentials for unused features.

Keep checks bounded, non-destructive, and observable with the run/invocation
IDs. Report all local failures together with actionable setup instructions;
never log credential values, request headers, or raw provider errors. Prefer
read-only service probes; keep any model probe tiny and explicit. Add regression
tests proving missing/invalid prerequisites prevent stage execution. Update
these checks when adding a dependency rather than relying on a runtime agent
to discover missing setup. `--check-setup` runs the checks without starting agents.

## Pipeline Python dependencies

Use the finetuned harness's Python environment, exposed as `VENV_DIR` and stored in
`harness/finetuned/.venv`. Run commands through `./dev`, which keeps the pinned toolchain from
`mise.toml` (bun, uv, ripgrep, fd), uv's managed Python and all caches under
`.tools/`; never install tools into the user's home, shell configuration or Nix
profile. `./dev setup` creates the environment. Do not create a separate
pipeline environment. Dependencies are
declared in `pyproject.toml` and locked in `uv.lock`; uv keeps both in step with
the installed environment, and `uv sync` removes anything not in the lock. Never
install with raw `pip`. Manage additions through
`agent/setup/python_environment.py add <package> --reason <reason>`, which
delegates to `uv add` and records the reason and the requesting pipeline run. See
`agent/runtime/python/README.md` for the drift flags and setup details.

Runtime agents receive the shared Python prompt, the declared dependencies, and
the lockfile path explicitly. Keep that guidance separate from this development
AGENTS.md. Local research and modeling may use third-party Python libraries;
distinguish local availability from dependency restrictions of a remote task
execution environment.

## Development guidance stays out of pipeline context

This file instructs coding agents working on the repository. It is not a prompt
for the research, solver, evaluation, or future decision agents running inside
the pipeline.

- Keep automatic loading of repository and ancestor `AGENTS.md` and `CLAUDE.md`
  files disabled for every pipeline agent session. The shared session runner
  currently does this with `DefaultResourceLoader({ noContextFiles: true })`.
  Standalone module entry points must preserve the same setting.
- Supply runtime instructions through explicitly selected module prompts and
  typed task inputs. Do not copy development guidance into prompts, context
  bundles, or runtime workspaces, or reintroduce it through custom loaders or
  extensions.
- When changing session construction, add a regression test showing that a
  distinctive marker in a fixture `AGENTS.md` does not enter the assembled
  system prompt, while the selected module instructions still do.
- Disabling automatic context loading is not filesystem isolation. File and
  shell tools can still read accessible repository files. Do not claim these
  files are inaccessible without an enforced workspace or sandbox boundary.

## Prompt management

Keep authored agent instructions in a dedicated `agent/prompts/` folder,
organized by module. Prefer Markdown for prompt text, with a shared typed
registry and loader. An optional JSON manifest may describe prompt IDs, files,
and variables. Keep prompts in version control alongside their callers.

- Centralize system prompts, opening messages, validation feedback, retry
  instructions, and tool descriptions we control. Do not scatter instruction
  strings through runners or other application code.
- Reference prompts by stable IDs such as `research.start`. Supply task IDs,
  paths, measured dataset context, and validation errors as typed data. Reject
  missing files and missing or unexpected template variables before starting
  an agent.
- Keep opening prompts stable across runs and attempts. Let the agent inspect
  workspace state; existing work is prior work, not proof of correctness. After
  a failed attempt, supply the failed checks as factual feedback without
  changing the underlying task.
- Resolve prompt templates once per run and reuse that snapshot across attempts.
  Record prompt IDs, template content hashes, and rendered-message hashes in
  observability alongside the captured messages. Keep prompt identity separate
  from typed input metadata so comparisons can distinguish instruction changes
  from context changes.
- Test template loading and rendering, including invalid variables and
  representative inputs. Evaluate consequential instruction changes against
  fixed tasks.

Module runners now use `agent/prompts/`; see its README for loading, trace
metadata, and compatibility details. The old `agent/instructions/` files are
retained unchanged for pre-migration processes and must not be edited as a
second source of truth. Remove them only after those processes finish and
remaining external references have been checked.
