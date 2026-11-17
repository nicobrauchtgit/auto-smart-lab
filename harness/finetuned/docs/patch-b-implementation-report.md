# Patch B implementation report — 2026-11-17

Implemented anchored batches for finetuned batch clustering only. Trial/search
fits use labelled validation inputs followed by all target-free test inputs;
ARI and OOF files contain labelled rows only. The shared helper also serves
anchored smoke, sealed confirmation and terminal delivery. Test agreement uses
at most 256 deterministic fit pairs. Confirmation and delivery use sorted sealed
IDs followed by sorted test IDs and the holdout-confirmation seed. The freeze
stores the split's IDs as `inputs.sealedIds`, verified against the measured dev
complement. The sandbox mounts only the target-free anchor manifest, keeping
sealed metadata hidden. Patch A's three reserved files were not edited.

## Files changed relative to the base-state commit

- `harness/finetuned/agent/confirmation/service.ts`
- `harness/finetuned/agent/pipeline/setup.ts`
- `harness/finetuned/agent/prompts/registry.ts`
- `harness/finetuned/agent/prompts/team/lead-task-clustering.md`
- `harness/finetuned/agent/prompts/team/skills/scout-validation.md`
- `harness/finetuned/agent/prompts/training/smoke-test-part.md`
- `harness/finetuned/agent/refit/sample_task.test.ts`
- `harness/finetuned/agent/refit/service.ts`
- `harness/finetuned/agent/refit/worker.py`
- `harness/finetuned/agent/run/solve_sandbox.test.ts`
- `harness/finetuned/agent/run/solve_sandbox.ts`
- `harness/finetuned/agent/solve/folds.test.ts`
- `harness/finetuned/agent/solve/folds.ts`
- `harness/finetuned/agent/solve/workspace.ts`
- `harness/finetuned/agent/training/anchored_batch.test.ts`
- `harness/finetuned/agent/training/pipeline_validation.ts`
- `harness/finetuned/agent/training/python/check_measurement.py`
- `harness/finetuned/agent/training/python/confirm.py`
- `harness/finetuned/agent/training/python/smartlab_trial/batch.py`
- `harness/finetuned/agent/training/python/smartlab_trial/diagnostics.py`
- `harness/finetuned/agent/training/python/smartlab_trial/measurement.py`
- `harness/finetuned/agent/training/python/smartlab_trial/search.py`
- `harness/finetuned/agent/training/python/smoke.py`
- `harness/finetuned/agent/training/python/test_anchored_batch.py`
- `harness/finetuned/agent/training/python/test_task_samples.py`
- `harness/finetuned/agent/training/python/worker.py`
- `harness/finetuned/agent/training/service.ts`
- `harness/finetuned/agent/training/types.ts`
- `harness/finetuned/docs/harness-measurements.md`
- `harness/finetuned/docs/patch-b-implementation-report.md`

## Validation

All test/Python/Bun commands used `taskset -c 4-7 ./dev`.

- `bun run typecheck`: passed (zero TypeScript errors).
- `harness/finetuned/.venv/bin/python -m unittest discover -s harness/finetuned/agent/training/python -p 'test_*.py'`: **135 passed, 0 failed**, 219.509 s.
- Final focused `test_anchored_batch.py`: **5 passed, 0 failed**, 5.875 s. This includes later OOF-file and exact delivery-ID validation additions.
- Focused `test_task_samples.py`: **11 passed, 0 failed**.
- `bun test` on `solve/folds.test.ts`, `training/anchored_batch.test.ts`, `pipeline/setup.test.ts`, `prompts/loader.test.ts`, `refit/sample_task.test.ts`: **37 passed, 1 skipped, 0 failed**. The skip requires the unavailable `zip` executable.
- `bun test run/solve_sandbox.test.ts`: **11 passed, 0 failed** (80.39 s), including anchor readability and sealed-data isolation.
- Requested initial `bun run test:fast`: **623 passed, 3 skipped, 3 failed, 1 error** (347.96 s). The shell stale/stalled timing assertion failed; two Git tests hit their 5-second deadlines, with a subsequent asynchronous error. The shell test passed on recheck. A two-file recheck was **17 passed, 2 failed** from Git deadlines; `bun test --timeout 15000 training/git.test.ts` then passed **10/10**.
- Final `bun run test:fast --timeout 15000`: **629 passed, 3 skipped, 0 failed** (280.63 s). Skips are two macOS libproc checks and the existing fetched-unit context fixture.
- Extra `bun test` on `refit/sample_task.test.ts`, `training/measurements.test.ts`, `training/smoke.test.ts`, `confirmation/worker.test.ts`, `solve/task_data.test.ts`: **15 passed, 1 skipped, 4 failed** (201.70 s). All four failures are workspace materialization requiring the missing `zip` executable. Measurement, anomaly, search, smoke and confirmation tests passed.
- The first training Python run had **129 passed, 1 error**: the pre-existing test-only refit fixture lacked `sealedIds`. Its expectations were updated for the new contract; the final whole directory passes. During construction, focused test fixture mistakes (fixture method name and OOF delimiter) were corrected; the final focused run passes.
- `git diff --check`: passed. The full 16-minute suite was not run.

## Deviations and implementation choices

- Base checksums matched. The configured commit signing agent was unavailable;
  the required base commit was made locally with `commit.gpgsign=false`.
- The initial read-only bootstrap inspection (`pwd`, checksums and `dev`) ran
  before invoking `./dev`; subsequent commands used the project wrapper.
- Search already delegates its fits to the single-trial fold runner; its fit
  behavior changes there. Its separate batch cost projection now includes the
  anchors. Configuration 0 replay is covered through the actual search adapter.
- For a task with no sealed rows, the batch-clustering fold recommendation falls
  back to two folds because development/sealed is undefined; smoke reports the
  sealed-sized block unavailable. No binary/anomaly recommendation changes.
- Added a read-only sandbox mount and regression test for the new manifest;
  without it, sandboxed training could not load anchors.
- Retained optional validation-refit diagnostics unchanged, documenting their
  validation-only population in the measurement contract.
- Repeated the fast suite with a 15-second per-test deadline after observed
  unrelated 5-second Git deadlines. No dependency was added to resolve missing
  `zip`; its integration coverage remains limited as described above.

## Measured fixture cost

The latest focused anchored fold took **0.008172 s** wall time for 12 labelled
rows plus 7 test inputs, including fold measurement. Earlier runs measured
0.0043–0.0048 s; concurrent suite load varied. This uses a trivial deterministic
fixture estimator and is not a real-task modeling runtime estimate. No real
`runs/` or `units/` data was used for a probe.

## Open questions / remaining verification

- Re-run ZIP-dependent workspace/refit integration checks in an environment
  that already supplies the required `zip` executable.
- Real-task anchored runtime, memory and live-agent behavior remain unmeasured;
  this task explicitly prohibited accessing run/unit datasets.
