# Auto SmartLab

Auto SmartLab is an experimental autonomous machine-learning pipeline for the [SmartLab](https://lab-test.smartlab.mlsec.tu-berlin.de/) adversarial-AI platform. It gives an agent the task, local data, research notes, and measured feedback. Deterministic code owns input preparation, metric recomputation, artifact validation, trace recording, and, once the safety work is complete, submission.

The intended pipeline is:

```text
resolve task -> research -> solve and measure -> evaluate -> submit
```

Research and solve currently run through the shared pipeline executor. Evaluation and submission still use a legacy path and are not safe for unattended use. See [Current status and next work](docs/WIP.md) before running anything that can spend a SmartLab submission.

## What the project is trying to do

A solver should be able to test ideas, observe meaningful progress, stop unproductive work, retain useful artifacts, and continue from measured evidence. The model chooses features, estimators, and experiments. The surrounding code enforces the parts that should not depend on model judgment:

- task and configuration validation;
- sealed-label handling and metric recomputation;
- leakage checks and artifact validation;
- pipeline and agent telemetry;
- submission authorization, accounting, and packaging.

Start with the [developer handover](docs/HANDOVER.md) and [implementation roadmap](docs/WIP.md). The design contract is in [Pipeline integration and observability](docs/pipeline-integration.md), and operational checks are in the [telemetry runbook](docs/telemetry.md).

## Current state

| Area | Status |
| --- | --- |
| Task resolution and unit fetching | Implemented |
| Research stage | Registered, instrumented, and enabled |
| Solve stage | Registered, instrumented, and enabled |
| Evaluation stage | Legacy implementation only, not registered |
| Submission stage | Legacy implementation only, not registered |
| PostgreSQL trace storage and dashboard | Implemented for registered stages |
| Local JSONL trace mirror | Implemented for every pipeline run |
| Optional subagent sessions | Implemented and tested in isolation, not enabled in the pipeline |
| Live experiment supervision | Planned |
| Safe unattended submission | Blocked by the issues in `docs/WIP.md` |

The configured run currently stops after solve because `evaluate` and `submit` are disabled in `pipeline.config.json`.

## Pipeline architecture

The pipeline separates model judgment from execution and validation. The agent can decide what research to perform and what model to build, but it cannot declare a stage successful by saying that its work is complete.

```text
agent/pipeline_cli.ts
        |
        v
resolve task + load validated configuration
        |
        v
agent/pipeline/executor.ts
        |
        +--> research stage --> validated research artifacts
        |
        +--> solve stage ----> measured candidate + champion artifacts
        |
        +--> evaluate         not registered yet
        |
        +--> submit           not registered yet
        |
        v
PostgreSQL event sink + per-run JSONL mirror
```

The main pieces have narrow responsibilities:

- `agent/pipeline_cli.ts` parses the task selector and command options. It may fetch missing unit metadata, but it does not implement a stage.
- `agent/pipeline/config.ts` validates `pipeline.config.json`, applies defaults, and creates the immutable configuration snapshot and fingerprint recorded with the run.
- `agent/pipeline/registry.ts` is the list of stages that actually exist. A known stage name in configuration cannot be enabled until it has a registered implementation.
- `agent/pipeline/executor.ts` is the only stage execution path. It checks enablement and inputs, creates invocation IDs, passes upstream artifacts forward, handles cancellation, and decides the final outcome from artifact validation.
- Each `StageDefinition` parses its typed options, checks its required inputs, runs its work, and returns artifacts plus validation. It does not own pipeline lifecycle events.
- `agent/pipeline/trace.ts` and `agent/observability.ts` connect pipeline, stage, attempt, and Pi session events with shared IDs.
- `agent/prompts/` provides one immutable prompt snapshot for a run. Prompt IDs and hashes make instruction changes distinguishable from data or model changes.

A run has one `pipelineRunId`. Each stage execution gets a `stageInvocationId`, and each model attempt gets its own agent run ID and attempt number. This hierarchy lets the dashboard show which model session produced an artifact without treating model completion as proof that the artifact passed validation.

Artifacts are the handoff between stages. Research returns a validated document and analysis references. Solve consumes those artifacts with the task data and returns measured result files. Future evaluation must approve one exact artifact, and future submission must upload that same artifact only after deterministic checks pass.

The executor stops when a stage fails validation, is cancelled, has no enabled successor, or reaches the requested `--stop-after` stage. Standalone research and solve commands call this same executor rather than maintaining a second execution path.

### Pi SDK

Agent sessions use [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) and [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai), pinned to version 0.84.1 in `package.json`. Use the matching source tag when checking SDK behavior:

- [Pi v0.84.1 source](https://github.com/earendil-works/pi/tree/v0.84.1)
- [SDK session construction](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/sdk.ts)
- [Agent loop](https://github.com/earendil-works/pi/blob/v0.84.1/packages/agent/src/agent-loop.ts)
- [Built-in coding tools](https://github.com/earendil-works/pi/tree/v0.84.1/packages/coding-agent/src/core/tools)
- [Project investigation of the installed Pi version](docs/research/pi-0.84.1/README.md)

The main integration is `agent/run/session_runner.ts`. It creates sessions, selects prompts and tools, attaches telemetry before the first prompt, and handles cancellation and cleanup. `agent/pi_sdk.ts` is only a small observability experiment. The optional child-session integration is under `agent/subagents/`.

When upgrading Pi, update the Devbox package, both JavaScript package versions, and the compatibility notes together. Do not assume behavior from the latest upstream branch matches the pinned runtime.

## Setup

### Requirements

You need:

- Bun;
- Python 3.13;
- [uv](https://docs.astral.sh/uv/);
- PostgreSQL 17 if you want the live trace dashboard;
- a SmartLab account for fetching tasks or submitting;
- a SAIA/GWDG API key for agent runs.

Devbox is the easiest way to obtain the pinned tools, but it is optional. Any environment manager is fine if it provides the required versions and uses this repository's `.venv`, `pyproject.toml`, and `uv.lock`.

### Option A: Devbox

Install [Devbox](https://www.jetify.com/devbox), then run:

```bash
git clone <repository-url>
cd auto-smart-lab
cp .env.example .env

# Install JavaScript packages from bun.lock.
devbox run -- bun install --frozen-lockfile

# Create/synchronize the shared Python environment from uv.lock.
devbox run python-setup
```

`devbox shell` is convenient for interactive work. Its startup hook checks the Python environment but does not silently change dependencies.

```bash
devbox shell
bun test
bun run test:py
```

### Option B: another environment manager

Install Bun, Python 3.13, uv, and optionally PostgreSQL yourself. Keep the Python environment at `.venv`; pipeline code expects one shared environment rather than a second tool-specific virtualenv.

```bash
git clone <repository-url>
cd auto-smart-lab
cp .env.example .env
bun install --frozen-lockfile

uv venv --python 3.13 .venv
export VENV_DIR="$PWD/.venv"
export UV_PROJECT_ENVIRONMENT="$VENV_DIR"
export UV_PYTHON_DOWNLOADS=never
"$VENV_DIR/bin/python" -I agent/setup/python_environment.py setup

bun test
bun run test:py
```

Keep those three environment variables in your shell or environment-manager configuration when running the pipeline. Do not install pipeline packages with `pip`; use `agent/setup/python_environment.py` so `pyproject.toml`, `uv.lock`, the installed environment, and the dependency audit stay in sync. See [Python environment management](agent/runtime/python/README.md).

### Environment variables

Edit the ignored `.env` file:

```dotenv
# Required for agent sessions
SAIA_API_KEY='...'

# Optional, enables web search in research
TAVILY_API_KEY='...'

# Required only for authenticated SmartLab fetch/submission operations
LAB_USER='...'
LAB_PASS='...'
```

Quote values containing spaces or shell metacharacters. The university SSH settings in `.env.example` are only needed by workflows that use that server.

Outside Devbox, load `.env` with a method appropriate to your shell or environment manager. Do not commit `.env`, cookies, traces, or credentials.

## Fetch and inspect tasks

Download one unit and write its task metadata under `units/`:

```bash
bun run fetch-unit -- 01-spam
```

Refresh page-derived metadata without replacing matching datasets:

```bash
bun run fetch-unit -- 01-spam --refresh-metadata
```

List local tasks and inspect the configured pipeline without starting an agent:

```bash
bun run pipeline -- --list
bun run pipeline -- spam1 --dry-run
```

A task can be selected by canonical ID or unit/task number:

```bash
bun run pipeline -- spam1
bun run pipeline -- unit 1 task 1
bun run pipeline -- --unit 1 --task 1
```

## Run the pipeline

The main command uses `agent/pipeline/executor.ts` for every registered stage. It records one pipeline identity across stage lifecycle events, agent sessions, supplied inputs, and artifacts.

```bash
# Run the configured chain, currently research followed by solve.
bun run pipeline -- spam1

# Run and stop after research.
bun run pipeline -- spam1 --stop-after research

# Start directly at solve.
bun run pipeline -- spam1 --stage solve

# Print trace events while the run executes.
bun run pipeline -- spam1 --echo-events
```

The standalone commands below still use the same stage executor:

```bash
bun run research -- spam1
bun run solve-stage -- spam1 --use-existing-research --iterations 3
```

Each pipeline run writes a local trace to:

```text
runs/<task-id>/pipeline/<timestamp>-<run-id>.jsonl
```

The local mirror is written even when PostgreSQL is unavailable. The CLI reports `Trace is incomplete` or `trace degraded` when database persistence fails.

### Research output

Research maintains:

```text
runs/<task-id>/research/
├── research.md
├── context.json
├── analysis/
└── runs.jsonl
```

The stage gets the task prompt, a compact dataset manifest, optional measured startup context, filesystem tools, and bounded web search. It validates `research.md` before reporting success.

Preview the startup context without calling a model:

```bash
bun run research -- spam1 --preview-context
```

### Solve output

The solve agent owns the model implementation under `solutions/`. The harness owns measurement. It removes a sealed confirmation split from the labels available to the agent, recomputes reported scores, checks prediction coverage, runs a filename-leakage canary, and compares challengers against the current champion.

The two-file agent contract is accompanied by predictions and notes in the run workspace:

- `metrics.json` describes cross-validation and the chosen entrypoint;
- `oof_predictions.csv` contains development predictions;
- `confirmation_predictions.csv` contains predictions for sealed IDs;
- `notes.md` records attempted and rejected approaches;
- `iterations.jsonl` is written by the harness.

See [Solve stage harness](agent/solve/README.md) for the exact contract and diagnostics.

### Filename-leakage canary

The spam training archive contains a dangerous shortcut. Training filenames end in `.0` or `.1`, which reveals the class label, while test filenames end in `.x`. A model that uses the path or filename can score almost perfectly in local cross-validation and then fail on the real test set.

The canary in `agent/solve/canary.py` tests the agent's own pipeline rather than scanning source code for suspicious feature names:

1. It takes a class-balanced sample of at most 400 development examples.
2. It loads the factory declared by `solutions/tasks/<task-id>.py`.
3. It fits one fresh pipeline with the real IDs.
4. It rewrites only those IDs to neutral `.x` forms and fits another fresh pipeline on the same text and labels.
5. It compares `predict_proba` or `decision_function` values. It falls back to hard predictions only when the estimator exposes neither continuous output.
6. It passes only when the outputs are equal within a tolerance of `1e-8`.

Continuous scores matter here. The leaked filename may change a model's confidence without changing its final class on an easy sample. Comparing labels alone would miss that dependence.

A canary failure blocks champion promotion because the measured validation score cannot be trusted until the pipeline is verified. The result identifies the actual failure class:

| Result kind | Meaning |
| --- | --- |
| `passed` | Model output did not change when IDs were neutralized |
| `id_dependence` | Output changed when only the ID changed, which is evidence of leakage |
| `entrypoint_failed` | The declared model factory could not be loaded |
| `fit_failed` | The pipeline could not fit or produce output during the check |
| `sample_unusable` | The canary could not construct or load a valid two-class sample |

Only `id_dependence` proves that the implementation reads label-bearing IDs. The other failures mean the canary could not verify the model. They still block promotion, but the solver receives different repair guidance. The canary also records the sample fit time so the harness can estimate the cost of a full cross-validation pass.

The canary is separate from the sealed confirmation split. The canary tests feature independence from filenames. The sealed split measures whether repeated development decisions are drifting away from unseen labels.

## Telemetry and trace dashboard

Use the [telemetry runbook](docs/telemetry.md) for trace-ID queries, SSE checks, and degraded-storage troubleshooting.

Telemetry has two parts:

1. PostgreSQL stores events for live and historical dashboard queries.
2. Every pipeline run also writes a JSONL mirror under `runs/<task-id>/pipeline/`.

The dashboard reads PostgreSQL. It does not read the JSONL fallback.

### Start telemetry with Devbox

In one terminal:

```bash
devbox services start postgresql
devbox services ls
```

The project config uses PostgreSQL on `127.0.0.1:55433`, database `postgres`, and the current operating-system user. In a second terminal:

```bash
devbox run -- bun run traces
```

Open [http://localhost:3001](http://localhost:3001).

### Start telemetry without Devbox

Run a local PostgreSQL instance and configure these variables before starting the pipeline or dashboard:

```bash
export AGENT_DATABASE_PORT=55433
export PGDATABASE=postgres
export PGUSER="$USER"
```

The current event sink connects to PostgreSQL on `127.0.0.1` with TLS disabled and no password in the connection URL. Configure local socket/TCP trust accordingly, or adapt `agent/observability.ts` and `agent/dashboard/lib/db.js` for your database setup.

Start the dashboard:

```bash
bun run traces
```

### Check that telemetry works

Check the dashboard API:

```bash
curl -fsS http://127.0.0.1:3001/api/traces
```

Check PostgreSQL directly with Devbox:

```bash
devbox run -- pg_isready -h 127.0.0.1 -p 55433 -d postgres
devbox run -- psql -X -h 127.0.0.1 -p 55433 -d postgres -Atqc \
  'select count(*), min(observed_at), max(observed_at) from agent_events'

devbox run -- psql -X -h 127.0.0.1 -p 55433 -d postgres -P pager=off -c \
  'select agent_run_id, event_type, observed_at, stage from agent_events order by observed_at desc limit 20'
```

Generate a trace by running a registered stage, then inspect its local mirror:

```bash
bun run pipeline -- spam1 --stop-after research
ls -lt runs/spam1/pipeline/
tail -n 20 runs/spam1/pipeline/*.jsonl
```

If the dashboard is empty:

- confirm PostgreSQL is running with `devbox services ls`;
- confirm the pipeline and dashboard use the same `AGENT_DATABASE_PORT`, `PGDATABASE`, and `PGUSER`;
- query `agent_events` directly;
- inspect the pipeline command for a degraded-trace warning;
- inspect the JSONL mirror, which may contain the run even when the database was unavailable;
- restart the Next.js dashboard after changing environment variables.

Trace payloads currently include full model messages and tool results. Treat the database and `runs/` as sensitive development data. Large streamed messages can also make traces very large. Automated redaction and retention are outside the current scope.

## Optional subagents and context management

`agent/subagents/` is an opt-in module for giving one parent Pi session several independent child sessions. A parent can spawn a focused task, check or wait for it, send a follow-up, and cancel it. The parent receives a bounded final reply instead of the child's full command and tool transcript. This keeps investigation and implementation details out of the coordinating parent's immediate context.

Subagents do not yet provide durable workflow recovery:

- they are not wired into research or solve;
- they share the same filesystem and need explicit file ownership;
- they cannot spawn grandchildren;
- they do not replace the durable experiment record;
- ordinary Pi compaction still applies;
- automatic 100k-token handovers and session replacement are deferred;
- child requests still have a configurable timeout.

The intended use is context partitioning. A long-lived solver remains responsible for the task hypothesis and experiment history, while children handle bounded investigations or isolated implementation tasks. The pipeline must record durable state separately so a restarted parent can recover without relying on a child transcript.

Read [agent/subagents/README.md](agent/subagents/README.md) before enabling it. Run its deterministic tests with:

```bash
bun test agent/subagents agent/prompts agent/run/session_resources.test.ts
```

`agent/subagents/live_smoke.ts` makes paid model calls and is not part of the normal test suite. Its original run produced valid artifacts but exited nonzero on a flawed marker assertion. The assertion now distinguishes automatic transcript forwarding from text repeated in a bounded reply. The original failed evidence is preserved, and no corrected live rerun has occurred. See the [handover evidence](docs/HANDOVER.md#live-smoke-evidence).

## Tests

```bash
bun test
bun run test:py
```

The TypeScript tests cover pipeline execution, prompt loading, tracing, session resources, solve contracts, and the optional subagent module. Python tests cover solve measurements and setup utilities. CI is outside the current scope; run these checks locally.

## Repository map

```text
agent/
├── pipeline/           Shared executor, registry, stages, configuration, and trace lifecycle
├── prompts/            Versioned prompt templates and typed loader
├── research/           Research context preparation and artifact validation
├── solve/              Measurement, sealed split, canary, and champion comparison
├── subagents/          Optional parent/child session manager, not pipeline-enabled
├── run/                Shared session code plus the legacy orchestration path
├── dashboard/          Next.js trace dashboard
├── setup/              Unit fetching, SmartLab helpers, and Python environment manager
└── observability.ts    PostgreSQL and local event sink
libs/smartlab-eval/     Corpus loading and measurement library
solutions/              Agent-owned reusable model code
units/                  Downloaded task prompts, metadata, and datasets
runs/                   Generated workspaces and local traces
pipeline.config.json    Enabled stages, options, providers, and default model
pyproject.toml          Declared Python dependencies
uv.lock                 Locked Python environment
```

## Safety warning about the legacy command

`bun run solve -- <task>` invokes `agent/run/orchestrate.ts`, the old solve/evaluate/submit loop. It can upload to SmartLab and consume a limited submission. It currently has known safety defects, including fail-open evaluator parsing and overly broad source archive collection.

Do not run that command unattended. Do not treat it as the current pipeline entry point. The safe development path is `bun run pipeline -- ...`, which only runs registered stages and currently cannot submit.

## Further reading

- [Autonomous experimentation and safety plan](docs/autonomous-experimentation-plan.md)
- [Developer handover and preserved decisions](docs/HANDOVER.md)
- [Current status and implementation roadmap](docs/WIP.md)
- [Telemetry operations and troubleshooting](docs/telemetry.md)
- [Pipeline integration and observability contract](docs/pipeline-integration.md)
- [Solve stage harness](agent/solve/README.md)
- [Prompt management](agent/prompts/README.md)
- [Optional subagents](agent/subagents/README.md)
- [Signal implementations and open tools](docs/pipeline-signals.md)
- [Observable trial fits and experiment control](docs/experiment-supervision.md)
- [Pi SDK 0.84.1 investigation and upstream links](docs/research/pi-0.84.1/README.md)
- [Python environment management](agent/runtime/python/README.md)
