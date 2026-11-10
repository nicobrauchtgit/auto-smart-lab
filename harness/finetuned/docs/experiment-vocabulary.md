# Folds, splits, iterations, epochs

Five words in this repository mean five different things, two of them are the
same word, and the one everybody reaches for first -- "iteration" -- is used at
two levels that differ by four orders of magnitude in cost. This is the shared
vocabulary, what owns each level, and what the measurements say actually takes
the time.

Measured 2026-09-10 on this machine against the real corpora, scikit-learn
1.9.0. Companion to [experiment-supervision.md](experiment-supervision.md);
the harness numbers behind it are in
[research/sklearn-observability/](research/sklearn-observability/).

## The nesting

Outermost to innermost. Each level multiplies the ones below it.

| Level | One unit is | Owned by | Cost on spam1 |
| --- | --- | --- | --- |
| **Solve iteration** | one agent session plus one measurement | harness (`maxIterations: 6`) | up to a 30-minute session |
| **Sealed split** | development rows against held-out rows | harness, once per run (`sealedFraction`) | free, computed once |
| **Repeat** | one full K-fold pass under a fresh shuffle | agent parameter | K folds |
| **Candidate** | one hyperparameter combination | agent (grid or manual) | K fits |
| **Fold** | one of K partitions; trains on (K-1)/K of the rows | harness assignment, seeded | **~1.4 s** |
| **Fit** | one `estimator.fit(X, y)` call | the estimator | vectorise + classifier |
| **Solver step / epoch** | one iteration inside a single fit | the estimator (`max_iter`) | **0.01-0.12 s total** |
| **Minibatch update** | one parameter update inside an epoch | the estimator (`batch_size`), where it has one | 5.9M/s for SGD, 35/s for an MLP |

A full run is `repeats x candidates x folds` fits. That product is where minutes
come from, and every term in it is a number the agent chooses.

## "Iteration" means two things, and they are not close

`Iteration 2 of 6` in an agent prompt is a solve iteration: a whole session.
`n_iter_` on a fitted estimator is a solver step inside one fit. On spam1 the
first is up to thirty minutes and the second is about two milliseconds.

Worse, `max_iter` does not mean the same thing across estimators:

| Estimator | `max_iter` counts | `n_iter_` reports |
| --- | --- | --- |
| `SGDClassifier` | epochs, i.e. passes over the training rows | epochs actually run |
| `MLPClassifier` | epochs; each is many minibatch updates | epochs actually run |
| `LogisticRegression` (lbfgs) | solver iterations, each a pass over all rows | one entry per class |
| `LinearSVC` | liblinear iterations | iterations actually run |
| Tree ensembles | nothing -- they use `n_estimators`, each a full tree fit | absent |
| `MultinomialNB` | nothing -- one counting pass, no iteration exists | absent |

So "it ran 20 iterations" is not a statement anyone can act on without naming
the estimator. Anything shown to an agent should use that estimator's own unit.

## The three innermost levels are not the same everywhere

A fit is not only epochs. Inside a `Pipeline` the vectoriser is fitted first and
the classifier's epochs run on what it produced, so on text most of a fit sits
at a level with no iterations at all:

```text
fold            1.30 s   <- the unit worth streaming and stopping
|- vectorise    1.28 s   <- 98% of it, not iterative, nothing to converge
`- classifier   0.02 s
   `- 8 epochs x 13,329 per-sample updates = 106,632 events
```

An epoch is one pass over the training rows, but only where epochs exist.
`MultinomialNB` has none: one counting pass is the whole fit. lbfgs and
liblinear count solver steps, and a step touches all the data at least once and
sometimes more, because line search re-evaluates the objective. Under
`partial_fit`, an epoch is whatever the agent's own loop calls one.

The minibatch level does not exist everywhere either. `SGDClassifier` has no
`batch_size` parameter at all -- it updates once per row, sequentially:

```text
SGDClassifier: 8 epochs x 13,329 rows = 106,632 weight updates in 0.018 s
  -> 5.9M updates/second, ~119 nonzero features touched each
MLPClassifier: 3 epochs x ceil(3000/200) minibatches = 45 updates in 1.28 s
```

The same word covers 5.9 million events a second in one estimator and 35 in the
other, so "log every update" is meaningless for one and reasonable for the
other. Both are decided by the estimator, not by the harness.

`partial_fit` is therefore not a mini-batch API. A chunked loop and a single
one-pass `fit` over the same order produce identical weights, and `t_` counts
rows rather than chunks:

```text
identical weights: True          max difference: 1.07e-14
samples counted after 4 chunks of 1,000: t_ = 4001
```

