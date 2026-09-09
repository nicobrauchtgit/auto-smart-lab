# Solve stage harness

The solve agent owns the model. This directory owns the measurement.

| File | Role |
| --- | --- |
| `folds.ts` | Fold recommendation by row count; the sealed confirmation draw |
| `workspace.ts` | Run workspace, dev/sealed label split, research hand-off |
| `results.ts` | Runs the evaluator, validates its output, renders the agent's signal |
| `iteration.py` | Recomputes every number, scores the sealed split, emits one JSON signal |
| `canary.py` | Filename-leakage check |
| `champion.py` | Re-runs a champion snapshot under the challenger's folds |
| `corpus.py`, `entrypoint.py` | Loading examples and the agent's declared factory |
| (`libs/smartlab-eval/`) | The corpus loader and measurement library, installed into the venv and imported by both sides |

## The dividing line

Add measurements here, not constraints on the implementation. The agent chooses
its preprocessing, features, estimator, hyperparameters, module layout, and
cross-validation scheme. Two exceptions are deliberate:

- `solutions/tasks/<task_id>.py` must expose a factory returning an unfitted
  estimator over a frame with `id` and `text` columns, so the harness can re-run
  the agent's own pipeline for the canary and the paired comparison.
- A stratified fraction of training rows is sealed out of every fold and absent
  from the agent's labels file.

Everything else the harness knows, it learns by recomputing the agent's own
predictions.

## Running the pieces directly

```bash
# One iteration's measurements, as the stage sees them
cd agent && python -m solve.iteration \
  --workspace ../runs/spam1/solve --project-root .. \
  --labels ../units/01-spam/<task>/data/spam1-train.labels \
  --sealed ../runs/spam1/solve/data/sealed_ids.txt \
  --zip ../units/01-spam/<task>/data/spam1-train.zip \
  --seed 4021 --folds 5

npm run test:py     # harness unit tests (stdlib unittest; no pytest needed)
```

## Notes for future changes

- `corpus.py` is a thin delegation to `smartlab_eval.corpus`. The harness and
  the agent read the archive through one implementation so they cannot disagree
  about what an id is. Do not reintroduce a second reader here.
- `smartlab_eval` is an installed distribution (`libs/smartlab-eval`, editable),
  not a directory on `PYTHONPATH`. The stage deliberately no longer tells the
  agent where the source is; the prompt carries a complete API reference instead.
  Editable is intentional: a copied install would let the harness and the agent
  run different versions whenever a reinstall was missed.
- Every loader opens the zip once. `zipfile.ZipFile()` reparses all 16,663
  central-directory entries per construction, so a per-document open costs about
  600 s against a 0.2 s single open, which is most of a session cap.
- A compliance failure marks the iteration unmeasurable but still reports the
  canary and whatever folds were scorable. `ok` gates promotion; it is not a
  reason to withhold diagnostics.
- `CanaryResult.kind` distinguishes a real leak from a canary that could not
  run. The stage branches its guidance on it, so a new failure path needs a new
  kind rather than another `passed: False` with prose in `reason`.

- The canary compares `predict_proba`/`decision_function`, not predicted labels.
  Where text alone already separates the classes, a leaky pipeline predicts
  identically to a clean one; only the scores move. Do not "simplify" it back to
  comparing labels.
- The champion runs in a separate interpreter. Its snapshot shares module names
  with the live tree, so a single-process import would serve the cached live
  modules and compare the challenger with itself.
- `Results.add_fold` tracks seen ids in a set. It was O(n^2) once; at 16k rows
  that is ~278M comparisons.
- Fold seeds rotate per iteration from the stage invocation id. Anything that
  pins them to a constant reintroduces the fold-grinding this design prevents.
