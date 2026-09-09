# Work in progress and implementation roadmap

Updated: 2026-09-09

This is the handover for the autonomous experimentation plan. It records what the repository does now, what is unfinished, and the order in which another developer should continue.

The plan it implements is [autonomous-experimentation-plan.md](autonomous-experimentation-plan.md): the behavioral contract, role boundaries, and acceptance criteria the finished system has to meet. That document states the target and the reasoning; this one tracks what is built and what is next. The two P0 sections below are its section 3 findings, checked against the code on 2026-09-09 and still open.

The observability contract lives in [pipeline-integration.md](pipeline-integration.md); solve-specific details live in [../agent/solve/README.md](../agent/solve/README.md).

## Target

The target pipeline is:

```text
resolve task -> research -> solve and measure -> evaluate -> submit
```

The agent should choose experiments using live evidence rather than a fixed wall-clock cutoff. Deterministic code must own validation, submission authorization, submission accounting, archive contents, credential access, and trace integrity.

Routine operation should not require human approval. Ambiguous evaluator output, an unknown upload result, or an invalid artifact must end in safe recovery or a no-submit result. None of those conditions may silently authorize an upload.

## Current implementation

### Complete enough to build on

- `agent/pipeline/executor.ts` is the common execution path for registered stages.
- `agent/pipeline/registry.ts` registers research and solve.
- `pipeline.config.json` enables research and solve and leaves evaluate and submit disabled.
- Research records typed inputs, prompt identity, agent attempts, validation, and artifacts.
- Solve prepares a development/sealed split, recomputes measurements, checks prediction coverage, runs the filename canary, compares challengers with a champion, and records its stop reason.
- `agent/observability.ts` writes events to PostgreSQL and mirrors pipeline traces to `runs/<task>/pipeline/*.jsonl`.
- `agent/dashboard/` displays traces stored in PostgreSQL.
- Authored runtime prompts live in `agent/prompts/`; pipeline sessions disable automatic `AGENTS.md` and `CLAUDE.md` loading.
- The Python environment is declared in `pyproject.toml`, locked in `uv.lock`, and managed through `agent/setup/python_environment.py`.
- The focused subagent and prompt tests pass. On this snapshot, `bun test agent/subagents agent/prompts agent/run/session_resources.test.ts` reports 22 passing tests.

### Optional subagent work in the current working tree

The uncommitted work under `agent/subagents/` and `agent/prompts/subagents/` implements bounded child sessions for a parent Pi agent. The API supports spawn, follow-up, status, list, wait, and cancellation. Child sessions share pipeline trace identity and retain their own conversation across follow-ups.

This is context partitioning, not context recovery. The parent receives a bounded result while detailed child tool traffic stays in the child trace. The module does not persist the solver's logical state, reconnect to an experiment after restart, or bypass Pi's normal compaction. It is not wired into a registered stage.

The live smoke run at `runs/subagents-live-smoke/pipeline/2026-09-09-174110-518cc241.summary.json` produced valid artifacts and closed both sessions, but it did not pass every isolation assertion. `markerExcludedFromParentMessages` is `false`. Treat the module as WIP until that leak is explained, fixed, and rerun.

The smoke script also has a six-minute test deadline and child requests default to a 30-minute timeout. Those test/runtime limits are not the target experiment policy. Long-running experiment processes need independent supervision and recovery.

## Known blockers

### P0: prevent unsafe submissions

Do these before enabling `submit` or recommending the legacy orchestrator.

- [ ] Replace recursive project archive collection in `agent/run/submit_session.ts` with an explicit per-task source manifest.
- [ ] Reject symlinks, devices, sockets, and unexpected file types while constructing the archive.
- [ ] Inspect and record the final archive manifest and hashes before upload.
- [ ] Replace the fail-open fallback in `agent/run/eval_session.ts`. Missing, malformed, or contradictory output must not return `APPROVE`.
- [ ] Bind evaluator approval to the exact prediction artifact hash that submission receives.
- [ ] Move evaluation and submission behind registered `StageDefinition` implementations and the shared executor.
- [ ] Make submission attempts idempotent across timeout, retry, and process restart.
- [ ] Reconcile local attempt state with the authoritative task page before upload and after ambiguous responses.
- [ ] Add an explicit `no_submit` terminal outcome.

Acceptance checks:

