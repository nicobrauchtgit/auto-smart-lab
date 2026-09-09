# Signal-driven iterative ML pipeline

Status: design direction. The first implementation target is the feature audit
described below.

## Goal

The pipeline should help an agent improve a solution over several attempts. A
high first submission score, such as `0.98`, changes the task. The agent no
longer needs a broad search for any working model. It needs evidence that a
small change corrects more errors than it introduces.

Every attempt is therefore a challenger to the current champion. Each pipeline
stage reports signals that answer a narrower question:

1. Did the proposed representation produce usable data?
2. Does it contain label information?
3. Is that information stable and different from the current baseline?
4. Does a fixed probe model use it successfully?
5. Does the full challenger beat the champion on the same examples?
6. Does the hidden submission score agree with the local evidence?

The pipeline should reject weak ideas as early as possible. Later stages use
stronger evidence but cost more.

## Iteration loop

```text
task and dataset
      |
      v
dataset analysis and web research
      |
      v
feature and model hypotheses
      |
      v
feature extraction
      |
      v
feature audit
  health, relevance, redundancy, stability, shift, probe value
      |
      v
challenger training
      |
      v
paired champion comparison
      |
      v
promotion decision
      |
      v
submission and hidden-score calibration
      |
      +----> focused next research iteration
```

The research agent proposes hypotheses. The statistical pipeline measures them.
The research agent may explain why a result occurred, but its explanation is
not a quality signal by itself.

## Two operating modes

### Discovery mode

Before a champion exists, the feature audit compares representations with fixed
simple probes. The first goal is to establish a reliable baseline and find
feature families with real signal.

### Improvement mode

Once a champion exists, every feature and model is evaluated relative to it.
Absolute performance becomes less useful than paired differences on the same
out-of-fold examples.

At this point the pipeline should tell the agent things such as:

```text
HTML structure is predictive alone, but character n-grams already capture most
of its information. The combined representation corrected 31 champion errors
and introduced 27 new errors. The remaining gain is small and unstable.
```

That is a much better next-iteration signal than either "HTML features are
useful" or "validation score: 0.982".

## Implementation phases

| Phase | Signal group | When it matters | Implementation status |
|---|---|---|---|
| Feature engineering | Representation health | As soon as an extractor produces values | Implement first |
| Feature engineering | Univariate label association | As soon as training labels and feature values exist | Implement first |
| Feature engineering | Internal overlap and redundancy | As soon as a feature group exists | Implement first |
| Feature engineering | Stability across fixed folds | During the first feature audit | Implement first |
| Feature engineering | Train/test feature shift | As soon as train and test features exist | Implement first |
| Feature engineering | Label-permutation null checks | When many candidate columns or feature groups are searched | Implement first |
| Feature engineering | Fixed probe performance | After the basic statistics pass | Implement first |
| Feature engineering | Incremental value over a baseline | Once the first baseline exists | Implement first, activate when a baseline is available |
| Model development | Full model comparison | After feature groups survive the audit | Implement next |
| Model development | Threshold and calibration analysis | After models produce out-of-fold scores | Implement next |
| Model development | Error overlap and ensemble potential | After two or more models exist | Implement next |
| Submission | Local versus hidden-score calibration | After the first submission | Implement later |
| Competing pipelines | Branch comparison and idea unification | After the single champion/challenger loop is reliable | Implement later |

## Source map by pipeline idea

The pipeline is a synthesis. The table below records which sources motivate
each idea and how directly they support it. "Engineering synthesis" means that
the sources establish the underlying statistical method, while the way we
combine or expose it is our design.

