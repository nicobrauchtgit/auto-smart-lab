# Harness measurements

Implemented 2026-10-08. These measurements run in the existing training worker,
including manual trials, supervised/clustering searches, champion reruns, and
completed-fold recovery. No measurement owns a separate fitting process.
Source identity, harness seeds, persisted folds, prediction checkpoints, process
supervision, and shared pipeline/invocation events remain authoritative.

The task adapters used by the registered solve/evaluate/refit stages still
prepare binary text corpora. H1/H2 must connect the task declaration and generic
sample metadata to these APIs before the lab's clustering or detection tasks can
run end to end. This packet implements the training/measurement foundation,
not all of H1–H7. No VM deployment or official submission was performed.

## Controller inputs and sample identity

`TrainingServiceOptions` and `createHarnessTraining` accept an optional typed
`measurement` declaration. Omitting it preserves binary classification from
`zipPath` and `labelsPath`. The agent's experiment request does not choose the
task's primary metric or supply seeds. Generic tasks need neither text archives
nor binary labels.

Example clustering declaration:

```ts
measurement: {
  kind: "clustering",
  execution: "batch", // or "inductive"
  sampleManifestPath: "/absolute/path/development-samples.json",
}
```

The development metadata is versioned JSON, bounded to 64 MiB:

```json
{
  "schemaVersion": 1,
  "samples": [
    { "id": "a", "input": { "path": "samples/a.apk" }, "target": "family-A" },
    { "id": "b", "input": { "path": "samples/b.apk" }, "target": "family-A" },
    { "id": "c", "input": { "path": "samples/c.apk" }, "target": "family-B" },
    { "id": "d", "input": { "path": "samples/d.apk" }, "target": "family-B" }
  ]
}
```

`input` is an opaque JSON descriptor. The harness creates an `id`/`input` frame;
agent code interprets descriptors and reads actual files/connections/images.
There is no harness sample-content loader. IDs are unique and sorted before
fold materialization. Family identifiers have one uniform string/integer type
and cover every development row, or are absent entirely. Targets stay outside
unsupervised estimator fitting.

The controller must supply development metadata only: sealed rows/labels do not
belong here. This is an execution contract, not filesystem isolation from agent
code. Existing sample safety requirements still apply.

`ready()` checks the metadata and actual metric imports without importing agent
code. Starts recheck metadata before construction validation. The invocation
and durable trial record retain the manifest SHA-256 and target availability;
the worker rejects changed metadata. Recovery also binds the measurement
declaration and data hash. Setup events carry shared run/invocation identities
through the service reporter; worker actions retain their existing identities.
The shared pipeline `training-imports` preflight runs the same import helper,
including for standalone stage commands and `--check-setup`.

The metadata hash binds descriptors and targets, not bytes in externally
referenced sample files. The task's sample-source adapter must supply a dataset
fingerprint covering those bytes. A manifest edit after readiness requires a
new controller invocation and dataset identity.

## Execution and folds

- **Inductive clustering:** harness `fit(training_inputs)` then
  `predict(validation_inputs)`. Family targets are used for splitting/scoring,
  never passed to `fit`.
- **Batch clustering:** harness `fit_predict(validation_inputs)`, allowing
  transductive clusterers without `predict`. The fitted representation and
  clusters may use that validation batch's inputs, never its family targets.
  This measures discovery in a new batch, not prediction from a train-only fit.
- **Inductive detection:** harness `fit(training_inputs)` then the declared
  score method on disjoint validation inputs; `predict` is optional.
- **Batch detection:** harness `fit_predict` when available, otherwise `fit`,
  on batch inputs. Scores describe that fitted batch. LOF's
  `negative_outlier_factor_` is supported explicitly for this mode; it is not
  available for inductive scoring. Pipeline wrappers must expose their declared
  score interface. Novelty-only interfaces must not be used to score fitted rows.

Each fold records `execution`, `trainRows`, `validationRows`, `fitRows`, fit time,
and convergence. Batch `trainRows` records the split's other rows, not fitted
rows; `fitRows` is the authoritative fit scope.
Search cost projections use this fitted scope for both prior pilot measurements
and the requested batches, rather than treating unused batch training rows as fit work.