- malformed evaluator output never reaches the uploader;
- changing the approved CSV after evaluation prevents upload;
- a retry after an ambiguous response cannot create a duplicate attempt;
- archive tests prove that `.env`, `.pi`, memory, traces, cookies, links, and unrelated source files are absent.

### P0: enforce role capabilities and credential boundaries

`agent/run/session_runner.ts` still defaults to loading all project extensions and temporarily mutates `process.env`. The default extension list includes `smartlab.ts`, so a prompt instruction saying "do not submit" is not a security boundary.

- [ ] Define an explicit capability profile for research, solver, evaluator, experiment supervisor, and submission code.
- [ ] Remove the submission extension from solver and evaluator sessions by construction.
- [ ] Stop exposing `LAB_USER`, `LAB_PASS`, cookies, and unrelated credentials to model-controlled shell processes.
- [ ] Replace process-wide environment mutation with immutable per-process environment snapshots.
- [ ] Add tests that enumerate the tools and selected environment keys for every role.
- [ ] Add trace redaction tests for secrets and credential-bearing environment values.

Acceptance checks:

- solver and evaluator sessions cannot resolve or invoke `smartlab_submit`;
- a solver shell cannot read lab credentials from its environment;
- concurrent sessions cannot observe one another's temporary environment values;
- trace fixtures containing seeded secrets store only redacted values.

## Delivery plan

### Phase 1: finish and evaluate subagent context partitioning

- [ ] Diagnose the failed `markerExcludedFromParentMessages` smoke assertion.
- [ ] Decide which parent stage, if any, should receive subagent tools. Do not enable them globally.
- [ ] Add explicit workspace/file ownership to delegated tasks.
- [ ] Keep parent and child tool allowlists separate.
- [ ] Record the assigned task, bounded reply, parent/child run IDs, and spawning tool-call ID.
- [ ] Run a fixed-task comparison between one solver session and a parent with bounded children.
- [ ] Measure parent context size, total tokens, wall time, model quality, and failure rate.
- [ ] Keep delegation disabled if it only increases cost without improving completion or context pressure.

Subagents should handle bounded investigations such as profiling a corpus, checking an API, or implementing an isolated file. They should not own the canonical experiment ledger. A parent restart must recover from durable state, not from an assumption that an old child session remains available.

### Phase 2: define durable experiment supervision

Add a typed experiment model before implementing framework adapters.

- [ ] Define experiment IDs, parent pipeline/stage IDs, state transitions, and terminal outcomes.
- [ ] Define progress events for lifecycle, metrics, logical work, resources, heartbeats, warnings, and artifacts.
- [ ] Define process-tree ownership and graceful-then-forced interruption semantics.
- [ ] Define artifact retention for completed, failed, and interrupted experiments.
- [ ] Define stale heartbeat and lost-supervisor behavior.
- [ ] Persist the active hypothesis, experiment specification, ordered observations, best artifact, stop/continue decisions, and intended next action.
- [ ] Add replay tests that reconstruct state after process restart or context compaction.

Do not use elapsed time as the sole stop rule. Time belongs in the event history and can inform agent judgment. Infrastructure may still use explicit limits to protect tests and leaked processes, but those limits must produce a distinct infrastructure outcome.

### Phase 3: run experiments independently of an agent turn

- [ ] Start bounded subprocess groups without blocking the solver's ability to reason.
- [ ] Stream structured progress into the shared event sink.
- [ ] Add native callback adapters where available.
- [ ] Add parsers for supported verbose output and a small JSON-lines protocol for custom or stdlib training code.
- [ ] Add a coarse process-health heartbeat when no model-level signal exists.
- [ ] Provide watch/subscription and explicit stop tools to the solver.
- [ ] Confirm cancellation reaches descendants and does not leave orphaned training processes.
- [ ] Keep useful checkpoints and diagnostics after interruption.

### Phase 4: replace the fixed agent lifetime and convergence loop

`agent/run/session_runner.ts` currently enforces `SESSION_TIMEOUT_MS = 30 * 60 * 1000`. `agent/run/orchestrate.ts` can repeat evaluator rejection without a convergence policy.

