# Harness patch for code1-3 and attacks1, 2026-11-17

One small patch to the finetuned harness in the main checkout, then the same
patch for the Google checkout. Minimal arm unchanged. Binary (spam, documents)
split order, seeds, rounding and hashes must stay identical. Reuse existing
harness code and installed packages (scikit-learn 1.9, SciPy 1.18); no new
dependency. Audited read-only by gpt-6.1-sol on 2026-11-17; its corrections
are folded in below.

## Problems

- Labelled clustering must declare group sealing
  (`pipeline/task_configuration.ts:152`). `sealGroups` keeps at least two
  development families (`solve/folds.ts:121`), and group folds are recommended
  (`solve/workspace.ts:257`). With code2's four families that leaves 2 to 3
  development families and single-family validation batches, where ARI cannot
  measure separation between families.
- Sealed confirmation skips every non-binary task (`confirmation/service.ts:87`).
- attacks1 has no declaration. Evidence-based selection exists end to end
  (`workspace.ts:239`, `prompts/lead.ts:14`, `training/service.ts:794`,
  `worker.py:141`, `development_selection.ts:49`, `refit/worker.py:100`) but has
  never run on a real task.

## Changes (1 and 2 ship together: confirmation metadata activates refit's gate, `confirmation/receipt.ts:23`)

1. **Row-level clustering split.**
   - `task_configuration.ts`: labelled clustering may declare `stratified`.
   - `folds.ts`: extract the draw helper from `sealConfirmationSet` and use it for
     families, binary output byte-identical. Clustering policy: seal a fixed
     share of each family, rounded, every family with at least two rows keeps
     at least one row on each side; singleton families stay in development.
   - `workspace.ts`: branch the seal, attach per-family counts, fix
     `describeTargets`; add the clustering policy to the split declaration only
     for clustering.
   - Folds: existing stratified recommendation and Python `StratifiedKFold`.
2. **Clustering confirmation.**
   - `confirm.py`: family strings in `prepare`; clustering metadata and integer
     cluster predictions (with `-1`) in `observations`; clustering factory
     context, never families in `fit`, batch or inductive as measured, in `run`;
     metrics from `diagnostics.clustering()`; interval from
     `scipy.stats.bootstrap` (paired resampling, fixed RNG and count, percentile
     method); `validate` checks counts, metrics, interval, ARI gap.
   - `confirmation/service.ts`: run for clustering, include `diagnostics.py` in
     the framework hash, freeze kind and execution, cvMean from
     `adjustedRandIndex`, branch before `holdoutLosses`/Ladder (ARI has no
     per-row loss).
   - `run/lead_session.ts`: "sealed check recorded" text for clustering; write
     an explicit skip receipt when a split has zero sealed rows.
   - Prompts: Ladder wording in `team/lead-system.md`, family-held-out wording in
     `team/lead-task-clustering.md`, both rendered from the task's scheme.
   - `pipeline/setup.ts`: confirmation preflight covers clustering and SciPy.
   - Expected size: about 200 to 350 production lines plus tests.
3. **attacks1.** Declare `anomaly_detection` with execution, anomaly score
   method/direction/label and `selection` (evidence AP, maximize, development).
   `lead_session.ts:76`: lead summaries show `selectionScore`. Probe on staged
   data: `--check-setup`, then one fixed trial with an evidence file covering
   both classes in every fold, champion, refit. Conditions the run depends on:
   evidence exists before the first trial; every scored fold needs both evidence
   classes (`measurement.py:136`); the estimator outputs integer decisions (AP
   does not choose the threshold). No new hand-over mechanism unless the probe
   shows the supported path cannot submit.
4. **Declarations.** code1-3 (clustering, families, batch, stratified) and
   attacks1 in `pipeline.config.json`; repository-root `units/index.json`;
   workflow, controller and backup allowlists.

## Packages

Used, already installed: scikit-learn (`StratifiedKFold`, clustering metrics
via `diagnostics.clustering()`), SciPy (`stats.bootstrap`). Not needed: PyOD or
ADBench (detectors are the agent's choice), separate Mass-Volume/Excess-Mass
packages (already implemented in the harness).

## Not in this patch

Per-family recall (needs a permutation-invariant definition), Ladder for
clustering, held-back evidence share, family-held-out sealing, a scout evidence
tool, unscored hand-over.

## Reporting limits

- Row-level seal does not test unseen families.
- The bootstrap interval is conditional on the fitted partition; CV batch ARI
  versus whole-seal ARI differ in batch size, so the gap is advisory.
- attacks1 evidence AP comes from agent-chosen labels: optimistic, not task
  accuracy. Observer-only: true BACC from `units/_truth` after each run.

## Checks

Extend `solve/folds.test.ts` and `solve/task_data.test.ts`: binary hash
stability, code2-sized families, singleton policy, reset rejection. Completed
clustering receipt and refit, explicit zero-row skip. `./dev bun run
test:fast`, `--check-setup` for all four tasks, the code2 confirmation probe,
the attacks1 probe, full suite once.

## Order

1 and 2 together (probe on code2), 3, 4, Google patch, runs.
