# Explicit anomaly evidence selection

An anomaly task may opt into a scoring-only selection objective while keeping
its official metric `none`:

```json
{"basis":"evidence","metric":"evidence_average_precision","direction":"maximize","population":"development"}
```

`evidence_roc_auc` is also supported. There is no implicit proxy fallback. The
solve agent writes `runs/<task>/solve/agent/evidence.json` with schema version 1
and a `labels` array of `{id,target}` records for known development samples.
Targets are explicit integer 0/1; omitted IDs stay unlabelled. Setup permits the
file to be absent and checks its writable destination. Trial acceptance copies
and validates at most 8 MiB into the trial's `evidence.json`; the invocation
records that copy's hash and source. Mutable live evidence is excluded from
base data identity, recovery and terminal freezing.

Evidence labels never enter estimator fit frames, factory inputs or CV inputs.
Every scored fold needs both classes. Fixed promotion also requires integer
predictions; score-only pilots and searches remain advisory. Worker scores,
search selection, fixed confirmation, result integrity checks, evaluation and
refit use the same explicit selection score. Search itself cannot promote.
The champion reruns on the challenger's exact evidence snapshot and folds;
D7/D13 still require a positive paired lead greater than two standard errors.
Changing AP to ROC also requires this paired rerun, rather than resetting the
champion. Receipts and tags retain the objective, evidence identity, provenance,
class counts and coverage. Evaluation recomputes scores from frozen OOF
observations; refit recomputes and freezes the same scoring evidence without
using its labels for training.

This supports partial labels on existing development IDs. Generated challenge
populations, immutable generated image assets, source-image grouping and the
single-image-population task adapter remain unimplemented. Nothing in these
checks verifies agent label correctness or establishes official task accuracy.