| Pipeline idea | Sources searched | Relationship to this design |
|---|---|---|
| Treat each attempt as a challenger to the current best solution | [Wrappers for Feature Subset Selection](https://doi.org/10.1016/S0004-3702(97)00043-X); [CAAFE](https://papers.nips.cc/paper_files/paper/2023/hash/8c2df4c35cdbee764ebb9e9d0acd5197-Abstract-Conference.html); [Human-LLM Collaborative Feature Engineering](https://openreview.net/forum?id=ohVOD2ixBH) | Wrapper selection evaluates candidates through downstream performance. CAAFE keeps or rejects generated features after evaluation. The human-LLM work separates proposal from utility-based selection. Calling the retained solution a champion is our terminology. |
| Use an LLM to propose features but not judge its own proposals | [CAAFE](https://papers.nips.cc/paper_files/paper/2023/hash/8c2df4c35cdbee764ebb9e9d0acd5197-Abstract-Conference.html); [ELF-Gym](https://doi.org/10.1145/3627673.3679153); [Human-LLM Collaborative Feature Engineering](https://openreview.net/forum?id=ohVOD2ixBH) | Directly supported. ELF-Gym shows a large gap between semantic similarity to expert ideas and functional similarity to their implementations. |
| Feed measured results from earlier attempts into the next research iteration | [OCTree](https://proceedings.neurips.cc/paper_files/paper/2024/file/a7ebe2e8d8cfd2fcec6cd77f9e6fd34d-Paper-Conference.pdf); [PromptFE](https://aclanthology.org/2026.eacl-long.28/) | Directly supported. Both methods use results from previous feature experiments to guide later LLM proposals. Our compact signal summary replaces their exact feedback formats. |
| Measure dimensions, sparsity, constants, coverage, duplicates, memory, and extraction cost | [An Introduction to Variable and Feature Selection](https://jmlr.org/papers/v3/guyon03a.html); [An Extensive Empirical Study of Feature Selection Metrics for Text Classification](https://jmlr.org/papers/v3/forman03a.html) | Standard feature-screening and engineering practice. Forman studies document-frequency pruning and representation size in text classification. Runtime and serialized size are engineering criteria, not evidence of label signal. |
| Measure class association with AUC, chi-square, mutual information, log odds, and class-conditional distributions | [An Introduction to Variable and Feature Selection](https://jmlr.org/papers/v3/guyon03a.html); [An Extensive Empirical Study of Feature Selection Metrics for Text Classification](https://jmlr.org/papers/v3/forman03a.html); [Minimum Redundancy Maximum Relevance](https://doi.org/10.1109/TPAMI.2005.159) | Directly supported as filter feature selection. The exact set of statistics by data type is our implementation choice. |
| Evaluate sparse text representations as groups as well as individual columns | [An Extensive Empirical Study of Feature Selection Metrics for Text Classification](https://jmlr.org/papers/v3/forman03a.html); [Baselines and Bigrams](https://aclanthology.org/P12-2018/); [LLM-based Feature Generation from Text for Interpretable Machine Learning](https://arxiv.org/abs/2409.07132) | Forman evaluates selected token sets through classifiers. Wang and Manning demonstrate that combinations of simple text features can be strong. The LLM text-feature paper compares generated feature sets alone and combined with TF-IDF. |
| Balance label relevance against redundancy with existing features | [Minimum Redundancy Maximum Relevance](https://doi.org/10.1109/TPAMI.2005.159); [An Introduction to Variable and Feature Selection](https://jmlr.org/papers/v3/guyon03a.html) | Directly supported. Pairwise correlation, Jaccard, Cramer's V, and cosine similarity are type-specific implementations of the broader redundancy question. |
| Compare baseline, candidate, and combined features with fixed probes | [Wrappers for Feature Subset Selection](https://doi.org/10.1016/S0004-3702(97)00043-X); [CAAFE](https://papers.nips.cc/paper_files/paper/2023/hash/8c2df4c35cdbee764ebb9e9d0acd5197-Abstract-Conference.html); [LLM-based Feature Generation from Text for Interpretable Machine Learning](https://arxiv.org/abs/2409.07132) | Directly supported in principle. The fixed untuned probe suite is our attempt to make wrapper evidence cheap and comparable across agent proposals. |
| Measure feature and score stability across resamples | [Stability Selection](https://doi.org/10.1111/j.1467-9868.2010.00740.x); [On the Stability of Feature Selection Algorithms](https://jmlr.org/papers/v18/17-514.html); [Multi-level Diagnosis and Evaluation for Robust Tabular Feature Engineering with Large Language Models](https://aclanthology.org/2025.findings-emnlp.249/) | The first two establish resampling-based feature stability. The LLM study shows that LLM feature judgments vary across datasets and runs. Our fold-level effect and rank summary is a simpler diagnostic than full stability selection. |
| Compare searched features with a shuffled-label null | [Permutation Tests for Studying Classifier Performance](https://jmlr.org/papers/v11/ojala10a.html) | Directly supported. Matching the null search to the real search granularity is our application of the permutation principle to many LLM-generated candidates. |
| Detect train/test feature shift without test labels | [Failing Loudly](https://papers.nips.cc/paper/2019/hash/846c260d715e5b854ffad5f70a516c88-Abstract.html); [Revisiting Classifier Two-Sample Tests](https://arxiv.org/abs/1610.06545) | Directly supported for shift detection. Our use of simple per-feature checks before a domain classifier is an implementation order, not a claim that one statistic is universally best. |
| Perform supervised feature selection inside each training fold | [Selection Bias in Gene Extraction](https://doi.org/10.1073/pnas.102102699); [Bias in Error Estimation When Using Cross-Validation for Model Selection](https://doi.org/10.1186/1471-2105-7-91) | Directly supported. Both works show that selection or tuning performed before evaluation can produce optimistic error estimates. |
| Compare champion and challenger on the same examples | [Approximate Statistical Tests for Comparing Supervised Classification Learning Algorithms](https://doi.org/10.1162/089976698300017197) | Directly supports paired comparison and warns against naive tests on reused cross-validation folds. The proposed stratified paired-bootstrap interval for balanced accuracy is our estimation choice. Formal testing may use McNemar's test or repeated `5 x 2` cross-validation where appropriate. |
| Inspect corrected errors, introduced errors, and disagreement | [Approximate Statistical Tests for Comparing Supervised Classification Learning Algorithms](https://doi.org/10.1162/089976698300017197); [Ensemble Selection from Libraries of Models](https://www.cs.cornell.edu/~caruana/ctp/ct.papers/caruana.icml04.icdm06long.pdf) | Dietterich studies paired classifier differences, including McNemar's test. Caruana et al. select combinations of accurate, diverse models. Our corrected-versus-introduced report is a concrete diagnostic built from paired predictions. |
| Evaluate threshold sensitivity instead of assuming `0.5` | [A Unified View of Performance Metrics](https://jmlr.org/papers/v13/hernandez-orallo12a.html) | Directly supported. The paper treats threshold choice as part of classifier evaluation and relates it to operating conditions, class distributions, and calibration. |
| Use out-of-fold ensemble selection to unify complementary models | [Ensemble Selection from Libraries of Models](https://www.cs.cornell.edu/~caruana/ctp/ct.papers/caruana.icml04.icdm06long.pdf) | Directly supports metric-driven forward selection from a library of model predictions. Requiring out-of-fold predictions and reevaluating the ensemble as a challenger are our safeguards against training-data selection. |
| Run several competing pipelines on shared folds | [Ensemble Selection from Libraries of Models](https://www.cs.cornell.edu/~caruana/ctp/ct.papers/caruana.icml04.icdm06long.pdf); [Human-LLM Collaborative Feature Engineering](https://openreview.net/forum?id=ohVOD2ixBH) | Engineering synthesis. The sources support candidate libraries, explicit utility estimation, and selection. Parallel research agents are our way to generate diverse candidate branches. |
| Guard against repeated optimization on the same folds or hidden score | [The Ladder](https://proceedings.mlr.press/v37/blum15.html); [The Reusable Holdout](https://doi.org/10.1126/science.aaa9375); [Selection Bias in Gene Extraction](https://doi.org/10.1073/pnas.102102699) | Directly supported as adaptive evaluation and selection-bias problems. The proposed locked confirmation split, nested evaluation, and submission restraint are practical safeguards for our setting. |

This mapping also marks where the evidence stops. No source establishes that a
particular combination of these signals can deterministically certify a good
feature. Filters, probes, resampling, null tests, and shift checks provide
different evidence. The final claim that a feature improves the current
solution still comes from a paired evaluation on unseen examples.

## Feature audit

The feature audit is the first implementation target. It consumes extracted
training features, labels, matching test features, fixed folds, and optionally
the current baseline features and out-of-fold predictions.

It evaluates individual scalar features and complete feature groups. Group
evaluation is required for sparse text representations because thousands of
weak token features may work well together even when no individual column is
decisive.

### Representation health

These checks find broken or wasteful representations:

- number of rows and columns;
- dense or sparse storage;
- nonzero values per example and matrix density;
- missing, infinite, invalid, and unparseable values;
- constant and near-constant columns;
- exact duplicate columns;
- cardinality and rare-value counts for categorical features;
- extraction time, peak memory, and serialized size.

These signals do not establish predictive quality. They tell us whether the
representation is usable and how much it costs.

### Label association

The audit should choose statistics based on the feature type.

For numeric features:

- class-conditional median, quantiles, and zero rate;
- ROC AUC in both directions;
- mutual information;
- a two-sample distribution statistic;
- balanced accuracy from a single threshold learned inside each training fold.

For binary features:

- prevalence per class;
- smoothed log odds;
- chi-square and mutual information;
- balanced accuracy from the binary decision.

For categorical features:

- cardinality and rare-category fraction;
- class-conditional category distributions;
- mutual information and Cramer's V;
- unseen-category rate in validation and test data.

For sparse text features:

- document frequency per class;
- chi-square, mutual information, or another suitable ranking statistic;
- the number and proportion of columns with stable signal;
- the distribution of signal across the feature group, not only the best
  column.

All supervised preprocessing and feature ranking must happen inside the
training portion of each fold. Calculating label association on the full
dataset and then cross-validating selected features would leak validation
information.

### Redundancy and overlap

Overlap has several meanings and needs several measurements:

- exact equality for duplicate columns;
- Pearson and Spearman correlation for numeric columns;
- Jaccard similarity or agreement for binary columns;
- mutual information or Cramer's V for categorical columns;
- cosine similarity for sparse columns or compact feature summaries;
- approximate rank or effective dimensionality for large feature groups when
  it is practical to compute.

Pairwise similarity only detects direct redundancy. The stronger test compares
fixed probe performance:

```text
baseline features            -> score A
candidate features           -> score B
baseline + candidate         -> score C

incremental value            -> C - A
```

If `B` is strong and `C - A` is near zero, the candidate is descriptive but
redundant with the baseline.

### Stability

For each fold or deterministic resample, record:

- effect direction;
- effect magnitude;
- feature rank;
- selection frequency;
- probe score;
- incremental probe delta.

A useful signal should not depend on a single fold or a few unusual examples.
The report should show the distribution of results, not only the mean.

### Null comparison

Searching many features creates accidental winners. The audit should repeat
the relevant statistic or probe after shuffling labels. The observed result is
then compared with the best results obtained under the shuffled-label null.

This comparison should operate at the same search granularity. If the real run
selects the best of 20,000 columns, each null run must also select the best of
20,000 columns. Comparing the winning real feature with the null distribution
of an average feature would be misleading.

### Train/test shift

Test labels are unavailable, but the audit can compare feature distributions:

- numeric distribution distance;
- categorical Jensen-Shannon divergence;
- unseen-category and out-of-vocabulary rate;
- matrix density and nonzero values per example;
- a domain classifier that tries to distinguish train rows from test rows when
  the simpler checks warrant it.

A detected shift is a warning. It does not prove that the feature is harmful.

### Fixed feature probes

The pipeline should provide a small fixed set of probe models. The proposing
agent does not select or tune these models. They are measuring instruments.

Initial probes should cover:

- a dummy classifier;
- a regularized linear classifier for numeric and sparse representations;
- a Naive Bayes probe for nonnegative count features;
- a shallow tree for simple nonlinear relationships.

Each probe uses the same stored stratified folds and reports balanced accuracy,
per-class recall, fold variation, training cost, and out-of-fold predictions.
The exact available probes may depend on the execution environment. The
statistical comparison matters more than a specific library implementation.

## Feature-audit output

The main output should be compact measurements suitable for both an agent and a
human. For example:

```text
Feature group: HTML structure

Representation
  shape:                         16,662 x 28
  constant columns:             3
  duplicate columns:            2
  median nonzeros per example:  7

Association
  candidate-only BACC:          0.761 +/- 0.019
  stable useful columns:        6 / 28
  shuffled-null warning:        no

Overlap
  text baseline BACC:           0.9821
  combined BACC:                0.9840
  paired delta:                +0.0019
  folds improved:               4 / 5

Shift
  strongly shifted columns:     2

Cost
  extraction time:              0.7 ms per document

Interpretation
  The group contains stable label signal. Most of that signal overlaps with
  the text baseline, but the paired probe result justifies full evaluation.
```

The numbers should remain the source of truth. The final interpretation can be
generated from explicit rules or by an agent that receives only the compact
measurements.

## Model-development signals

These signals come after feature groups survive the feature audit.

### Paired champion comparison

Train the champion and challenger on identical folds. Preserve out-of-fold
scores and predictions for each example. Report:

- mean out-of-fold balanced accuracy;
- paired balanced-accuracy delta;
- a stratified paired-bootstrap interval for the delta;
- fold-by-fold deltas;
- per-class recall deltas;
- errors corrected by the challenger;
- new errors introduced by the challenger;
- probability correlation and disagreement rate;
- training and inference cost.

At high scores, corrected and introduced errors are often more informative than
the aggregate score. A change from `0.980` to `0.982` is a ten percent reduction
of the remaining balanced error, but the result is only credible if the paired
comparison is stable.

### Threshold signals

When a model emits scores or probabilities, evaluate:

- balanced accuracy across nearby thresholds;
- per-class recall across those thresholds;
- whether the selected optimum is broad or fragile;
- the out-of-fold threshold and its variation across folds.

Threshold selection must use training or out-of-fold predictions. It must not
use hidden test feedback.

### Ensemble signals

For every pair of models, measure:

- prediction correlation;
- disagreement rate;
- error overlap;
- corrected-versus-introduced errors;
- oracle score if the correct member could be chosen for each example;
- actual score from a simple averaging or voting rule.

The oracle score is diagnostic only. It estimates whether useful diversity
exists. It is not an achievable result by itself.

## Submission signals

After submission, compare the hidden score with the local estimate:

```text
local out-of-fold BACC:        0.984
local uncertainty interval:   0.981 to 0.987
hidden score:                  0.980
local-to-hidden gap:          -0.004
```

The hidden score calibrates trust in local evaluation. A repeated gap can point
to validation leakage, split mismatch, train/test shift, over-search, or a
submission bug. One scalar hidden score cannot identify which feature failed.

Repeated submission feedback must not replace local evaluation. Optimizing many
attempts against the same hidden score can overfit the submission set.

## Competing challenger pipelines

Once the single challenger loop is reliable, several agents or pipelines can
try different approaches on the same fixed folds. "Adversarial" here means
competing attempts that challenge the champion, not adversarial examples or
attack generation.

Candidate branches might focus on:

- word and character representations;
- parsed document structure;
- metadata or statistical summaries;
- nonlinear models;
- threshold changes;
- complementary ensembles.

Because every branch uses the same folds, their out-of-fold predictions are
directly comparable. Selection should consider both performance and
complementarity.

The unification stage can try two different operations:

1. Combine successful feature groups and retrain one model.
2. Combine complementary model predictions using out-of-fold ensemble
   selection.

A feature union can expose useful interactions but also add redundancy. A model
ensemble can exploit different error patterns without merging incompatible
representations. Both must be evaluated as new challengers rather than assumed
to inherit the gains of their components.

The unification criterion should use paired out-of-fold improvement, stability,
per-class effects, error complementarity, and cost. It should not select ideas
by averaging the agents' written confidence.

## Avoiding evaluation overfit

Fixed folds make experiments comparable, but repeated optimization against the
same folds will eventually overfit them. The pipeline should therefore separate
development feedback from final confirmation.

Possible safeguards include:

- an untouched local confirmation split;
- nested evaluation for feature and model selection;
- rotating development folds while preserving a locked confirmation set;
- label-permutation controls for large searches;
- tracking how many alternatives were compared before declaring a gain.

The first implementation does not need every safeguard. It should preserve the
ability to add them without changing the meaning of earlier scores.

## Promotion logic

Do not use one universal minimum score improvement. Promote a challenger when
the evidence supports the change:

- paired local performance improves relative to its uncertainty;
- gains occur across folds rather than in one split;
- neither class suffers an unacceptable recall regression;
- feature and prediction shifts have been inspected;
- a large feature search clears its null comparison;
- the gain justifies the added extraction and inference cost.

The champion remains unchanged when the result is inconclusive. An inconclusive
experiment can still produce a useful signal for the next research iteration.

## Recommended implementation order

### First: feature engineering signals

- matrix shape, sparsity, coverage, constants, and duplicates;
- type-specific univariate association;
- internal redundancy and overlap;
- fixed stratified folds and fold-level results;
- label-permutation null comparison;
- train/test feature shift;
- fixed probe models;
- baseline, candidate, and combined probe comparison;
- compact machine-readable and Markdown summaries.

### Next: model comparison

- preserved out-of-fold predictions;
- paired champion/challenger deltas;
- stratified paired-bootstrap intervals;
- corrected and introduced error analysis;
- threshold diagnostics;
- ensemble diversity signals.

### Later: iterative and competing pipelines

- local-to-hidden score calibration;
- focused research feedback from measured failures;
- several challenger branches on shared folds;
- feature-group union experiments;
- out-of-fold ensemble selection;
- safeguards against repeated-selection overfit.

## Research basis

The design combines established data-science methods with recent LLM feature
engineering work:

- Guyon and Elisseeff, [An Introduction to Variable and Feature
  Selection](https://jmlr.org/papers/v3/guyon03a.html), for filter, wrapper,
  embedded, and validity perspectives.
- Kohavi and John, [Wrappers for Feature Subset
  Selection](https://doi.org/10.1016/S0004-3702(97)00043-X), for evaluating
  feature subsets through their interaction with a learner.
- Peng, Long, and Ding, [Feature Selection Based on Mutual Information: Criteria
  of Max-Dependency, Max-Relevance, and
  Min-Redundancy](https://doi.org/10.1109/TPAMI.2005.159), for relevance versus
  redundancy.
- Forman, [An Extensive Empirical Study of Feature Selection Metrics for Text
  Classification](https://jmlr.org/papers/v3/forman03a.html), for supervised
  feature screening in sparse and imbalanced text tasks.
- Meinshausen and Buhlmann, [Stability
  Selection](https://doi.org/10.1111/j.1467-9868.2010.00740.x), and Nogueira,
  Sechidis, and Brown, [On the Stability of Feature Selection
  Algorithms](https://jmlr.org/papers/v18/17-514.html), for resampling-based
  feature stability.
- Ojala and Garriga, [Permutation Tests for Studying Classifier
  Performance](https://jmlr.org/papers/v11/ojala10a.html), for label and feature
  permutation controls.
- Rabanser, Guennemann, and Lipton, [Failing Loudly: An Empirical Study of
  Methods for Detecting Dataset
  Shift](https://papers.nips.cc/paper/2019/hash/846c260d715e5b854ffad5f70a516c88-Abstract.html),
  for two-sample and domain-classifier shift detection.
- Hollmann, Mueller, and Hutter,
  [CAAFE](https://papers.nips.cc/paper_files/paper/2023/hash/8c2df4c35cdbee764ebb9e9d0acd5197-Abstract-Conference.html),
  for LLM-proposed executable features evaluated by conventional models.
- Nam et al., [OCTree](https://proceedings.neurips.cc/paper_files/paper/2024/file/a7ebe2e8d8cfd2fcec6cd77f9e6fd34d-Paper-Conference.pdf),
  for returning structured experimental feedback to the next LLM iteration.
- Zhang et al., [ELF-Gym](https://doi.org/10.1145/3627673.3679153), for
  separating semantically plausible features from functionally correct and
  performance-improving features.
- Li et al., [Human-LLM Collaborative Feature
  Engineering](https://openreview.net/forum?id=ohVOD2ixBH), for separating LLM
  proposal generation from utility-based selection.

## Non-goals

- A large validation contract for research prose.
- A single universal feature-quality score.
- Letting an LLM judge its own proposals from their descriptions.
- Treating dimensionality or sparsity as proof of predictive quality.
- Assuming that individually strong ideas remain strong after they are
  combined.