- [ ] Separate agent-session lifetime from experiment-process lifetime.
- [ ] End sessions on settled work, explicit cancellation, or unrecoverable infrastructure failure rather than ordinary elapsed time.
- [ ] Replace the legacy rejection loop with hypothesis- and evidence-based continuation.
- [ ] Record why the solver continued, interrupted, or stopped.
- [ ] Stop safely when no credible improvement hypothesis remains.
- [ ] Feed evaluator evidence back into the same logical solver state, even if a fresh model session must reconstruct it.

### Phase 5: register evaluation and submission

Follow [pipeline-integration.md](pipeline-integration.md).

- [ ] Implement typed evaluation inputs and structured output validation.
- [ ] Return artifact validation separately from agent-session completion.
- [ ] Implement deterministic submission gates and a minimal archive builder.
- [ ] Register `evaluate` and `submit` only after their tests pass.
- [ ] Enable each stage separately in `pipeline.config.json`.
- [ ] Keep standalone commands on the same executor path.

### Phase 6: finish telemetry and operational hardening

- [ ] Add experiment progress and stop/continue decisions to the common event schema.
- [ ] Add dashboard filters for task, stage, model, typed options, and supplied-input kinds.
- [ ] Show active experiment health, current/best metrics, selected artifact, evaluator decision, and remaining submissions.
- [ ] Stop writing the full accumulated message on every streamed update. Current traces can grow by hundreds of megabytes.
- [ ] Add retention, compaction, and secret-redaction rules for PostgreSQL and local JSONL traces.
- [ ] Decide whether existing tracked coursework and run artifacts may remain public.
- [ ] Remove tracked generated run data if publication is not intentional.
- [ ] Add CI for TypeScript tests, Python tests, archive safety, evaluator parsing, interruption, trace degradation, and docs/config consistency.

## How to verify the current system

### Tests

```bash
bun test
bun run test:py
bun test agent/subagents agent/prompts agent/run/session_resources.test.ts
```

With Devbox, prefix commands with `devbox run --`, or enter `devbox shell` first.

### Pipeline plan

This does not start a model:

```bash
bun run pipeline -- spam1 --dry-run
```

Expected enabled stages on this snapshot:

```text
research, solve
```

### Telemetry

Start PostgreSQL and the dashboard:

```bash
devbox services start postgresql
devbox services ls
devbox run -- bun run traces
```

Open `http://localhost:3001`. The API should return a JSON list:

```bash
curl -fsS http://127.0.0.1:3001/api/traces
```

Check storage directly:

```bash
devbox run -- psql -Atqc \
  'select count(*), min(observed_at), max(observed_at) from agent_events'
```

A registered run always prints its JSONL path. If PostgreSQL is down, the run should continue, print a degraded-trace warning, and retain that local file. The dashboard cannot display fallback-only JSONL traces.

### Optional paid subagent smoke test

Do not put this in CI. It calls the configured model provider.

```bash
devbox run -- bun agent/subagents/live_smoke.ts
```

Inspect both generated files:

```text
runs/subagents-live-smoke/pipeline/<run>.jsonl
runs/subagents-live-smoke/pipeline/<run>.summary.json
```

A valid run requires every boolean under `checks` to be `true`, not merely a successful fixture-stage outcome.

## Handover notes

- The active development branch is `solve-stage-hardening`.
- The subagent implementation and prompt files are currently uncommitted. Preserve that work when changing the README or pipeline wiring.
- The latest live subagent smoke run finished and did not leave a running process. Its summary is named above.
- The trace database was reachable on port `55433` at the time of this handover.
- `runs/` is about 1.3 GB locally. Some older run files are already tracked, so `.gitignore` alone will not remove them from repository history.
- The legacy memory file is used by `agent/run/orchestrate.ts` for submission counts and prior solver/evaluator state. Registered research and solve stages use typed artifacts and traces instead. Do not mistake that legacy memory for the durable experiment ledger proposed here.
- The old `agent/instructions/` files are retained for compatibility and must not become a second edited source of prompts.

## Next developer: start here

1. Run the deterministic test suites.
2. Reproduce and fix the failed subagent smoke isolation check.
3. Add tests for fail-closed evaluator parsing and an explicit submission manifest.
4. Implement the P0 submission and capability fixes before enabling either stage.
5. Define the experiment state/event types and recovery tests before building process supervision.
6. Add progress delivery and process-tree cancellation.
7. Remove the fixed session timeout only after cancellation and recovery are tested.
8. Register evaluation, then submission, through the shared executor.
9. Add CI and trace retention/redaction.
