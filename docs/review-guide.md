# Review guide

This is the entry point for the proposed `review/two-arm-experiment` PR into
`main`, based on the reviewed `merge-arms` integration. P3 run mechanics, P4
scorecard and P5 expert-team design are integrated. **P1 is deferred from this
merge by the user's decision.** Four-expert execution is design only.
[Merge evidence](merge-readiness.md) records validation and limitations; the
[generated inventory](code-inventory.md) identifies the actual measured source.

## Reading order

1. [Experiment](experiment.md): question, shared conditions, arm differences, reset and isolation.
2. [Architecture](architecture.md): current execution diagrams, evidence boundaries and module map.
3. [Code analysis](code-analysis.md) and [source inventory](code-inventory.md): counts, definitions and review hotspots.
4. [ADRs](adr/README.md): agent freedom, finite resources, evidence ownership and design trade-offs.
5. [Merge evidence](merge-readiness.md), [active queue](cleanup-plan.md), [redesign status](redesign-plan.md) and [task coverage](tasks.md).
6. For code changes: [integration](../harness/finetuned/docs/pipeline-integration.md), [training](../harness/finetuned/docs/harness-owned-training.md), [telemetry](../harness/finetuned/docs/telemetry.md), [prompts](../harness/finetuned/agent/prompts/README.md), and the relevant module README.

The arm-specific [finetuned README](../harness/finetuned/README.md) and
[minimal README](../harness/minimal/README.md) give operational detail. Treat
marked historical sections as evidence from earlier versions, not active plans.

## Current capabilities and limits

| Area | Implemented | Deferred or unestablished |
| --- | --- | --- |
| Experiment | Two arms, shared configuration, separate state and bubblewrap boundaries | Repetitions, scheduling and memory carryover protocol |
| Finetuned execution | Durable controller and shared executor; research, solve, advisory evaluate, deterministic refit, policy-controlled submit | Four experts and shared expert workspace |
| Trial evidence | Source snapshots, persisted folds/seeds, promotion and binary sealed confirmation | Non-binary confirmation, label-free final hand-over |
| Controller mechanics | Event/deadline waits, launched-trial accounting, budget-end hand-over, detached progress and recovery | Successful live integrated shakedown |
| Resources | Owned harness-worker process groups and supervisor transport; Darwin sampler | P1 Linux sampling, observed agent scripts and shared memory pool |
| Reporting | Finished-run scorecard and shared observability | Metrics missing from historical runs cannot be reconstructed by assertion |

P3 integration `fd96ccd` includes frozen-champion reconciliation, pre-spawn
accounting and recovered refits crossing the deadline. It passed 61 focused
tests; final evidence is recorded separately. P1 investigation `eee1894` did
not establish strict victim ordering with tested unprivileged controls.
Neither its backend nor its unconditional production guard is integrated. See
[the scope decision and counterexamples](p1-memory-pool-blocker.md).

## Commands and setup

Run from repository root. [dev](../dev) and [mise.toml](../mise.toml) keep the
pinned toolchain/caches local. Host requirements include git, zip/unzip and curl
or wget; agent confinement needs Linux bubblewrap and working namespaces.
Use the managed `harness/finetuned/.venv`, exposed as `VENV_DIR`.

| Command | Purpose |
| --- | --- |
| `./dev setup` | Sync managed Python and locked packages; frozen JS install |
| `./dev mise run test` | Typecheck, Bun tests, four Python discovery suites |
| `./dev bun scripts/code-inventory.ts` | Regenerate tracked-source report |
| `./dev bun scripts/code-inventory.ts --check` | Verify source/report freshness |
| `./dev bun scripts/code-inventory.ts --self-test` | Verify callable/class counting categories |
| `./dev bun run experiment -- --arm minimal --check-setup` | Minimal prerequisites |
| `./dev bun run experiment -- --arm finetuned --check-setup spam1` | Whole-chain preflight; may make a tiny explicit provider probe |
| `./dev bun run experiment -- --arm finetuned spam1` | Actual model run; not a documentation validation check |
| `./dev bun run experiment -- --arm minimal --only spam1` | Actual minimal run in a fresh run directory |
| `./dev bun run experiment -- --arm finetuned --reset` | Preview state deletion; `--yes` performs it, preserving deliveries |
| `./dev bun run scorecard -- spam1 --run <id>` | Inspect recorded finished-run evidence |

[package.json](../package.json) defines standalone stages using the same
executor/preflight. Shared [experiment.config.json](../experiment.config.json)
currently sets `online: false`; finetuned configuration enables submit as an
available capability. Offline policy prevents uploads and fetching. Configured
chains stop before submit; evaluation does not authorize it.

## Review boundaries

Mount/tool tests establish specific isolation behavior, not universal network
isolation or protection against a hostile host. The minimal model key can still
be exposed through parent `/proc` environment access; see the experiment contract.
Disabling automatic development-context loading is prompt hygiene, not
filesystem isolation. These known limitations remain visible follow-ups.

Only tasks both arms can execute belong in measured comparisons. Batch
clustering may legitimately fit the unknown batch when declared; scoring labels
must remain separate. Some training APIs precede complete task/refit adapters.
`attacks1` has no current label-free hand-over path, and Tor needs an unsupported
multiclass kind. Reconstructed instructions and assumed output formats are not
verified official contracts.

Binary sealed confirmation exists; non-binary confirmation skips. Current
evaluation can see confirmation; the proposed validation expert cannot. Keeping
sealed numbers out of guidance/knowledge is instructional, with **no automatic
sealed-guidance filter**. Historical exercise results in the
[archived log](cleanup-history-2026-11-10.md) predate the integrated controller
and do not establish a successful current shakedown.

Process RAM, model context tokens and reusable cross-task knowledge are distinct
budgets. Endpoint probes do not prove whole-chain readiness. The
[active queue](cleanup-plan.md) records concrete follow-ups instead of treating
all future work as part of this merge.

## Documentation validation

An independent Sol 6.1 review found no new blockers in the reduced scope and
one champion-initialization wording correction, now applied. Inventory parsing,
freshness failure on changed source, rejection of malformed TS/Python and
byte-identical regeneration were independently checked. Final local checks and
test counts are in [merge evidence](merge-readiness.md).

The six Mermaid diagrams have structural/fence checks; no local renderer was
installed. No browser/server or live model run was used to validate these docs.
