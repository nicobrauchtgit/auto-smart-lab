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

## Packet 3: anomaly evidence, model signals and challenges

The controller may add diagnostic evidence to `anomaly_detection`:

```ts
evidence: {path: "/absolute/path/evidence.json", source: "trusted"}
// Alternatively source: "agent_provided".
```

The file is bounded to 8 MiB and has `schemaVersion:1, labels:[{id,target}]`,
where targets are integer 0/1 with 1 anomalous. It may cover a subset of the
development IDs; duplicates, unknown IDs, invalid labels and hash drift fail
preflight before agent-code imports. Source and SHA-256 join setup events,
the invocation, result and recovery data identity. A metadata edit requires a
new controller invocation. This does not authorize supplying sealed labels.

Per-batch evidence records labelled coverage, observed prevalence, ROC AUC/AP,
prediction BACC/class metrics when predictions exist, and an advisory best
threshold. Only supplied labels are scored; missing labels are never normal by
default. Single-class evidence explicitly lacks ranking/BACC. Evidence stays
outside fit inputs and feature hooks, including propagated pandas attributes.
This is an invocation contract, not filesystem isolation. Trusted evidence is
identified as such; agent-provided labels are proxies. Neither changes the
controller's label-free promotion policy. An explicit search objective may use
`evidence_roc_auc` or `evidence_average_precision`, requiring both classes in each
measured batch; its selection remains advisory.

Additional schema version 2 diagnostics are opt-in:

```json
{
  "modelSignals": {"method": "diagnostic_signals", "compareTrain": true, "units": "nats"},
  "challenge": {"method": "diagnostic_challenge", "maxRows": 512},
  "contamination": {"parameter": "model__contamination", "values": [0.01, 0.05, 0.1]},
  "representation": {"source": "pipeline_features"},
  "volume": {
    "bounds": [[-5, 5], [-5, 5]], "scoreSource": "pipeline_model",
    "scoreMethod": "score_samples", "uniformSamples": 2048
  }
}
```

`diagnostic_signals(frame)` returns row-aligned `reconstructionError` (nonnegative)
and/or `logLikelihood` vectors. The harness samples rows and computes distributions
in the declared units. Optional train comparison reports resubstitution means
and validation-minus-training gaps; batch execution lacks an independently
fitted train population. These are model-specific outputs, not universally
comparable losses or direct evidence of anomaly accuracy. No extra fit is used.

`diagnostic_challenge(frame, {seed,maxRows})` returns `{frame,labels}` with the same
input columns, unique IDs, bounded rows, and binary anomaly labels. It receives
validation inputs only, never training or evidence labels. The fitted model
scores those agent-designed synthetic examples; the result records generator
method, harness seed, content hash, source `synthetic`, and ranking/prediction
metrics. Simple artificial anomalies can be easy and unrepresentative; these
challenge scores cannot promote. Fitted-row-only attributes cannot score a new
challenge population. Diagnostic hooks must be read-only; known fitting/mutation
methods cannot be selected as hooks. Arbitrary Python purity is not sandboxed.

Contamination sensitivity clones the candidate for each declared value, retains
its primary estimator seed, and fits under the shared harness lifecycle. A value
matching the primary parameter reuses that fit. Each point reports score-rank
agreement, decision changes, anomaly fraction, score health and convergence.
Extra fits omit targets and add to measured cost; they never alter the primary
model or automatically change its contamination setting. Up to five values are
allowed for this optional measurement.

