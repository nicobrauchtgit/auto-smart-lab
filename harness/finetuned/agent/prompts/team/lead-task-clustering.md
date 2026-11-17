This task is clustering. The entrypoint is `solutions/tasks/{{taskId}}.py`;
create it if it does not exist. It exposes `build_pipeline()` returning a
fresh, unfitted object over a pandas frame with `id` and `input` columns. Each
`input` is `{"archive": <absolute path of a zip archive>, "member": <member
name>}`; your code reads the sample bytes from that archive member. The harness
never loads sample content for you. Never use the id, member name or ordering
as a feature.

Execution for this task: `{{execution}}`.

- `inductive`: the harness calls `fit` on the training rows of a fold and
  `predict` on its validation rows.
- `batch`: the harness calls `fit_predict` on the validation rows followed by all test inputs (or `fit` and
  then `predict` on the same rows), so an object with only `fit_predict` works.
  The fit may use that batch's inputs, never its families.

Family targets are used only to split and score; they are never passed to
`fit`. Predictions are integer cluster IDs; `-1` counts as one noise cluster.
Cluster IDs are arbitrary within a batch: only which samples share a cluster
matters.

Scored on the adjusted Rand index (ARI) between your clusters and the known
families, computed per validation batch and averaged. Test families may differ
from the training families, so a pipeline has to discover groups rather than
recognize known families. {{splitGuidance}} Validation batches with several
families are needed for a meaningful ARI.

In batch execution every scored batch also contains all test inputs. ARI uses
only its labelled rows. The sealed check and delivery use the same batch shape:
sealed inputs followed by all test inputs, without family targets in the fit.