Built-in split schemes are `stratified_kfold`, `kfold`, and `group_kfold`.
Group K-fold holds whole supplied families out and uses harness randomness.
Choose validation batches with multiple held-out families when evaluating
family discovery; diagnostics flag single-family batches. Agent-defined
splitters remain available. Fold counts, repeats, feature representations,
estimators, and model parameters remain agent decisions.

## Clustering measurements

With family targets: per-batch ARI, homogeneity, completeness, V-measure,
pair precision/recall, false merges/splits, and family/cluster contingency counts.
Large contingency matrices use sparse triples in the full artifact. Noise label
`-1` is one cluster for external metrics, and no difficult rows are excluded.
Matching the lab's exact noise convention remains a task-adapter responsibility.

Every clustering batch also records cluster count/sizes, singleton fraction,
largest-cluster share, assigned fraction, and noise fraction. No targets means
external metrics are explicitly unavailable and promotion is forbidden.

The trial's primary score is the mean of batch ARIs. Cluster IDs are arbitrary
within their fitted batch and are never pooled across folds. The frozen champion
reruns on the exact persisted manifest. Comparisons report per-fold deltas and
corrected/introduced split/merge pairs within each batch. Pair changes use joint
counts rather than allocating all sample pairs. Labeled clustering can earn
champion tags through the existing paired-noise rule; terminal generic refit
still needs H1's matching adapter.

## Anomaly measurements

Example controller declaration:

```ts
measurement: {
  kind: "anomaly_detection",
  execution: "inductive",
  sampleManifestPath: "/absolute/path/development-samples.json",
  scoreMethod: "score_samples",
  scoreDirection: "lower_is_anomalous",
  anomalyLabel: -1,
}
```

Detection metadata omits targets. Score method/direction and prediction label
semantics are explicit; anomaly scores are not probabilities. Nonfinite scores,
wrong lengths, and invalid predictions fail the trial instead of yielding a
misleading result. Scores-only estimators are supported.

Measurements include score quantiles, ties, constant-score detection, predicted
anomaly fraction when predictions exist, and sensitivity around 50th/90th/95th/
99th score percentiles. Windows are 1% of the score IQR. Quantile alert counts
retain threshold ties rather than pretending the alert budget is exact. These
points are advisory score cutoffs; they do not infer the pipeline's actual
decision boundary or optimize BACC.

Label-free trials can complete the requested full validation scope, but remain
ineligible for promotion. Searches need an explicitly declared proxy objective;
without one, setup rejects selection before a fit or experiment budget is
consumed. See the representation/search packet below.

## Packet 2: representation geometry and advisory search

Schema version 2 requests can declare:

```json
{
  "diagnostics": {
    "representation": {
      "source": "pipeline_features", "metric": "euclidean", "maxRows": 512,
      "dbcv": true
    },
    "predictionStrength": true
  },
  "search": {
    "objective": {"kind": "proxy", "metric": "silhouette", "direction": "maximize"},
    "sampler": "grid",
    "space": {"model__n_clusters": {"type": "categorical", "choices": [2, 3, 4]}}
  }
}
```

`pipeline_features` transforms inputs through the already fitted pipeline prefix.
Custom estimators can declare `source:"method", method:"diagnostic_features"`;
the method takes the supplied frame and returns row-aligned numeric features
without fitting. The harness samples up to `maxRows` (default 512, maximum 2048)
with a seed shared across configurations, bounding dense pairwise computation.
Dense conversion is bounded to two million cells. These bounds apply only to
the optional measurement, never to fitting or the model's actual representation.
Invalid/unavailable representations have explicit unavailable diagnostics.

The packet measures feature dimension, constant dimensions, zero norms, norm
spread, silhouette distribution/negative fraction/per-cluster spread, and
Euclidean Calinski–Harabasz and Davies–Bouldin scores. Silhouette supports cosine
distance too. Internal geometry excludes noise and reports sampled coverage;
external ARI still includes every row. Metrics are proxies tied to the declared
representation and distance; they are not comparable across arbitrary feature
spaces, and compact/convex-cluster preferences can mislead.

