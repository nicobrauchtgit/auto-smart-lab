# Current state and next tasks

Start with [docs/cleanup-plan.md](docs/cleanup-plan.md): it records the current
state, the decisions taken with the user, open questions and the prioritized
work queue. Run project commands through `./dev` (see that file).

# Pipeline development

When creating or changing a pipeline module, follow
[the pipeline integration contract](docs/pipeline-integration.md).
Langfuse Cloud is the shared observability backend; JSONL is emergency-only.
Use `agent/telemetry/` and pipeline reporters, declare `observability` setup, and
preserve authoritative harness/recovery records. See [telemetry](docs/telemetry.md).
Observability is part of module completion: record stage lifecycle, typed
configuration and input metadata, artifact results, and any agent sessions
under shared pipeline and invocation IDs. Standalone module commands must use
the same instrumented execution path as the pipeline.

The shared executor exists: `agent/pipeline/executor.ts` invokes registered
stages, and `agent/pipeline/registry.ts` lists the implemented ones. Research,
solve, evaluate, refit, and deterministic submit are registered. Configuration
enables submission as an available capability; only an explicit controller
submission policy authorizes uploads. Configured stage chains stop before submit.
Evaluation is an advisory
model/code review with a readiness score; it does not authorize submission.

The solve stage is a training framework, not a prescribed model. The agent
writes its own scikit-learn pipeline under `solutions/`, chooses its own
features, estimator, hyperparameters, and cross-validation scheme, and reuses
code across tasks. The harness owns the training processes, supplies seeds,
materializes the agent's fold design, writes authoritative predictions and
measurements, and controls observation, interruption, promotion, and final
refitting. Follow [the harness-owned training contract](docs/harness-owned-training.md).
Add primitives and measurements, not constraints on model design.

The `solutions/tasks/<id>.py` entrypoint convention exists so the harness can
execute the agent's pipeline. Agent-run fits may inform development, but only
harness-run fits are promotion evidence. The sealed confirmation split stays
unavailable to the agent and joins training only after the selected pipeline is
frozen for terminal refitting.

To add a stage, implement `StageDefinition` from `agent/pipeline/types.ts`,
register it, and enable it in `pipeline.config.json`. Report every agent session
through `context.report.observation(attempt)`, declare supplied inputs through
`context.report.input(...)`, and let the executor own stage lifecycle events.
Never treat a finished agent session as stage success: return the artifact
validation result and let the executor decide.

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

Use this project's Python environment, exposed as `VENV_DIR` and stored in
`.venv`. Run commands through `./dev`, which keeps the pinned toolchain from
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
- Use a stable research opening prompt regardless of whether a research
  document exists or passes validation. Let the agent inspect workspace state
  and decide what work is needed. Allow sound existing research to remain
  unchanged; do not require edits just because another run started.
- Treat existing documents as prior work, not proof of correctness or relevance
  to the current dataset. Keep artifact validation as the controller's
  completion check. After a failed attempt, supply the failed checks as factual
  feedback without changing the underlying research task.
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
