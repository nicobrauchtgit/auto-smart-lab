## Fit so you can see it happen

A fit you cannot watch is a fit you cannot stop. `Pipeline(...).fit(X, y)` on a
corpus this size prints nothing, returns nothing until it is finished, and gives
you no evidence about whether the last nine tenths of it bought anything. That
is the default, and it is the thing to avoid.

### Start with a pilot

Begin every new idea with a deliberately small fit: a stratified development
subset, a single validation fold, or a few epochs. Size it to the estimator
rather than to a fixed number -- a few optimisation steps is a pilot for
`SGDClassifier`, one fold on a subset is a pilot for `LinearSVC`.

Then read the pilot before spending more: completed steps against configured
steps, wall time, training and validation metrics, warnings, convergence status.
Expand only where the measurements say more work helps. A curve still climbing
at the pilot boundary earns more data or more iterations. A flat one does not,
and the pilot has already told you so at a fraction of the price.

Keep the validation subset and the seed fixed when you compare trials at the
same scope, and say in `notes.md` which numbers came from a pilot. A pilot
result is evidence for your next decision, not a cross-validation score.

### Make progress exist

Progress is a property of how you write the fit, not something the harness can
add afterwards. Three regimes, and only the third is genuinely dark:

- **Iterative optimisation** -- `SGDClassifier`, `MLPClassifier`,
  `LogisticRegression` with the lbfgs solver. A true loss exists per step.
- **Incremental** -- twelve classifiers expose `partial_fit`, including the
  whole naive Bayes family. No loss exists, but a learning curve over rows seen
  does.
- **Single-shot analytic** -- `LinearSVC`, `SVC`, `LDA`, `QDA`,
  `KNeighborsClassifier`, single trees. Nothing exists to report during the fit.
  Do not invent progress for these, and do not switch estimators to gain
  telemetry. Pilot them on a subset instead.

For the first two, drive the loop yourself and print one labelled line per step:

```python
for start in range(0, n, batch):
    clf.partial_fit(Vtr[start:start + batch], ytr[start:start + batch], classes=classes)
    seen = min(start + batch, n)
    print(f"seen={seen}/{n} val_bacc={balanced_accuracy_score(yva, clf.predict(Vva)):.4f}", flush=True)
```

That loop is what turned an opaque `MultinomialNB` fit into a curve showing that
rows past roughly 8,000 bought 0.001 on one task, while the same code on another
task was still climbing at 15,000. Neither answer was knowable without it.

**Shuffle the order yourself.** `fit()` reshuffles the rows before every epoch;
a `partial_fit` loop does not, and feeds the model exactly the order you hand
it. On spam1, three epochs in label-sorted order scored **0.7216** against
**0.9931** for the same code over a shuffled order. That is the largest
single mistake available in this pattern, and it looks like nothing:

```python
order = np.random.default_rng(seed).permutation(len(ytr))   # re-draw per epoch
```

**The batch size is not a modelling decision.** `SGDClassifier` has no
`batch_size` at all -- it updates once per row, in sequence, whatever chunk you
hand it. A chunked `partial_fit` loop and a single one-pass `fit` over the same
order produce identical weights to 1e-14. So pick the chunk size for how often
you want to see a score, not to tune the model; it does not change the maths.
`MLPClassifier` is the exception, and there `batch_size` is a real parameter.

The same shape over `cross_validate` is a loop over `StratifiedKFold` splits with
a printed score per fold. One opaque call and a fold loop cost the same and only
one of them tells you anything while it runs.

Print `flush=True`, or your lines sit in an 8 KB buffer until the process exits.

### How often, and what to measure

Emit generously. On spam1 one SGD epoch over 13,329 rows costs 3.7 ms and one
validation score costs 1.1 ms, so scoring every epoch adds 30% to the classifier
fit and about 0.5% to the fold -- the vectoriser is the fold, not the
classifier. Even scoring thirteen times an epoch lands at 11% of the fold. The
line count is not the problem.

What you compute for each line is. Training loss over the whole training set
costs **36.2 ms, ten times an epoch**, and it is the one telemetry that reliably
costs more than the thing it measures. Score a fixed validation subset instead,
and keep that subset and its seed constant so the series is comparable across
trials.

A useful default: one labelled line per epoch, or per fold for a batch
estimator. Go finer when the fit is expensive enough to be worth interrupting --
an `MLPClassifier` epoch is 323 ms, where the score disappears into the noise.

### Decide in the loop, report for the next trial

Write your convergence rule into the loop. A `break` on patience and tolerance
fires the instant the condition holds and keeps the fitted model:

```python
if best - current < 1e-4:
    stale += 1
    if stale >= 3:
        print(f"stopping: val_bacc flat for {stale} checks at {current:.4f}", flush=True)
        break
else:
    stale, best = 0, current
```

The printed series is for the decisions the rule could not anticipate: a loss
that oscillates or rises says the learning rate is wrong, a curve still climbing
at the last epoch says the allowance was too small, and a flat one from epoch 2
says it was too large. Those change your *next* trial. Report the reason you
stopped and the scope you stopped at, in `notes.md`.

### Turn on what the estimator already has

These all default to off or absent. Set them deliberately:

`verbose` for per-iteration output, `early_stopping` with `n_iter_no_change` and
`tol` to stop at a plateau, `warm_start` to continue a fit instead of restarting
it. After the fit, `n_iter_` records the work actually done, and a
`ConvergenceWarning` says the allowance ran out before the tolerance was met.

Two caveats that are easy to miss. `early_stopping=True` holds
`validation_fraction` of your training rows out of training, so it is not free.
And it does not apply to `partial_fit` at all: if you drive your own batch loop,
you write your own break.

### Callbacks, if you use them

Eight estimators support `sklearn.callback`: `GridSearchCV`,
`RandomizedSearchCV`, the two halving variants, `LogisticRegression`,
`LogisticRegressionCV`, `Pipeline`, and `StandardScaler`. `on_fit_task_end`
returns a `stop` boolean and receives a `fitted_estimator`, so a callback can end
a fit at a task boundary and keep the result.

Attach them as `AutoPropagatedCallback`, never a plain `FitCallback`. A plain
callback set on a `Pipeline` never reaches the estimator inside it: the same
callback on the same pipeline produced 5 lines plain and 30 auto-propagated, at
identical wall time.

`ScoringMonitor` scores the **training** data, so it cannot see overfitting, and
re-scoring at every step on a text corpus can cost as much as the fit. If you
add per-step scoring, score every k-th step.

### Say which number is which

A loss and a score are different series and move in opposite directions. Label
them: `train_loss=`, `val_bacc=`. A monitored scorer is not the optimiser's
objective. Never feed the sealed split into anything.

### What is normal

Every run spends its first 1.6 to 1.9 seconds importing scikit-learn before your
code runs, and a cold first run took 8.6 s. Silence there is the import, not a
hang.
