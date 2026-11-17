# Minimal harness patches: trial feedback and batch clustering, 2026-11-17

Plan only; nothing is implemented. Finetuned arm only; the minimal arm is
unchanged. Spam and documents will not be rerun, so binary behaviour may change
in feedback text but its splits, seeds, hashes and selection stay identical.
Reuse existing code and installed packages (scikit-learn, pandas, NumPy, SciPy);
no new dependency, no new measurement packet.

Implement in a separate worktree while the Qwen campaign runs in the main
checkout; apply to a checkout only when no run is active there.

## Why (own measurements, Google campaign 2026-11-16/17)

1. **The lead does not see what the harness measures.** Every trial already
   records per-fold diagnostics (clustering: cluster count, sizes, singleton
   fraction, pair precision/recall, cross-repeat stability; binary: ranking,
   low-FPR recall, threshold sweep, calibration, champion error changes).
   `trialFinished` in `agent/run/lead_session.ts` already holds them
   (`training.service.describe(id).diagnostics`, built by
   `compactDiagnostics` in `agent/training/service.ts:201`) but renders only
   fold scores, verdict, holdout, cost, streak and budget
   (`team/lead-trial.md`). Across 11 Google runs: 0 of 15 trial requests asked
   for optional diagnostics, 0 harness searches, 0–4 `experiment_status`
   reads per run, 24–77 shell calls before the first trial.
2. **Batch clustering is measured on batches unlike the delivered one.** code1
   folds had 80 rows (12–18 clusters), the sealed check 200 rows (25), the
   delivery 1,000 rows (77, 15 singletons) with a fixed cosine cut-off of
   0.68. The fold shape comes from the binary row-count table
   (`agent/solve/folds.ts:29`); the lead tuned on 80-row batches "mirroring the
   harness".

## Research basis (peer-reviewed)

- Calibrate on the target batch, score on known classes: cluster labelled and
  unlabelled data together and evaluate only the labelled part (Vaze et al.,
  Generalized Category Discovery, CVPR 2022, §3.2; Han, Vedaldi and Zisserman,
  Deep Transfer Clustering, ICCV 2019, §3.2, which also scores a probe split of
  known classes). Limit: known and new classes may differ in granularity
  (Vaze §3.2); the course says test families differ from training families.
- Parameter selection for clustering by cross-validation over labelled
  information (Pourrajabi et al., EDBT 2014).
- Stability is a diagnostic, not a selector (Lange et al., Neural Computation
  2004; Ben-David, von Luxburg and Pál, COLT 2006).
- The course scores ARI; ARI suits large equal clusters, AMI unbalanced ones
  (Romano et al., JMLR 2016); size distributions can inflate malware
  clustering results (Li et al., RAID 2010).

## Patch A: trial digest in the feedback (all kinds, no new measurement)

- New `agent/run/trial_digest.ts`: `trialDigest(kind, described)` turns the
  already-computed `described.diagnostics` into at most three short lines,
  means over completed folds:
  - clustering: clusters per batch (min–max), singleton fraction, largest
    cluster share, pair precision vs recall (false merges vs false splits),
    cross-repeat stability (mean ARI on common rows); after Patch B also the
    test-part line.
  - binary classification: ROC AUC/AP, recall at 1% FPR, default vs best
    threshold balanced accuracy (marked advisory), champion
    corrected/introduced errors from `championComparison`.
  - anomaly detection: the existing score-health and flagged-share fields.
  - Missing fields print "unavailable", never invented values.
- `team/lead-trial.md`: one `Diagnostics: {{digest}}` line;
  `agent/prompts/registry.ts` gains the variable.
- Readiness checkpoint (`team/lead-checkpoint.md` via `{{progress}}`): repeat
  the champion's digest, so the lead sees it before finalizing.
- `trial_smoke` feedback: see Patch B item 4.
- No change to selection, promotion, budgets or tool descriptions.

## Patch B: anchored batches for batch clustering

One helper, used everywhere a batch clusterer is fitted:
`batch_fit_predict(estimator, labelled_frame, anchor_frame)` concatenates the
labelled rows and the test inputs (`pandas.concat`), calls `fit_predict` (or
`fit`+`predict`), and returns the labelled part for scoring and the test part
for label-free structure. Family targets never enter a fit.

