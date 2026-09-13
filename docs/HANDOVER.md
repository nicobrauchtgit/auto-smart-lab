# Developer handover

Updated: 2026-09-10. Start here, then use [WIP.md](WIP.md) for the implementation roadmap and [telemetry.md](telemetry.md) for operational checks.

## Repository state

Commit `f2eeb78` on the rewritten `solve-stage-hardening` history contains the experimentation plan, README, WIP notes, and optional subagent implementation. The checked-in [plan](autonomous-experimentation-plan.md) matches `/Users/I552342/Downloads/Auto-SmartLab-Autonomous-Experimentation-Plan.md`. Preserve it as the supplied design and historical review. The roadmap reconciles its findings with current code.

Research and solve are registered, enabled, and instrumented through `agent/pipeline/executor.ts`. The configured chain stops after solve. Its current `maxIterations` is 6, and the registered loop has measured stop conditions. Evaluation and submission remain legacy code outside the executor. Malformed evaluator output still defaults to approval, source archives still recurse over project files, and shared session setup still has credential/tool exposure and process-wide environment mutation.

Tests and pipeline observability now exist. The plan's claims that they are absent describe an earlier snapshot. Live experiment supervision, durable recovery, and safe unattended submission remain unfinished. CI, dashboard filtering, redaction, and retention have been removed from the active roadmap at the user's request. `bun run solve` invokes the legacy uploader; use `bun run pipeline` for current development.

## Decisions to preserve

- Subagents are an optional module under `agent/subagents/`. Research and solve do not receive its tools.
- The parent controls spawning, task assignment, follow-ups, acceptance, and cancellation. Children retain implementation details and tool traffic in separate contexts; the parent receives bounded replies. A reply may deliberately repeat information from a tool result.
- Follow-ups queue behind active work and reuse the child's session. Children share the filesystem, so the parent must assign compatible file ownership.
- The new module never mutates `process.env`. Bash receives an immutable environment snapshot. Fix the older session runner separately.
- Shared runtime guidance is explicitly selected from `agent/prompts/`. Automatic repository and ancestor `AGENTS.md` and `CLAUDE.md` loading stays disabled. This does not prevent tools from reading accessible files.
- Automatic 100k-token handovers and session replacement are explicitly deferred. Ordinary Pi compaction still applies.
- Experiment supervision and durable recovery are separate future capabilities. Subagent sessions do not replace an experiment ledger.
- The solve agent owns features, estimators, and cross-validation. Extend measurements without prescribing its implementation. Preserve the task entrypoint convention and sealed confirmation split.

## Live smoke evidence

Both parent and child used `saia/mistral-medium-3.5-128b`. One child wrote `metrics.py` and `test_metrics.py`; its 7 tests and 9 independent checks passed. The parent stopped after collecting that first validated result. Both sessions closed, and PostgreSQL contains exactly one start and end for each.

| Identity | Value |
| --- | --- |
| Pipeline | `518cc241-25af-4f71-bdc3-6338aabce978` |
| Stage invocation | `5889b6fc-6674-492d-b501-abf58b9e4238` |
| Parent | `17790127-79c2-46fe-852e-7695db498a70` |
| Child | `af21013d-e1f9-4394-b855-2da6f3d9cc26` |

The original [summary](../runs/subagents-live-smoke/pipeline/2026-09-09-174110-518cc241.summary.json) and adjacent JSONL trace remain unchanged. These are local evidence under `runs/`, not guaranteed to exist in another checkout. The implementation workspace is `/var/folders/k5/lcklkvqj45n1ftk5vyv6z5xm0000gn/T/subagents-live-vRliMg/workspace`; temporary-directory cleanup may remove it.

The smoke command exited nonzero because `markerExcludedFromParentMessages` was false. That assertion was flawed. The parent read the marker in `TASK.md`, and the child repeated it in its final reply despite an instruction to omit it. Marker presence alone does not establish automatic transcript forwarding.

The corrected validator checks child tool-call ownership and compares the wait result with the child's bounded final assistant text. It records marker repetition, reply bytes, and truncation separately under `replyQuality`. Deterministic tests cover forwarded tool events, extra transcript fields, malformed replies, and UTF-8 bounds. These checks establish the transport behavior exercised by the fixture; they do not prove that the model produces useful, concise replies or that accessible files are isolated.

