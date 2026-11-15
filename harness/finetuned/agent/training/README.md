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
predictions; score-only pilots and proxy searches remain advisory. Worker scores,
search selection, fixed confirmation, result integrity checks, evaluation and
refit use the same explicit selection score. A completed full-fold search winner can promote using its exact measured parameters.
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


## Trusted supervision records

Trial `output.log`, `command.json`, `experiment.json`, `supervisor-state.json`,
`recovery.json` and runner ownership/runtime/exit receipts live in
`<training root>/.supervision/<experiment>/`. The worker's writable mount is
only `<training root>/<experiment>/`. Source recovery, terminal refit and
scout references resolve the trusted recovery receipt from the new location.
Legacy worker-writable recovery records require inspection before migration;
they are refused rather than automatically promoted to trusted state.

Validation checks retain authoritative logs outside writable mounts and expose
scratch copies plus bounded pipe-captured output. See
[supervision log integrity](../experiments/README.md#log-integrity-2026-11-12)
for descriptor handling, marker regressions and limitations.

## Module paths and source eligibility

With a shared solutions repository configured, `pipeline.module` and a factory
`cv.module` are relative to that repository, just like `INDEX.md` entries.
For `runs/finetuned/solutions/tasks/spam1.py`, send `tasks/spam1.py` to both
`trial_smoke` and `experiment_start`, independently of shell cwd. The previous
project-relative `solutions/tasks/spam1.py` spelling remains accepted. New
requests resolve once into the existing worker/replay representation; stored
trial requests, measurements and champion identities are not migrated.

Smoke and trial admission both validate module existence in the requested Git
commit before running Python, and path errors identify the shared repository
root, resolved repository-relative path and expected request spelling. Custom
CV modules use the same convention. Unversioned programmatic services retain
their project-relative module roots.

Both entry points inspect that committed tree for all symlinks, including
directory links and files without Python extensions, using the same Git-tree
check as terminal refit. Ineligible source is rejected before fitting or trial
budget charge. Removing a link only from live HEAD cannot make an older
measured source eligible: commit, smoke-check and measure the corrected
revision. Terminal refit keeps its own defensive eligibility check.

This corrects the interface failure observed in the
[second spam1 diagnostic](../../../../docs/experiments/spam1-live-tool-choice-repeat-2026-11-12.md).
It changes source admission and request guidance, not model design, promotion
statistics, dataset boundaries or the agent's available training libraries.

Local verification, 2026-11-12: serial `./dev bun run test:fast` passed 575 tests
with 2 existing libproc skips and no failures (130.28 s). Real smoke/versioned
worker checks passed 6 tests, including solutions-relative custom CV; terminal
refit checks passed 7. Typecheck and whitespace checks passed. Logs are in
`runs/launches/2026-11-12-interface-fix-checks/`.

An earlier fast invocation used a temporary root under `/home` and overlapped
the refit checks: its sandbox `/home`-absence assertion failed and one Git test
exceeded five seconds. The serial rerun used disk-backed `/tmp` and passed
without changing those tests. No new model task run or merge was performed;
the full suite remains required before merging.
