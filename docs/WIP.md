# Work in progress and implementation roadmap

Updated: 2026-09-09

This is the implementation roadmap for the autonomous experimentation plan. Start with [HANDOVER.md](HANDOVER.md) for the development baseline and decisions; use [telemetry.md](telemetry.md) for storage, dashboard, and trace diagnostics.

The plan it implements is [autonomous-experimentation-plan.md](autonomous-experimentation-plan.md): the behavioral contract, role boundaries, and acceptance criteria the finished system has to meet. That document states the target and the reasoning; this one tracks what is built and what is next. The two P0 sections below contain findings checked against the code on 2026-09-09 that remain open.

The supplied plan includes historical findings. Tests and pipeline observability now exist, and research and solve are registered and enabled. The registered solve loop is bounded, with `maxIterations: 6` in current configuration and measured stop conditions. The unbounded evaluator-rejection loop belongs to the legacy orchestrator. CI remains absent, and `devbox run test` still invokes a stale failing placeholder. Use `devbox run -- bun test`.

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
- The earlier selected subagent, prompt, session-resource, and pipeline suites passed 62 tests. Smoke validation regression tests extend that coverage; see the verification record in [HANDOVER.md](HANDOVER.md).

### Optional experiment module

`agent/experiments/` supervises trial fits, and `agent/prompts/solve/observable-fits.md`
is the runtime guidance that makes a fit emit anything to supervise. Both landed
after commit `f2eeb78` on the rewritten feature-branch history.

The guidance reaches the solve agent as a separately identified template appended
to `solve.start`: start with a pilot sized to the estimator, drive `partial_fit`
batches or a fold loop and print a labelled line per step, set `verbose`,
`early_stopping`, `n_iter_no_change`, `tol`, and `warm_start` deliberately,
distinguish a loss from a score, and attach callbacks as `AutoPropagatedCallback`
rather than a plain `FitCallback`. `agent/solve/convergence.py` then records the
other half: configured allowance against `n_iter_` actually completed, the
controls that were set, and any `ConvergenceWarning`, read off the fit after it
returns. It is measured on the full development fit when the iteration is
measurable and on the canary's sample otherwise, and the recorded scope says
which.

The supervisor spawns detached in its own process group, sets
`PYTHONUNBUFFERED=1`, drains stdout and stderr line by line to
`runs/<task>/experiments/<id>/output.log`, samples the group through libproc, and
signals the group on stop. Its four tools are start, status, output, and stop;
there is no `experiment_watch`, because updates are pushed through `steer()` when
the agent is running and `sendCustomMessage({triggerTurn: true})` when it is
idle, never both. The stall threshold is derived from the pilot's measured gap or
from the gaps the run itself shows, never from a constant, and silence only
counts at idle CPU.

The module is not wired into a registered stage, and the paid live check is not
written. Deterministic tests cover the transport, the mach-tick conversion, the
derived threshold at both measured corpus scales, the coalescer's wake rate, and
process-group stop. They do not establish that an agent uses any of it well.

### Optional subagent module

Commit `f2eeb78` contains `agent/subagents/` and `agent/prompts/subagents/`, which implement bounded child sessions for a parent Pi agent. The API supports spawn, follow-up, status, list, wait, and cancellation. Follow-ups queue behind active work and reuse the child's session. The parent owns task assignment, acceptance, and cancellation.

This is context partitioning, not context recovery. The parent receives a bounded result while detailed child tool traffic stays in the child trace. The module does not persist the solver's logical state, reconnect to an experiment after restart, or bypass Pi's normal compaction. It is not wired into a registered stage.

The live smoke run at `runs/subagents-live-smoke/pipeline/2026-09-09-174110-518cc241.summary.json` produced valid artifacts and closed both sessions, but exited nonzero because `markerExcludedFromParentMessages` was false. The assertion was flawed: the parent read the marker in `TASK.md`, and the child repeated it in its final reply. This does not establish automatic transcript forwarding. Preserve that failed summary and its JSONL trace.

