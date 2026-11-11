# Stream B implementation and merge handoff

Implemented on `v2/stream-b-trials`, 2026-11-11. No model-backed integration
run, merge, push or submission was performed.

## Services

- Task preparation persists a checksummed split declaration under
  `<task>/data/sealed/` before exposing development rows. The declaration
  covers archive/target identity, configuration, effective holdout policy and
  root seed. A kernel lock is released on process death; missing materialization
  resumes from the declaration. Changed declarations and corrupt records fail
  closed. Archive hashing is streamed; initial disk reserve is checked.
- `workspace/task_data.ts`, `workspace/tree.ts`, `workspace/check.ts` and
  `workspace/trial_source.ts` expose the contract APIs as adapters to the
  implementations in solve/training. No second sealing implementation exists.
- Shared solutions repositories include an index and ignored scratch space.
  Static checks use Python AST without importing authored code, with a two
  second bound. Code-work rounds capture committed paths as well as leftovers.
  Large leftovers move to collision-safe scratch paths. Promoted follow-ups
  merge back; failed recovery prevents legacy solve from starting an agent.
- Snapshots reconstruct from the durable trial receipt and recorded commit/tree.
  `evaluation/checks.ts` runs live checks in fresh Python interpreters with the
  measured solutions package first, verifies source identity, requires a
  read-only snapshot mount, and rejects live solution import origins.
- `trial_smoke` performs static checks and a small execution without reserving
  an experiment. Prepared tasks supply their real test input descriptors;
  standalone fixture callers without TaskData use a development input sample.
- Fixed-trial folds run in at most two processes, bounded by available cores;
  Linux worker affinity partitions those cores and BLAS/OpenMP threading is
  bounded. Ordered atomic checkpoints retain recovery semantics. Search
  configurations/folds and champion reruns retain serial execution.
- Training descriptions are selected by task kind. Pilots are optional;
  hypotheses are truncated to two sentences/500 characters. Full measured search
  winners can promote and refit directly with their exact winning parameters.
  Proxy searches and score-only outputs remain ineligible.
- Trial status exposes fold scores and an explicit paired noise verdict.
  Confirmation stores durable Ladder state per population: the parameter-free
  Ladder (Blum & Hardt, ICML 2015) releases a score, rounded to 1/n of the
  sealed rows, only when the champion's balanced error beats the best so far
  by one paired standard error of the per-row loss differences. It
  preserves the raw query ledger, including reserved/interrupted attempts. Raw results remain controller-only.
- Session environments use captured tool environments rather than changing
  process.env. Bash and web-search factories receive separate snapshots.
  The legacy web-search registration remains a working adapter.

## Section 11 evidence

P6 spam1 split unchanged: `./dev bun test
harness/finetuned/agent/solve/task_data.test.ts` compares withheld IDs with the
original sealConfirmationSet draw and seed derivation. It also verifies missing
materialization recovery, declaration-change rejection and corrupt-state
rejection without overwriting the record.

P6 broken pipeline fails smoke without charging: `./dev bun test
harness/finetuned/agent/training/smoke.test.ts` returns the fit traceback, permits
repeated smoke attempts with a one-trial budget and launches no supervisor trial.
`test_smoke.py` also checks invalid binary outputs and a plain fit/predict object.

P7b within-noise feedback and restricted holdout disclosure: `./dev bun test
harness/finetuned/agent/training/feedback.test.ts
harness/finetuned/agent/confirmation/ladder.test.ts` passes both tests (8 assertions).
The confirmation service suite passes five integration tests, including durable
receipt reuse, interruption, query accounting and terminal evidence binding.

Snapshot executable regression: `./dev bun test
harness/finetuned/agent/training/trial_checks.test.ts` proves a live fix cannot
make a defective measured snapshot pass. `trial_source.test.ts` restores deleted
source after later commits and rejects a modified snapshot.

Additional checks, run one module/file at a time:

- Solve directory: 18 tests pass, including persistent spam1 data and shared-tree
  checks. Training contract: 62 tests pass. Branches: 9 tests pass.
- Search harness: 5 tests pass, including one budget unit, shared manifest,
  deterministic seeds and champion comparison. Measurements: 10 tests pass.
- Refit service: 7 tests pass, including direct search-winner refit, frozen
  source, full-data boundaries, recovery and single-fit ownership.
- Session runner/resources/solve session: 13 tests pass, including concurrent
  environment isolation, fail-closed recovery and fixture AGENTS.md exclusion.
- Sandbox: 8 tests pass, including expert roles, hidden inputs, descendant
  ownership and dependency management.
- Remaining training, confirmation and refit test files were run individually;
  no full `bun test` invocation was used. All 14 training Python unittest files were
  run individually: 119 tests pass. The diagnostic fixture now uses per-process temporary ZIPs
  so parallel folds do not overwrite each other's diagnostic inputs.
- `./dev bun run typecheck` and `git diff --check` pass.

## Merge/integration work

Stream D still must invoke these services from the lead lifecycle: code-work
rounds, scout-specific sandbox construction, champion-triggered confirmation,
findings journal append and PROGRESS.json. The retained solve chain confirms at
session close; this branch does not introduce a lead agent. Stream C should
re-export the foundation types from its `team/contracts.ts` instead of copying
them. No edits were made to C's team/subagent files.

The integration gate (spam1–3 timing/quality and reader reuse, then code2), scout
budget measurements, supervision checks owned by A, and P7c are unverified here.
Consequential prompt changes still need the fixed-task model-backed gate after
A–C merge. Legacy split records are adopted only when their original input identity, root
seed and exact sealed membership/hash match. Older records without verifiable
seed lineage require explicit migration; they are never silently redrawn.

Shared changes: prompt registry entries and training-services preflight files /
joblib import probe. No config, package manifest or dependency lock changes.
The user approved required agent/run integration; web-search needed a captured
factory to preserve its session limits without process-global mutation.
