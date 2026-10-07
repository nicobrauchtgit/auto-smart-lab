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
| Search space, sampler, and budget | agent |
| Search execution and its explanation | harness |
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
scikit-learn search, and the Optuna `ask()`/`tell()` adapter all propose
parameters to the same harness-owned training path. A search library never owns
folds, fitting processes, metrics, or cancellation.

The implemented Optuna integration and git-based pipeline versioning are described
in [pipeline versioning and hyperparameter search](training-search-and-versioning.md).
Its delivery order starts with versioning, which champion comparison and final
refit also depend on.

## Restart ownership and recovery

The shared training service durably claims its originating run workspace,
reattaches verified live process groups, and performs bounded recovery of
unexpected worker death. It preserves the manifest, seeds, frozen source,
dataset/dependency identity and budget unit. Completed single-trial folds now
include atomic prediction checkpoints; interrupted opaque fits cannot retain
estimator state. Intentional stops and cost pauses require explicit
`experiment_resume`; completed/failed trials and exhausted hard caps do not
resume. See [durable recovery behavior and limitations](training-search-and-versioning.md#durable-interrupted-experiment-recovery)
for ownership checks, cost accounting, refusal conditions and acceptance tests.

### Implemented terminal refit

`refit` is a registered deterministic stage and follows `evaluate` when enabled.
The standalone command uses the same executor and setup path:

```bash
npm run refit-stage -- spam1 --check-setup
npm run refit-stage -- spam1
# Optional assertion of the chosen tag's evidence root:
npm run refit-stage -- spam1 --training-root runs/spam1/solve/training/<run-id>
```

This command performs local training; it does not start an agent or submit anything.
Enabling refit in the configured chain makes the authoritative `champion` tag the
final selection. Evaluation remains advisory; its readiness score neither selects
a different champion nor authorizes submission.

The stage resolves the experiment and exact fixed factory/estimator parameters
from the annotated champion tag. It requires that experiment's eligible completed
single-trial evidence, matching commit/tree and dependency inventory, original
invocation/seed hashes, and development data. Searches require a measured fixed
confirmation; a search winner itself is never eligible. A different trial with a
higher score cannot override the chosen tag. Checkpoint checksums, persisted folds,
OOF predictions, fold measurements and development metrics are verified without
fitting. Earlier measured evidence remains unchanged.

A repository selection lock serializes training starts, recovery, promotion and
freezing. Active task training workers must finish or stop before freezing. One
atomic fsynced record in the solutions repository's git common directory makes the
candidate terminal and freezes source commit/tree, fixed parameters, dependency
and framework fingerprints, full/development/test data hashes and row identities,
seed lineage and supporting evidence hashes. Only afterward does the supervised
worker load full labels for fitting. Its detached worktree uses the same pipeline
factory, set_params and harness randomness injection as development training.
Every original labelled row, including the sealed complement, enters one fit in a
completed attempt. Test data has no supplied labels. No CV, new promotion evidence,
sealed score or post-refit model review is generated.

Outputs live in `runs/<task>/refit/<candidate-identity>/`: `freeze.json`,
`predictions.csv` (`id,prediction`, exact full archive IDs, binary predictions),
`model.pkl` when the estimator can be serialized, and typed `result.json`. A
serialization failure is recorded by type and does not invalidate predictions or
start another fit. Predictions and model are atomically replaced;
completion is written last. The executor accepts success only after checking
completion identity, freeze hash, source/parameters/environment/seeds/evidence,
all-row fit count, artifact hashes, prediction domain and exact unique test
coverage. Corrupt completed outputs fail closed, without silently fitting again.

Later development starts and recovery refuse the same task/source/fixed-parameter
identity. Terminal champions cannot be rerun as development comparison evidence;
a changed candidate must obtain its own validation. Historical measurements stay
available. This is a harness boundary, not filesystem isolation of arbitrary
Python code or runtime agents.

The existing owned runner, launch gate, process birth identities, kernel locks and
process-group cancellation are reused. A service restart reattaches a verified
live worker, including a durable birth receipt; surviving descendants without a
verified leader block retry. A dead or cancelled opaque fit may be retried under
the same immutable freeze, seed and data, with at most three launches. An incomplete
fit has no estimator checkpoint and is repeated from scratch. No retry changes
selection or counts an incomplete fit as completion. Worker logs and action events
carry pipeline/invocation IDs; the freeze retains its original identities and
reattachment events retain the worker's origin.

Whole-chain setup checks full original labels/test coverage, archive CRCs,
neutral/disjoint test IDs, matching original/development row contents, Python imports, git, worker files and process identities
before an earlier agent starts. If solve will produce the candidate, candidate
integrity is deferred to the refit invocation while data/runtime checks still run
up front. Standalone setup also validates the existing chosen candidate. Refit
requires no provider credentials. Cloudpickle is declared through the shared
Python environment manager; no separate environment is used.

Current adapters support the existing binary text corpora and neutral `.x` test
IDs. The fitted pickle is a trusted local artifact and may require the retained
frozen source worktree plus the recorded Python dependencies when loaded elsewhere.
There is no terminal estimator checkpoint inside an opaque fit, distributed
execution, submission implementation or remote/provider run in this feature.