The corrected validator checks child tool-call ownership and exact bounded final replies. It records marker repetition and reply size separately as quality evidence. No corrected live rerun has occurred. Keep the module disabled in research and solve until a fixed-task comparison establishes useful context/cost behavior.

An offline reassessment of the preserved trace passes the corrected transport checks. The reply is 776 bytes and untruncated but repeats the marker. The adjacent `.context-review.json` records these results and source hashes; it does not replace the failed summary or count as a live rerun.

The module never mutates `process.env`. Shared runtime prompts are explicitly selected from `agent/prompts/`, with automatic development-context loading disabled. Automatic 100k-token handovers and session replacement are explicitly deferred. Experiment supervision and durable recovery remain separate work.

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

Acceptance checks:

- solver and evaluator sessions cannot resolve or invoke `smartlab_submit`;
- a solver shell cannot read lab credentials from its environment;
- concurrent sessions cannot observe one another's temporary environment values.

## Delivery plan

Current priority: implement [observable trial fits and experiment control](experiment-supervision.md). The user selected deadline/convergence work, then clarified that shorter trials and intervention during fitting are essential. Build and test that control path before removing the existing limits.

### Phase 1: finish and evaluate subagent context partitioning

- [x] Explain and correct the flawed `markerExcludedFromParentMessages` assertion while preserving the original failed evidence.
- [ ] Run the corrected live smoke; assess transport checks and bounded reply quality separately.
- [ ] Decide which parent stage, if any, should receive subagent tools. Do not enable them globally.
- [ ] Add explicit workspace/file ownership to delegated tasks.
- [ ] Keep parent and child tool allowlists separate.
- [x] Record the assigned task, bounded reply, parent/child run IDs, and spawning tool-call ID in the optional module's shared trace.
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

- [x] Start bounded subprocess groups without blocking the solver's ability to reason.
- [x] Stream progress out line by line to the run's log, mirrored as events through `StageReporter.event`.
- [ ] Add native callback adapters where available.
- [ ] Add parsers for supported verbose output and a small JSON-lines protocol for custom or stdlib training code.
- [x] Add a coarse process-health heartbeat when no model-level signal exists: libproc CPU and RSS over the process group, with the stall threshold derived from the pilot's gap.
- [x] Provide status, output, and explicit stop tools to the solver. Push through `steer()` replaced the watch tool.
- [x] Confirm cancellation reaches descendants and does not leave orphaned training processes. Asserted against a fixture that spawns its own workers.
- [ ] Attach the tools to the registered solve session and run the paid live check on both corpora.
- [ ] Keep useful checkpoints and diagnostics after interruption.

### Phase 4: replace the fixed agent lifetime and convergence loop

`agent/run/session_runner.ts` currently enforces `SESSION_TIMEOUT_MS = 30 * 60 * 1000`. `agent/run/orchestrate.ts` can repeat evaluator rejection without a convergence policy.

The registered solve loop has a separate fixed iteration limit and measured stop conditions. Keep its bounds, and the current session deadline, until independent supervision, cancellation, and recovery pass their tests. This phase depends on phases 2 and 3. Automatic 100k-token handovers and session replacement are outside the current implementation scope.

- [ ] Separate agent-session lifetime from experiment-process lifetime.
- [ ] End sessions on settled work, explicit cancellation, or unrecoverable infrastructure failure rather than ordinary elapsed time.
- [ ] Replace the legacy rejection loop with hypothesis- and evidence-based continuation.
- [ ] Replace the registered solve iteration cap only when tested supervision and a defined convergence policy can take over.
- [ ] Record why the solver continued, interrupted, or stopped.
- [ ] Stop safely when no credible improvement hypothesis remains.
- [ ] Feed evaluator evidence back into the same logical solver state, even if a fresh model session must reconstruct it.

### Phase 5: register evaluation and submission

Follow [pipeline-integration.md](pipeline-integration.md).

This phase depends on the P0 submission and capability fixes. Configuration must continue to reject enabling an unregistered stage. Keep evaluator approval bound to the exact artifact hash and recover ambiguous uploads through idempotent accounting and authoritative platform state.