1. **Test manifest.** `agent/solve/workspace.ts` writes
   `test-samples.json` (test IDs and input descriptors, no targets) with the
   existing descriptor code; clustering/batch measurements gain
   `anchorManifestPath` and its SHA-256 (`smartlab_trial/measurement.py`
   allowed keys and checks).
2. **Fold recommendation.** For clustering with batch execution, recommend
   stratified k-fold with `k = round(development rows / sealed rows)` (4 for
   code1–3: blocks of about 200 / 131 / 328 rows) and the table's repeats. The
   agent may still choose another scheme; such trials are scored as today and
   get the anchored structure only from smoke and readiness.
3. **Trials** (`training/python/worker.py:_run_fold`, and the batch branch in
   `smartlab_trial/search.py:148`): when the anchor is present, use the
   helper. ARI and the existing clustering packet are computed on the
   labelled rows only. `signals["testPart"]` holds
   `diagnostics.clustering(None, test_predictions)["structure"]`. Test-row
   agreement across folds (every fold clusters the same test rows with a
   different labelled block) via `sklearn.metrics.adjusted_rand_score`, stored
   like the existing stability summary. `fitRows` records the union.
   Optional diagnostics that refit on validation rows keep their current
   behaviour and say so.
4. **Smoke** (`training/python/smoke.py`): after the existing 256-row check,
   for batch clustering run the helper once on a sealed-sized block of
   development rows plus all test inputs and return only the test-part
   structure (count, sizes, singleton fraction, largest share). No ARI and no
   family information, so smoke still returns no scoring evidence. Bounded by
   a timeout; reported as unavailable when exceeded.
5. **Sealed confirmation** (`training/python/confirm.py`): batch = sealed rows
   ∪ test inputs, ARI on the sealed rows. Same batch shape as the trials, so
   the dev-to-sealed gap is no longer a batch-size artefact.
6. **Delivery** (`refit/worker.py:fit_samples`, `refit/service.ts` freeze):
   batch = sealed rows ∪ test inputs in the confirmation's order and seed;
   write only the test rows; existing exact test-ID coverage check. The
   freeze gains `sealedIds` from the workspace split.
7. **Prompts.** `team/lead-task-clustering.md`: one factual paragraph — in
   batch execution each scored batch also contains all test inputs; ARI uses
   the labelled rows only; the sealed check and the delivery use the same
   batch shape. Drop the 10-fold suggestion for clustering. Validation scout
   (`team/skills/scout-validation.md`): test inputs inside a batch-clustering
   fit are the task contract, not a defect. No modelling advice and no target
   cluster count.

Expected size: Patch A about 80–120 lines plus tests; Patch B about 200–300
lines plus tests.

## Tests

- Patch A: digest for clustering, binary and anomaly results from fixture
  trial results; missing fields print "unavailable"; `lead-trial.md` renders
  with the new variable; binary splits/seeds/hashes unchanged.
- Patch B: anchored folds contain every test row exactly once and no sealed
  row; ARI uses labelled rows only; test rows never scored; search and single
  trials give identical results for configuration 0; smoke returns test-part
  structure and no ARI/family fields; confirmation and refit batches identical
  in IDs and order; delivery covers the test IDs exactly; preflight requires
  the test archive for anchored clustering.
- `./dev bun run test:fast`, then the full suite once before merging.

## Probe before any rerun

Without an agent session, on code1 with the frozen champion `c8ffbd2d`: one
anchored trial, smoke, sealed ∪ test confirmation and refit. Expected: smoke
and the test-part line show the fragmentation; anchored ARI well below 0.697.
Record wall time and peak memory; code3 fits are the largest (331 + 1,487 rows).
Then a short live code1 lead run to check the lead reads the digest.

## Not in this plan

- Multiclass classification (Tor closed world) and the open-world task. The
  course task text is final and names no evaluation measure. When Tor is
  added, Patch A's digest gets per-class recall and the largest confusions.
- Label-informed clustering (fitting a metric on known families) and
  family-held-out sealing (P7c).
- Early hand-over (all 11 Google leads finalized after 1–2 trials).
- Enforcing the "no local CV sweeps in bash" rule.

## Experiment impact

Both changes alter the lead's instructions and feedback, so their prompt hashes
change and are recorded per run. The completed Google and Qwen code1–3
finetuned runs stay as recorded. Rerunning code1–3 finetuned under the patches,
in which checkout and in what order, is a user decision after the probe.
