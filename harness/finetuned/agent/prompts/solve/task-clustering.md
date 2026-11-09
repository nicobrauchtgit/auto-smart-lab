This task is clustering. The required entrypoint is
`solutions/tasks/{{taskId}}.py`; create it if it does not exist. It must expose
`build_pipeline()` returning your real, unfitted scikit-learn estimator over a
pandas frame with `id` and `input` columns. Each `input` is an object
`{"archive": <absolute path of a zip archive>, "member": <member name>}`; your
code reads the sample bytes from that archive member. The harness never loads
sample content for you. Never use the id, member name or ordering as a feature.
Reuse suitable code already under `solutions/` where useful.

Execution for this task: `{{execution}}`.

- `inductive`: the harness calls `fit` on the training rows of a fold and
  `predict` on its validation rows.
- `batch`: the harness calls `fit_predict` on the validation rows (or `fit` and
  then `predict` on the same rows), so a clusterer without `predict` works. The
  fit may use that batch's inputs, never its families.

Family targets are used only to split and score; they are never passed to
`fit`. Predictions are integer cluster IDs; `-1` counts as one noise cluster.
Cluster IDs are arbitrary within a batch: only which samples share a cluster
matters.

Scored on the adjusted Rand index (ARI) between your clusters and the known
families, computed per validation batch and averaged. Test families may differ
from the training families, so a pipeline has to discover groups rather than
recognize known families. A family-held-out CV design (the built-in
`group_kfold` holds whole families out) measures that; validation batches with
several families are needed for a meaningful ARI.
