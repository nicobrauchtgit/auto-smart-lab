# Current state and work queue

Updated 2026-11-10. This file owns the active queue. The
[redesign plan](redesign-plan.md) explains the accepted direction and package
dependencies; its future waves are not implemented features. The
[earlier work log](cleanup-history-2026-11-10.md) preserves run results and older
plans without competing with this queue.

## Experiment and current runtime

The experiment compares a minimal autonomous agent with a task-adapted harness.
Both arms live on `merge-arms`, selected through `experiment/`, with independent
code/configuration and `runs/minimal/` / `runs/finetuned/` state. The branch has
not been merged into `main`. See [the experiment contract](experiment.md).

The current finetuned runtime has an orchestrator calling research, solve,
evaluate and deterministic refit. The four experts and their shared workspace
are an accepted design, with draft prompts, awaiting implementation. Artifact
validation owns stage completion; evaluation remains advisory.

Offline runs fetch nothing and hand over one validated refit for manual
submission. Configured chains stop before submit. Merge preparation, data
access and successful evaluation do not authorize uploads. Keep development
and official scores separate.

## Immediate merge preparation

| Package | State | Required next action |
| --- | --- | --- |
| P1: observed scripts and shared memory pool | Blocked; not integrated | Decide merge scope; see [counterexamples and options](p1-memory-pool-blocker.md) |
| P3: waits, accounting, recovery, hand-over and detached runs | Integrated in `fd96ccd` | Final whole-branch verification |
| P4: scorecard | Integrated in `d57b703` | Use on the next live shakedown |
| P5: expert-team design and draft prompts | Integrated in `6901a54` | Keep labelled as design |
| Reviewer documentation and source inventory | In progress | Review, integrate and regenerate metrics against integrated source |

P3 passed type checking and 61 focused tests after its final review fixes:
terminal champion recovery, charging only launched workers, and recovered
budget-end refits crossing the deadline. Older persisted harness versions need
a new run; there is no state migration.

Before calling this branch merge-ready:

1. Resolve complete correctness/resource blockers. Record smaller issues below
   with impact and next action; keep future packages out of this merge.
2. Keep the shared Python environment healthy. Its stale editable-package
   reference was repaired on 2026-11-10; the manager reports 39 packages healthy.
3. Run `./dev mise run test` and experiment boundary tests against integrated
   source. Record skips and unverified live behavior alongside passes.
4. Check reviewer navigation, local links, Mermaid source, current/proposed
   labels, reproducible metrics and ADR references.
5. Record final review evidence and limitations. Local tests do not establish
   experimental results.

## Follow-ups and readiness limits

These do not by themselves block merging code and documentation. Resolve each
before claiming its corresponding capability or experiment ready.

| ID | Impact | Next action / completion evidence |
| --- | --- | --- |
| F1: live shakedown | Synthetic tests do not prove a real model/controller run completes | Run spam1 offline through hand-over, validate its CSV and inspect its scorecard; wave 2 waits for this gate. Then exercise spam1–3 in both arms as unmeasured shakedowns |
| F2: measured protocol | Arm comparisons need defined conditions | Agree repetitions, sequential/parallel execution, reset policy and memory across tasks; pass both preflights before measured runs |
| F3: task coverage and access | Share access does not establish labels, decryption or output contracts | Inventory cloud tasks 01–05, obtain secrets securely, verify instructions/archive identity/labels/CSV contract and disk capacity; update [task readiness](tasks.md) |
| F4: sealed-score guidance | Keeping sealed values out of prose guidance relies on instructions | Keep the instruction explicit; do not claim an automatic filter. Any enforcement change needs a separate decision and regression evidence |
| F5: beyond spam | Clustering sealed confirmation and label-free hand-over are incomplete; multiclass Tor is not runnable | Implement P7c after the core experts; verify withheld-family/execution-mode semantics on code2 and label-free behavior on attacks1 |
| F6: concentration and legacy code | Large controller/training modules and legacy entry points increase maintenance cost | Use code analysis for later refactoring. Audit optional subagents, interactive SmartLab tools and old instructions before wiring/deleting; check running processes and external references |
| F7: additional primitives | CPU torch, generic experiment tools, service/download metadata and units 5/6 VM tools are unfinished | Add when required with shared setup/observation and task evidence; no automatic proxy fallback |
| F8: hygiene | Formatting and indexed-access checking remain deferred | Keep formatting/type-strictness migration separate from behavior; reconcile historical references without rewriting runtime prompts |

Before malware-task runs, establish permitted parsing and network boundaries.
The lab prohibits external detection services; filesystem isolation alone does
not enforce network policy. Unit 4.1 needs verified pcap connection identity and
positive/negative labels. Generated-image anomaly evidence needs immutable
images, grouped splits and attack provenance before selecting champions.
Detailed earlier scope is in the [historical log](cleanup-history-2026-11-10.md).

## Later implementation order

After wave 1 is integrated and spam1 reaches hand-over: P6 foundations (one
workspace/sandbox and shared session contracts), P7a experts/findings/prompts and
P7b orchestrator, then P7c verification beyond binary classification. P8 lighter
controller inputs and P9 evidence-backed reusable memory follow. See the
[package contracts](../harness/finetuned/docs/expert-team.md).

## Working constraints

Use `./dev`; `./dev setup` manages the pinned local toolchain and
`harness/finetuned/.venv`. Manage Python additions through the finetuned
`agent/setup/python_environment.py add <package> --reason <reason>`.
Never use raw pip, separate environments or home-installed tools.

The agent chooses features, estimator, parameters and fold design. The harness
owns execution, seeds/folds, authoritative predictions, comparison, promotion
and frozen refit. Sealed rows remain hidden until terminal refit; test-input
access follows the inductive/batch contract. Neither runtime arm may read the
other. Runtime sessions do not automatically load development context files.
Keep experiment boundary tests passing.

Langfuse is the observability backend; JSONL is emergency-only. New capabilities
need bounded whole-chain setup checks. Prompts belong in the typed
`agent/prompts/` registry, with captured identity. See [AGENTS.md](../AGENTS.md),
[pipeline integration](../harness/finetuned/docs/pipeline-integration.md),
[training](../harness/finetuned/docs/harness-owned-training.md),
[isolation](../harness/finetuned/docs/solve-filesystem-isolation.md) and
[telemetry](../harness/finetuned/docs/telemetry.md).