Mass–Volume and Excess–Mass use harness-seeded uniform reference samples in a
declared feature-space box with one to six dimensions. The fitted final pipeline
model scores those features, or a declared custom feature-scoring method does.
Feature-space scores must reproduce the authoritative validation scores; bounds
must cover observed diagnostic features. The implementation estimates level-set
volume, reports tied-mass overshoot and Monte Carlo standard error, and returns
EM curves/area over the explicit `[0,1/supportVolume]` range. Defaults use 2048
reference points, bounded to 8192. No fit is used. Comparisons require the same
feature units, support, sampling scheme and scoring semantics. Curves are
conditional proxies, not estimates of real-world detection accuracy. Definitions
follow [Goix's evaluation study](https://arxiv.org/abs/1607.01152) and
[the Excess–Mass paper](https://arxiv.org/abs/1502.01684).

## Packet 4: operating points, slices, learning and robustness

Binary supervised trials, labelled anomaly evidence and synthetic challenges
report attainable recall/precision at FPR caps of 0.1%, 1% and 5%, plus
standardized partial ROC AUC. Recall uses observed thresholds without
interpolation; tied scores stay together. Negative-row counts and `fprResolution`
identify caps below one observable false positive. Partial AUC uses
[scikit-learn's standardized definition](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.roc_auc_score.html),
whose chance value is 0.5. Diagnostic thresholds are selected on evaluation
labels and remain advisory. The pipeline's existing decisions also report
conditional binomial intervals for FPR and recall, assuming independent rows
and a fixed decision rule; these intervals do not apply to the selected
diagnostic thresholds. Zero observed false positives does not give a zero upper
bound. Missing scores or either class make operating points unavailable.

Probability calibration includes `binaryPositiveProbabilityEce`, a weighted
absolute gap between mean positive probability and observed positive frequency
in ten fixed bins. It depends on binning and sample size, alongside the existing
Brier/log loss and reliability bins. This is a binary probability summary;
[calibration research](https://proceedings.mlr.press/v70/guo17a.html) motivates
reading such estimates alongside reliability diagrams.

Schema version 2 accepts these optional diagnostics across task kinds:

```json
{
  "diagnostics": {
    "slices": {"method": "diagnostic_slices", "maxGroups": 16},
    "learningCurve": {"fractions": [0.25, 0.5, 1]},
    "robustness": {"method": "diagnostic_changes", "maxRows": 512, "maxVariants": 4}
  }
}
```

`diagnostic_slices(validation_frame)` returns a dictionary of named Boolean
masks with one entry per validation row. Groups may overlap; empty groups are
unavailable. Defaults allow 16 groups, bounded to 32. The harness reuses its
predictions and measurements to score each group, with row counts, coverage,
task metrics and capability reasons. A single-class supervised slice lacks
BACC/ranking while retaining class counts and errors. Anomaly slices score only
the evidence actually supplied for those IDs. No fit is added. Slice definitions
are agent-designed exploratory evidence, not independent confirmation.

Learning curves use one to six unique fractions of each existing training
fold. Harness-seeded, nested uniform subsets share the estimator seed; every
point measures the same full held-out validation rows. The full-size fit and
duplicate rounded subset sizes are reused. Additional fits record lifecycle,
scope, seed, input ID hashes, convergence and cost; failed small subsets produce
unavailable points. Supervised fits receive only their own subset targets;
unsupervised fits receive none. Batch discovery reports this train-only curve
unavailable because its fit population is different. This follows the usual
[learning-curve validation design](https://scikit-learn.org/stable/modules/learning_curve.html)
without prescribing model choices or accessing sealed confirmation rows.

`diagnostic_changes(validation_frame, {seed,maxRows,maxVariants})` returns a
list of `{name,frame,labelPreserving}` records. Each frame must preserve the
sampled row IDs, order and input columns; names are unique. Defaults sample 512
rows and allow four variants, bounded to 2048 rows/eight variants. Inductive
models reuse their fitted primary model. Batch models refit a baseline and each
variant on the same sampled population with the same estimator seed, avoiding
confounding from a changed batch size. These fits are observed and charged.
Clustering agreement uses label-invariant ARI; prediction changes and score-rank
agreement are available for other tasks. Quality metrics use original labels
only when `labelPreserving:true`; otherwise quality is unavailable. The
label-preservation assumption is explicitly agent-declared. Content hashes,
sampling scope and capability failures accompany all variants. Hooks receive
input frames without evidence attributes and must not fit or mutate models.

Paired champion and search comparisons now include advisory
`correctedCvUncertainty` using the
[Nadeau–Bengio corrected resampled t approximation](https://proceedings.neurips.cc/paper_files/paper/1999/file/7d12b66d3df6af8d429c1a357d8b9e1a-Paper.pdf):
sample variance is multiplied by `1/n + mean(validationRows/trainRows)`, with
Student-t critical values. It requires at least two paired inductive folds and
recorded scope; batch fits lack this train-overlap interpretation. It is
approximate, assumes independent original examples and does not correct search
selection bias. Zero empirical variance is flagged. The existing promotion
rule remains unchanged.

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
shown, with at most eight slice groups per fold. Nested contingency tables,
per-cluster details, reliability bins and EM grid points are omitted from status;
full diagnostics stay in hashed `trial-result.json`/`metrics.json` and
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

The researched measurement packets are implemented, including learning curves,
low-FPR operating points, robustness/slices and corrected CV uncertainty.
Remaining documented work is integration and additional validation safeguards:
H1/H2 task declarations and stage adapters, C1's ID leakage canary, C2's
independent held-back confirmation, and C4's cross-run comparison history.
H4's observed PyTorch training and gradient-based robustness are separate work;
the generic perturbation hooks do not implement FGSM/PGD evaluation.
