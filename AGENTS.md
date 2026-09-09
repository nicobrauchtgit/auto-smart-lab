# Pipeline development

When creating or changing a pipeline module, follow
[the pipeline integration contract](docs/pipeline-integration.md).
Observability is part of module completion: record stage lifecycle, typed
configuration and input metadata, artifact results, and any agent sessions
under shared pipeline and invocation IDs. Standalone module commands must use
the same instrumented execution path as the pipeline.

The shared executor exists: `agent/pipeline/executor.ts` invokes registered
stages, and `agent/pipeline/registry.ts` lists the implemented ones. Research and
solve are implemented; `evaluate` and `submit` are known names that configuration
cannot enable until they are registered.

The solve stage deliberately owns almost nothing about the model. The agent
writes its own scikit-learn pipeline under `solutions/`, chooses its own
features, estimator, and cross-validation scheme, and reuses code across tasks.
The harness prepares inputs, reads a two-file results contract, and returns
measured signals. When changing it, keep that line: add measurements, not
constraints on the implementation. The exceptions are narrow and deliberate —
the `solutions/tasks/<id>.py` entrypoint convention, which exists so the harness
can re-run the agent's own pipeline, and the sealed confirmation split.

To add a stage, implement `StageDefinition` from `agent/pipeline/types.ts`,
register it, and enable it in `pipeline.config.json`. Report every agent session
through `context.report.observation(attempt)`, declare supplied inputs through
`context.report.input(...)`, and let the executor own stage lifecycle events.
Never treat a finished agent session as stage success: return the artifact
validation result and let the executor decide.

`agent/pi_sdk.ts` is an observability experiment, not the main pipeline.

## Pipeline Python dependencies

Use this project's Devbox Python environment, exposed as `VENV_DIR` and currently
stored in `.venv`. Do not create a separate pipeline environment. Dependencies are
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
