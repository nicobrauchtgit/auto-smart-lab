Read the current state of one harness-owned training experiment, or list all of
them. The state includes process lifecycle and resource measurements. Completed
fold measurements remain in the experiment directory and full output remains
available through the output tool.

Trial status and leaderboard rows include measured diagnostics: per-fold spread,
class metrics, ranking scores, threshold sweeps, probability calibration when
available, fit time, convergence, and champion error changes. Task-declared
clustering also reports split/merge quality, coverage, and repeated-partition
stability; anomaly trials report score health, threshold sensitivity, and ranking
stability. Label-free signals are proxies and cannot establish detection accuracy
or authorize promotion. Threshold sweeps are advisory and were selected on the
same validation rows; their optimum is not independent evidence. Status shows at
most eight diagnostic folds; full measurements remain in trial-result.json and
fold-results.jsonl. Stability requires overlapping IDs across different repeats.
Optional diagnostics expose representation quality, evidence provenance,
model signals, volume curves, slices, learning curves and controlled perturbations.
Status summarizes nested arrays and shows at most eight slice groups per fold.
Low-FPR points show attainable recall and FPR resolution; selected thresholds
remain advisory. Corrected CV uncertainty is an approximation for inductive
folds and does not change promotion. Quality on perturbed inputs requires an
explicit agent-declared label-preservation assumption.
