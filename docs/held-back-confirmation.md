# Held-back confirmation

Binary classification now sizes its stratified holdout from `harness.config.json`:
200 rows in the smallest class if possible, at most 20% of each class, and no
holdout if that would provide fewer than 50 smallest-class rows. Counts round
half up. The sorted ID/target population and original archive identity determine
the controller seed plan; its `sealedSeed` draws a stable split independently of
label-file ordering. Whole-family holdouts retain their separate `groupFraction`.
Group and label-free tasks explicitly skip this binary confirmation measurement.

After the solve agent closes and its workers stop, the harness checks the champion
tag and freezes its exact commit, tree, factory and fixed parameters. It fits on
all development rows, predicts exactly the sealed IDs and runs the ID canary.
The model process sees development inputs and a sealed-only validation archive;
the original full archive and labels remain outside its filesystem boundary.
As in CV, model and scorer share a Python process; this is not protection against
deliberate scorer tampering by hostile estimator code.

Each immutable `runs/<task>/confirmation/<identity>/holdout-confirmation.json`
records balanced accuracy, class metrics, a 95% stratified percentile-bootstrap
interval, CV mean, the CV–holdout gap, precision and the recorded read count.
The interval describes sampling variation, not adaptive selection or repeated
reuse. A completed identity is reused without another fit. A kernel claim and
repository selection lock prevent concurrent reads or champion changes. The
trusted receipt runner survives service death; a live worker is reattached.

`runs/<task>/holdout-ledger.json` reserves reads before launching. Failed and
cancelled attempts count too and are never automatically retried. An interrupted
reservation without a live worker requires inspection; it does not silently
become a fresh measurement. Later champions on the same fixed population add
reads. Reports distinguish the count at measurement from the population's total
recorded reads. The score is absent from solve prompts, tools and mounted inputs.

Solve returns a hashed `holdout_confirmation` artifact. Evaluation verifies it,
shows its gap, precision and reuse, and remains advisory. A low score or a large
gap does not itself block refit or submission. Invalid/corrupt evidence does fail
validation. Refit checks the confirmed experiment, source and pipeline and binds
the confirmation and prediction/input hashes into its terminal freeze; only then
does terminal training include the sealed rows.

Existing manual/older workspaces without controller holdout metadata retain
their old refit contract. New binary solve workspaces require a completed or
explicitly skipped confirmation. Setup checks the worker and its dependencies
before an agent starts. No lab access or submission is part of confirmation.