- [ ] Implement typed evaluation inputs and structured output validation.
- [ ] Return artifact validation separately from agent-session completion.
- [ ] Implement deterministic submission gates and a minimal archive builder.
- [ ] Register `evaluate` and `submit` only after their tests pass.
- [ ] Enable each stage separately in `pipeline.config.json`.
- [ ] Keep standalone commands on the same executor path.

### Signal tools still open

See [pipeline-signals.md](pipeline-signals.md) for the signal roadmap and its current implementation status. Basic scalar feature auditing and model diagnostics exist. The feature audit is not yet exposed as an agent tool. Permutation null checks, richer shift/redundancy measurements, fixed group probes, incremental feature value, and ensemble comparisons remain open. Live experiment progress/watch/stop tools are separate work in phases 2 and 3.

### Removed from scope

CI, dashboard filtering, trace redaction, and retention were removed from the active roadmap at the user's request on 2026-09-09. Existing telemetry and deterministic verification remain part of module completion. The supplied experimentation plan is retained as historical input; its recommendations in these areas are superseded.

## How to verify the current system

### Tests

```bash
bun test
bun run test:py
bun test agent/subagents agent/experiments agent/prompts agent/run/session_resources.test.ts
```

`agent/experiments` spawns real processes and calls no model.

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
devbox run -- pg_isready -h 127.0.0.1 -p 55433 -d postgres
devbox run -- psql -X -h 127.0.0.1 -p 55433 -d postgres -Atqc \
  'select count(*), min(observed_at), max(observed_at) from agent_events'
```

A registered run always prints its JSONL path. If PostgreSQL is down, the run should continue, print a degraded-trace warning, and retain that local file. The dashboard cannot display fallback-only JSONL traces. Use the [telemetry runbook](telemetry.md) for SSE checks, queries by pipeline and session ID, and partial-storage troubleshooting.

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

`replyQuality` reports bytes, truncation, and marker repetition separately. A transport pass does not establish a useful reply or a reduction in total cost. This command uses the configured model and does not perform the fixed-task comparison by itself.

## Handover notes

- The active development branch is `solve-stage-hardening`.
- Commit `f2eeb78` contains the subagent implementation, prompts, supplied plan, README, and earlier WIP notes. Preserve and extend that work.
- The latest live subagent smoke run finished and did not leave a running process. Its summary is named above.
- The trace database was reachable on port `55433` at the time of this handover.
- Earlier inspection found about 1.3 GB under `runs/`; measure current size before planning retention. Some older run files are already tracked, so `.gitignore` alone will not remove them from repository history.
- The legacy memory file is used by `agent/run/orchestrate.ts` for submission counts and prior solver/evaluator state. Registered research and solve stages use typed artifacts and traces instead. Do not mistake that legacy memory for the durable experiment ledger proposed here.
- The old `agent/instructions/` files are retained for compatibility and must not become a second edited source of prompts.

## Next developer: start here

1. Run the deterministic test suites.
2. Run the corrected subagent smoke validation and compare fixed tasks for context/cost benefits; assess reply quality separately.
3. Add tests for fail-closed evaluator parsing and an explicit submission manifest.
4. Implement the P0 submission and capability fixes before enabling either stage.
5. Done: runtime guidance for observable fits, and configured-against-actual work recorded in the iteration signal.
6. Done: the non-blocking supervisor in `agent/experiments/`, with deterministic tests.
7. Done: coalesced push delivery, with wake rules over the samples rather than a fixed heartbeat.
8. Attach the experiment tools to the registered solve session, then write and run the paid live check described in [supervisor-build-prompt.md](supervisor-build-prompt.md) against both corpora. Until it has run, the transport is tested and the agent's use of it is not.
9. Remove the fixed session timeout only after the live check passes. Durable recovery across a supervisor crash is deferred.
10. Register evaluation, then submission, through the shared executor.
11. Continue the signal-tool backlog in `pipeline-signals.md`.