Opt-in DBCV uses Euclidean all-points core distances, internal
mutual-reachability spanning trees, inter-cluster density separation, and cluster
size weights retaining noise in the denominator. Small/star trees without an
internal edge use all tree edges, explicitly recorded. Clusters with fewer than
three sampled rows and fully collapsed zero-distance partitions are unavailable.
Its definition follows [the authors' DBCV implementation](https://github.com/pajaskowiak/dbcv)
and [the reference API](https://hdbscan.readthedocs.io/en/latest/api.html).

Prediction strength is available for inductive clustering: the primary model
predicts validation rows from its train-only fit; one independent, cloned model
clusters validation inputs using another harness seed. The diagnostic measures
the minimum within-reference-cluster co-membership recovery, following
[Tibshirani and Walther](https://sites.stat.washington.edu/wxs/Stat592-w2011/Literature/tibshirani-walther-prediction-strength-2005.pdf).
Both fits omit family targets. Extra fits record lifecycle, rows, seed,
convergence and cost under the same run/invocation; measured fit cost includes
them. Singleton reference clusters are unavailable; predicted noise is not a
successful co-membership. Batch clusterers remain supported and simply lack this
inductive diagnostic. No extra fit occurs unless requested.

Explicit proxy search supports `silhouette`, `calinskiHarabasz`, `daviesBouldin`,
`dbcv`, or `estimator_score`. Geometry objectives require the corresponding
diagnostics; `estimator_score` calls the fitted model's `score()` on validation
inputs. Direction is required; minimization negates only the search selection
score while retaining its raw value. Fold `searchObjective`/`searchScore` and the
search report identify proxy selection separately from trusted primary metrics.
Unavailable objectives fail that search configuration. Label-free results never
receive fabricated ARI/BACC or champion tags. Follow-up fixed requests retain
the diagnostics; their controller evidence rules determine eligibility.

## Stability

Different repeats supply harness-seeded fits and resampled validation batches.
Clustering compares partitions with ARI on common IDs. Detection compares score
rankings with Spearman/Kendall correlation and top-anomaly-set Jaccard overlap
at 1%, 5%, and 10% budgets. Tied ranking boundaries are flagged; ID order breaks
ties deterministically and therefore tied overlaps must be interpreted cautiously.
Constant score vectors have unavailable rank correlations.

Stability does not compare disjoint populations, pool cluster IDs, or pool raw
score scales from different fitted models. It reports unavailable evidence if
different repeats have fewer than two common IDs. Deterministic measurement
sampling retains at most 100 eligible batch comparisons and 10,000 common IDs
per comparison; full counts and the sampling rule accompany the result.
Stable collapsed partitions/constant scores do not establish quality: read
stability alongside structure/score health. No extra fits are started just to
manufacture a stability result.

## Supervised measurements and solve feedback

The existing worker now measures per-class precision/recall/F1 and support,
macro F1, confusion, ROC AUC/AP, probability-versus-margin provenance, diagnostic
threshold optima versus defaults, probability calibration bins, Brier/log loss,
fit time, and convergence on every fixed trial as well as searches.
Ranking summaries average per-fold measurements instead of combining differing
score scales. Probability losses also reflect discrimination, not calibration
alone. Missing capabilities have explicit unavailable reasons.

`experiment_status` trial details and leaderboard rows expose compact diagnostics,
including champion corrected/introduced errors. At most eight batch details are
shown; full diagnostics stay in hashed `trial-result.json`/`metrics.json` and
`fold-results.jsonl`. Checkpointed folds retain their measured diagnostics on
resume. Existing legacy results remain readable without invented measurements.

Fold spread is not a confidence interval. The paired 95% interval is explicitly
approximate and uses the existing standard error of per-fold differences;
training sets overlap, so independence is imperfect. No promotion-rule change
is made by this packet. Threshold optima were chosen on the same validation
labels and are optimistic advisory measurements, not independent evidence or
automatic threshold changes. Sealed confirmation and C1 remain separate work.

## Research basis and remaining options

The first packet follows [scikit-learn's clustering metrics](https://scikit-learn.org/stable/modules/clustering.html#clustering-performance-evaluation),
[outlier/novelty distinction](https://scikit-learn.org/stable/modules/outlier_detection.html),
and [probability calibration definitions](https://scikit-learn.org/stable/modules/calibration.html).
The [outlier model-selection study](https://arxiv.org/abs/2104.01422) supports
keeping label-free proxies distinct from demonstrated detection accuracy.

Remaining options from the research: contamination sensitivity, evidence labels and synthetic
anomaly challenge sets, Mass–Volume/Excess–Mass curves, reconstruction/likelihood
and embedding diagnostics, learning curves, low-FPR operating points, robustness
slices, and corrected CV uncertainty. These are not prerequisites for this packet.
