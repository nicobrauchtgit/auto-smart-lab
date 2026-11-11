# Current state and work queue

Updated 2026-11-11. This file owns the active queue. The design is
[expert-team-v2.md](../harness/finetuned/docs/expert-team-v2.md) (accepted
2026-11-11); its contract appendix is
[expert-team.md](../harness/finetuned/docs/expert-team.md). Superseded plans,
merge evidence and the earlier work log were removed; they remain in git
history (commit 452e1e5).

## Experiment and current runtime

The experiment compares a minimal autonomous agent with a task-adapted harness.
Both arms are selected through `experiment/`, with independent
code/configuration and `runs/minimal/` / `runs/finetuned/` state. See
[the experiment contract](experiment.md).

The current finetuned code still runs the old design: an LLM orchestrator
calling research, solve, advisory evaluate and deterministic refit. v2 replaces
it with one lead agent that calls blocking scouts (data, ideas, validation) and
harness-run trials; no part of v2 is implemented yet. Until P6/P7 land, the
module docs describe the running code.

Both arms receive the user-supplied spam slides as checksummed, read-only course
resources with page-labelled text copies ([course resources](../resources/README.md)).
No modelling hints were added to the minimal solver's instructions.

**Spam batch (stopped).** The observed offline spam1–3 batch of 2026-11-11
finished in the minimal arm (all three delivered). The user stopped the
finetuned arm at 12:43 UTC during spam2, after about 2 h 55 min, because the old
design is being replaced; finetuned spam3 never ran. Its report is
[experiments/spam-2026-11-11.md](experiments/spam-2026-11-11.md). The finetuned
spam1 result (9 h 06 min to hand-over against 15–46 min for minimal) is the
main evidence for v2 (section 1 there).

Offline runs fetch nothing and hand over one validated refit for manual
submission. Configured chains stop before submit. Data access and successful
evaluation do not authorize uploads. Keep development and official scores
separate.

## Work queue (v2 section 11)

| Package | State | Next action / completion evidence |
| --- | --- | --- |
| P5′: accept v2 (documents) | Done 2026-11-11 | Docs reorganised; draft prompts kept as seeds for P7a |
| P6: foundations | Next; build first and alone | Task data and persistent split; shared tree, `workspace_check`, follow-up merge; trial snapshots; Linux sampler and global `supervision` block with machine-protection stop; `trial_smoke`; parallel folds; per-session environment; remove the filename-leakage canary and the profile's `name_leakage` suffix measurement. Checks in v2 P6 |
| P7a: lead and scouts | After P6 | Blocking `scout()` built on `agent/subagents/`; tool-call budgets with a counter after every call; lead session with compaction and `PROGRESS.json`; prompts in `agent/prompts/team/`; scout budget test (10 vs 20 calls on spam1–3 and `code2`) |
| P7b: harness services | After P6, parallel with P7a | Trial feedback with noise verdict and Ladder holdout check; wake on news only; `hand_over` with validation scout; budget-end hand-over; retire the LLM orchestrator, stage chain and their gates, and the knowledge store with its lesson prompts (including `lessons/sealed.md`) |
| Integration gate | After P7a and P7b | spam1 → spam2 → spam3 offline: first trial ≤ 10 min, hand-over ≤ 45 min, spam1 CV balanced accuracy ≥ 0.994 (reference 0.9944–0.9954), no machine-at-risk stop, reader reused; then `code2` to hand-over |
| P7c: beyond binary classification | After the gate | Withheld-family clustering confirmation; label-free unscored hand-over, then evidence labels ([contract](../harness/finetuned/docs/expert-team.md#7-p7c-verification-beyond-binary-classification)) |

Open decision (v2 section 12): starting budgets until the scout budget test
has run.

## Follow-ups and readiness limits

Resolve each before claiming its capability or experiment ready.

| ID | Impact | Next action / completion evidence |
| --- | --- | --- |
| F2: measured protocol | Arm comparisons need defined conditions | Agree repetitions, sequential/parallel execution, reset policy and memory across tasks; pass both preflights before measured runs |
| F3: task coverage and access | Share access does not establish labels, decryption or output contracts | Inventory cloud tasks 01–05, obtain secrets securely, verify instructions/archive identity/labels/CSV contract and disk capacity; update [task readiness](tasks.md) |
| F5: beyond spam | Clustering sealed confirmation and label-free hand-over are incomplete; multiclass Tor is not runnable | P7c after the integration gate; verify withheld-family/execution-mode semantics on code2 and label-free behavior on attacks1 |
| F8: hygiene and typecheck scope | Formatting/indexed-access checking are deferred; root semantic typecheck excludes the minimal arm; inherited trailing whitespace/blank EOFs in older training files | Assess coverage/formatting separately from behavior |

Before malware-task runs, establish permitted parsing and network boundaries.
The lab prohibits external detection services; filesystem isolation alone does
not enforce network policy. Unit 4.1 needs verified pcap connection identity and
positive/negative labels. Generated-image anomaly evidence needs immutable
images, grouped splits and attack provenance before selecting champions.

## Working constraints

Use `./dev`; `./dev setup` manages the pinned local toolchain and
`harness/finetuned/.venv`. Manage Python additions through the finetuned
`agent/setup/python_environment.py add <package> --reason <reason>`.
Never use raw pip, separate environments or home-installed tools.

The agent chooses features, estimator, parameters and fold design. The harness
owns execution, seeds/folds, authoritative predictions, comparison, promotion
and frozen refit. Labels of the withheld rows never reach an agent; under v2
the lead hears only the Ladder verdict on new champions (planned). Test-input
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
