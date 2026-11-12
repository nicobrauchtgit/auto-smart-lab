# Current state and work queue

Updated 2026-11-12 (reviewed integration and worktree cleanup). This file owns the active queue. The design is
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

The old design's orchestrator, research and evaluate stages, knowledge store
and leakage canary were removed on 2026-11-11 (the clean-slate package below).
Stream D replaces solve → refit with one lead session calling asynchronous
scouts (data, ideas, validation) and harness-run trials, followed by validated
terminal refit. Foundations, scouts and the lead are merged and independently reviewed. See [lead execution](../harness/finetuned/agent/run/README.md).

Readiness clarification (2026-11-12; merged and independently reviewed): `hand_over` defaults to a free validation checkpoint, preserving the
first verified working baseline and switching the same lead session to
improvement. Explicit `finalize: true` or the harness end step requests
validation-gated terminal delivery. Existing immutable measurements and source
snapshots are reused. This does not establish the paid task integration gate.
The same change fixes validation snapshot mounts when task state is symlinked;
it does not broaden scout access. API and label-safety correction are in the
[lead execution contract](../harness/finetuned/agent/run/README.md).

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
| Clean slate | Done 2026-11-11 | Removed the LLM orchestrator, research and evaluate stages, knowledge store and lesson prompts, scorecard, old `agent/instructions/`, the filename-leakage canary and the profile's `name_leakage` measurement; the chain is solve → refit |
| P6: foundations | Implemented, reviewed and merged; live gate remains open | Task data and persistent split; shared tree, `workspace_check`, follow-up merge; trial snapshots; Linux sampler and global `supervision` block with machine-protection stop; `trial_smoke`; parallel folds; per-session environment. Checks in v2 P6 |
| P7a: lead and scouts | Implemented, reviewed and merged | Asynchronous lead-facing `scout` (2026-11-12 user decision), built on `agent/subagents/`; tool-call budgets with a counter after every call; lead session with compaction and `PROGRESS.json`; prompts in `agent/prompts/team/`; scout budget test (10 vs 20 calls on spam1–3 and `code2`) |
| P7b: harness services | Implemented, reviewed and merged | Trial feedback with noise verdict and Ladder holdout check; wake on news only; `hand_over` with validation scout; budget-end hand-over; retire the remaining solve stage chain |
| Integration gate | Not passed; earlier delivery/time gates failed | spam1 → spam2 → spam3 offline: first trial ≤ 10 min, hand-over ≤ 45 min, spam1 CV balanced accuracy ≥ 0.994 (reference 0.9944–0.9954), no machine-at-risk stop, reader reused; then `code2` to hand-over |
| P7c: beyond binary classification | After the gate | Withheld-family clustering confirmation; label-free unscored hand-over, then evidence labels ([contract](../harness/finetuned/docs/expert-team.md#7-p7c-verification-beyond-binary-classification)) |

Scout starting budgets are set from the P7a budget test: data 15, ideas 10,
validation 10 (v2 section 3). The lead's 80 is exercised at the integration gate.

Latest evidence: the earlier v2 unit-1 runs failed their delivery/time gates
([run report](experiments/v2-unit1-2026-11-12.md)); the bounded prompt-first spam1
experiment also failed to deliver within 600 seconds
([historical report](experiments/prompt-first-spam1-just10min.md)). The later
checkpoint revision passed independent review and its recorded full suite
(675 passed, 2 skipped), but has no paid task-run evidence. The integration gate,
reader reuse, live delivery and P7c remain unproven. No new model runs or uploads
are authorized for this merge/cleanup. See [cleanup evidence](worktree-cleanup-2026-11-12.md).

## Follow-ups and readiness limits

Resolve each before claiming its capability or experiment ready.

| ID | Impact | Next action / completion evidence |
| --- | --- | --- |
| F2: measured protocol | Arm comparisons need defined conditions | Agree repetitions, sequential/parallel execution, reset policy and memory across tasks; pass both preflights before measured runs |
| F3: task coverage and access | Share access does not establish labels, decryption or output contracts | Inventory cloud tasks 01–05, obtain secrets securely, verify instructions/archive identity/labels/CSV contract and disk capacity; update [task readiness](tasks.md) |
| F5: beyond spam | Clustering sealed confirmation and label-free hand-over are incomplete; multiclass Tor is not runnable | P7c after the integration gate; verify withheld-family/execution-mode semantics on code2 and label-free behavior on attacks1 |
| F8: hygiene and typecheck scope | Formatting/indexed-access checking are deferred; root semantic typecheck excludes the minimal arm; inherited trailing whitespace/blank EOFs in older training files | Assess coverage/formatting separately from behavior |

### Non-blocking review findings (v2 streams, 2026-11-11)

Recorded instead of fixed under the review bar: only findings that break a
v2 check block a merge.

| Stream | Follow-up |
| --- | --- |
| B | Ladder threshold is one paired standard error, as in Blum & Hardt's parameter-free Ladder; fold promotion keeps the 2-SE rule. Revisit if the lead sees too many "improvements". |
| B | The old spam1 terminal refit freeze reports "framework drifted" (refit scripts changed); new runs freeze again. Not fixed. |
| B | A killed fold is not resumed automatically; the agent resumes it with `experiment_resume`. |
| C | The ideas scout's search counter resets when its session rolls over at the 100k-token handoff. |
| C | No validation probe has run on a trial with a deliberately planted defect; detection of real defects is unmeasured. |
| C | Probe call counts before round 1 are admitted calls, not proven executions. |
| C | Data budget 15 sits between the measured 10 and 20; it is not an optimum. |

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