The [offline context review](../runs/subagents-live-smoke/pipeline/2026-09-09-174110-518cc241.context-review.json) passes both corrected transport checks. It records hashes of the original trace and summary. The returned reply was 776 bytes, untruncated, and repeated the marker. This is a reply-quality defect, separate from transport isolation.

No corrected live rerun has occurred. Before enabling delegation, rerun the fixture explicitly and compare fixed tasks with and without children. Record parent context use, total tokens/cost, wall time, artifact quality, and failure rate. A valid implementation from one child does not establish a cost benefit.

## Continue in this order

1. Finish the corrected live smoke and assess bounded reply quality and context/cost benefits. Keep subagents optional while this evidence is missing.
2. Fix legacy evaluator fail-open approval, recursive archives, credential/tool exposure, and process-wide environment mutation. The [P0 acceptance checks](WIP.md#known-blockers) define completion.
3. Done, except its live check. Runtime guidance for observable fits reaches the solve agent as `solve.observable-fits`; `agent/solve/convergence.py` records configured allowance against completed `n_iter_`; and `agent/experiments/` is the non-blocking supervisor -- detached start, line drain, process-group stop, libproc sampling, coalesced push through `steer()`. Deterministic tests cover the transport, the mach-tick conversion, the derived stall threshold at both measured corpus scales, the coalescer's wake rate, and group stop. The module is not attached to a registered stage, and the paid live check in [supervisor-build-prompt.md](supervisor-build-prompt.md) is not written. Durable recovery stays deferred.
4. Done as part of step 3: coalesced updates reach a running agent through `steer()` and an idle one through `sendCustomMessage({triggerTurn: true})`, one channel or the other and never both. Waking is a billed model call, so it comes from a rule over the samples; sampling every 250 ms is free and spends no turn.
5. Replace fixed session deadlines and iteration limits only after supervision, cancellation, and recovery pass their tests. Replace the legacy unbounded rejection loop with explicit terminal outcomes.
6. Register evaluation and submission through the executor, with authorization bound to artifact hashes and idempotent submission accounting.
7. Continue the [signal-tool backlog](pipeline-signals.md). Add focused tests alongside each change.

Step 3's remaining work is the next thing to pick up: attach the four tools to the registered solve session, then write and run the live check against both corpora. Passing transport tests do not establish that an agent starts a pilot, reads its own curve, and stops a fit on evidence.

The user selected step 5 and clarified that the agent must start with a small pilot fit, observe progress during training, and expand only when the measurements justify more work. Local convergence checks should stop wasted iterations without waiting for a model turn. The next implementation is the control path in [experiment-supervision.md](experiment-supervision.md). Deadline removal is paused while that path is built and tested. CI, dashboard filtering, redaction, and retention are no longer planned work; keep the existing telemetry operational.

Follow [pipeline-integration.md](pipeline-integration.md) for every stage. Report sessions through `context.report.observation(attempt)`, declare supplied inputs with `context.report.input(...)`, and return artifact validation for the executor to decide success. Standalone commands use that same execution path.

## Verification

```bash
devbox run -- bun test agent/subagents agent/experiments agent/prompts agent/run/session_resources.test.ts agent/pipeline
devbox run -- bun run pipeline -- spam1 --dry-run
```

Use `devbox run -- bun test` and `devbox run -- bun run test:py` for broader verification when changing orchestration or measurement. `devbox run test` still points to a stale failing placeholder in `devbox.json`; it is not the Bun test suite.

The selected suite above now passes 111 tests across 16 files: the earlier 68, plus 42 covering the experiment supervisor, its sampler, and its wake rules, and one asserting the fit policy reaches the solve opening under its own prompt identity. `bun test agent` passes 184 across 25 files, and `bun run test:py` passes 79 and 11, including nine new convergence tests. The pipeline dry run confirms only research and solve are enabled.

The new smoke validator and its tests pass a focused strict TypeScript check. A broader ad hoc NodeNext check still fails on missing Bun declarations in `agent/observability.ts`, existing inference and callback types, duplicate `PATH`, and import-mode compatibility. The project has no configured typecheck script. Passing runtime tests do not establish a clean project typecheck.

Use the existing Devbox Python environment at `VENV_DIR`, currently `.venv`. Add dependencies through `agent/setup/python_environment.py add <package> --reason <reason>`. Local third-party libraries do not establish what a remote SmartLab execution environment permits.