That is convenient: chunk size sets how often the agent gets to look and stop,
without changing the fit at all. It comes with one trap. `fit()` reshuffles
before every epoch and a `partial_fit` loop does not, so the loop sees exactly
the order it is handed. Three epochs of spam1 in label-sorted order scored
**0.7216** against **0.9931** for the same code over a shuffled order.

## Where the time actually goes

One fold, `TfidfVectorizer(max_features=50_000)` plus a classifier:

| | spam1 (16,662 rows) | spam2 (18,756 rows) |
| --- | --- | --- |
| Import scikit-learn (once, cold 9.4 s) | 1.9 s | 2.0 s |
| Load corpus (once) | 0.26 s | 0.63 s |
| **Vectorise (per fold)** | **1.30 s** | **7.26 s** |
| `MultinomialNB` fit | 0.01 s | 0.01 s |
| `LinearSVC` fit | 0.06 s | 0.15 s |
| `LogisticRegression` lbfgs fit | 0.12 s | 0.18 s |
| `SGDClassifier` fit | 0.02 s | 0.05 s |

**The classifier fit is 1-9% of a fold on spam1, and under 2.5% on spam2.** The
vectoriser is the fold. This is the single most important number here, and it
reverses the intuition the supervision design was built on.

The measured "seven of eight epochs wasted" is real and it is worth about
**17 milliseconds**. Converged-fit stopping is not where the time is.

Cost scales with the vectoriser's configuration, not the classifier's, and with
estimators whose cost is superlinear in rows:

| One fold of spam1 | |
| --- | --- |
| `TfidfVectorizer()` word 1-gram | 1.06 s |
| `ngram_range=(1,2)` | 3.72 s |
| `analyzer="char_wb", ngram_range=(2,5)` | **16.65 s** |
| `LogisticRegression(solver="saga", max_iter=200)` | 0.16 s |
| `MLPClassifier((64,), max_iter=30)` on 3,000 rows | **11.94 s** |
| `SVC(kernel="rbf")` on 3,000 rows | **4.05 s** |

Char n-grams over five folds and six candidates is eight minutes of
vectorisation alone. `SVC` is quadratic in rows, so its 4 s on 3,000 rows is
minutes on 13,000.

A grid over classifier parameters re-vectorises the same text for every
candidate, because the vectoriser is refitted inside each pipeline fit.
`Pipeline(memory=...)` caches it, and recovers less than the arithmetic
suggests, because joblib hashes 16,000 documents to decide the cache is warm:

```
3 candidates x 3 folds, no caching        13.9 s   (9 vectorisations)
same grid, Pipeline(memory=...)           11.6 s   (3 vectorisations)
redundant re-vectorisation                 2.3 s   16% of the run
```

## What this means for supervision

The level an agent can stop *inside* a fit is the cheapest level there is. The
expensive levels -- vectorisation, and the `candidates x folds` product -- sit
*between* fits and are not iterative, so there is nothing to converge and
nothing to cut short. Three consequences:

1. **The fold is the unit of progress**, not the epoch. A line per fold, with
   its score and its wall time, is the stream that matters. Per-epoch output is
   noise on a 0.02 s fit.
2. **Stopping means abandoning the remaining folds and candidates**, which is a
   process-group stop, not a callback. Killing a run after fold 2 of 5 saves
   three folds; stopping a converged SGD saves 17 ms.
3. **Silent stretches are normal and long.** A 16.65 s char-n-gram
   vectorisation emits nothing, and neither does an `SVC` fit. Those are the
   gaps the stall rule has to tolerate, and they are properties of the
   configuration rather than of the corpus.

Within-fit stopping keeps its value only where the fit itself is expensive:
`MLPClassifier`, `SVC`, `saga` on a large sparse matrix. There it is worth real
minutes. On a linear model over word 1-grams it is worth nothing, and an agent
told to optimise it is optimising the wrong number.

## Naming to use

- **solve iteration** -- one agent session and its measurement. Never shortened
  to "iteration" next to a solver count.
- **sealed split** -- the harness's held-out rows. Never "test set".
- **fold** -- one of K partitions of the development rows.
- **validation fraction** -- rows `early_stopping` holds out *inside* a fit.
  Not a fold, and not the sealed split.
- **trial** -- one supervised experiment: a whole run of repeats, candidates and
  folds, under one experiment ID.
- **fit** -- one `estimator.fit()` call.
- **solver step**, or the estimator's own word (**epoch** for `SGDClassifier`
  and `MLPClassifier`) -- one iteration inside a fit.
