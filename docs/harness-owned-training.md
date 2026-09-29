# Harness-owned training framework

Status: implementation contract, 2026-09-24.

The solve agent designs experiments; the harness executes them. This is the
same division a UI framework makes between an application's design and its
runtime: the framework supplies lifecycle and trustworthy primitives without
deciding what the application should be.

## Ownership

| Concern | Owner |
| --- | --- |
| Features, estimator, pipeline, hyperparameters | agent |
| CV scheme, fold count, repeats, and grouping logic | agent |
| Root, sealed, experiment, trial, fold, estimator, and bootstrap seeds | harness |
| Materialised fold assignments and their durable manifest | harness |
| Training processes, descendants, cancellation, and resource accounting | harness |
| Out-of-fold predictions and measured metrics | harness |
| Sealed split, its labels, and disclosure policy | harness |
| Search strategy, including whether to use Optuna | agent |
| Promotion eligibility and artifact integrity | harness |

The agent may supply a standard splitter or arbitrary project code that creates
one. The harness calls it with harness-owned entropy, validates the resulting
indices, and persists the row-level assignment before fitting. The persisted
manifest, not a second call to the splitter, is the source of truth for replay
and comparison.

The agent may fit code directly while investigating, but those results are not
promotion evidence. A promotable result must come from the harness training
worker, which is the only component allowed to write authoritative OOF
predictions and trial measurements.

## Evidence ladder

Development normally advances through:

```text
construction smoke -> pilot -> expanded validation -> promotion -> final refit
```

A pilot deliberately reduces work: fewer rows, folds, candidates, epochs, or a
combination chosen for the estimator. It validates an assumption and estimates
cost; it cannot promote a model. Starting small is the ergonomic default, not a
restriction on model design. An agent may request a larger first run, but the
request records why it skipped pilot evidence.

The harness returns compact, decision-oriented signals while retaining full
logs. Signals include requested and completed scope, fold and class metrics,
challenger/champion deltas, uncertainty, corrected and introduced errors,
warnings, configured versus completed estimator work, resource use, elapsed and
projected cost, leakage checks, artifact hashes, and the evidence still missing
for promotion.

## Trial lifecycle

An agent submits a typed request naming its pipeline factory, parameters, CV
definition, hypothesis, and pilot or promotion scope. It never supplies a
seed. The harness:

1. records the request and derives a versioned seed plan;
2. materialises and validates a fold manifest;
3. starts the fixed training worker in an owned process group;
4. records structured progress and completed-fold artifacts;
5. accepts observation and stop requests throughout the run;
6. writes the authoritative result and OOF predictions; and
7. marks the trial promotable only when its declared promotion scope completed.

A graceful stop takes effect at a supported estimator callback or the next fold
boundary. A forced process-group stop remains available at any time, but an
opaque in-progress fit may leave no usable checkpoint. Completed folds and
diagnostics remain available after either kind of interruption.

Changing CV configuration creates a new comparison cohort. To compare a
challenger with an existing champion, the harness reruns the frozen champion on
the challenger's exact persisted manifest. It never reconstructs supposedly
equivalent folds from a seed and a different splitter implementation.

## Final refit

Once selection is final, the harness freezes the champion's source, parameters,
dependency fingerprint, seed lineage, and supporting evidence. It then refits
that exact pipeline on all labelled training rows, including the sealed rows,
and produces final test predictions.

This is terminal for that candidate identity. The sealed rows cease to be
independent evidence once used for training, so no post-refit sealed score is
reported and no further development result may be attached to the frozen
candidate. Any code or parameter change creates a new candidate that must be
validated again.

## Search adapters

The primitive is a trial, not Optuna. Manual candidates, custom search logic,
scikit-learn search, and a future Optuna `ask()`/`tell()` adapter all propose
parameters to the same harness-owned training path. A search library never owns
folds, fitting processes, metrics, or cancellation.

Optuna is deliberately deferred until the single-candidate worker, observation,
stopping, promotion comparison, and final refit pass their deterministic and
live checks.
