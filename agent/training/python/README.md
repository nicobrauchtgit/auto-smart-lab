# Training worker structure

`worker.py` remains the CLI launched by `service.ts`. It coordinates one
harness-owned cross-validation trial through the internal `smartlab_trial`
package:

| Module | Responsibility |
| --- | --- |
| `seeds.py` | Versioned seed derivation, checked against `../seed-vectors.json` by Python and TypeScript tests. |
| `invocation.py` | Validation and parsing into frozen `Invocation`, `PipelineSpec`, `CvSpec`, and `Scope` dataclasses. Owns defaults, including repeats and the legacy trial seed fallback. |
| `agent_code.py` | Project path checks, imports, factory calling conventions, and estimator random states. |
| `folds.py` | Pilot selection, concrete split materialization, coverage validation, and manifest hashing. |
| `artifacts.py` | Events, durable fold results, atomic JSON/OOF writes, and summary artifacts. |
| `metrics.py` | Prediction scores and authoritative measurements. |
| `diagnostics.py` | Per-batch classification/clustering/anomaly signals and common-ID repeat stability; no fitting. |
| `measurement.py` | Controller measurement declaration, opaque sample metadata, identity/target checks and primary metric selection. |
| `geometry.py` | Bounded fitted-feature geometry, density validity and prediction-strength pair counts. |
| `extra_measurements.py` | Opt-in diagnostics and explicitly observed additional fits. |
| `options.py` | Worker-boundary validation of requested diagnostics and proxy objectives. |
| `validation.py` | Bounded no-fit construction and parameter constraint validation. |
| `search.py` | Optuna ask/tell, pruning, journal/checkpoint continuation, runtime guard and report. |
| `champion.py` | Frozen champion rerun in a separate interpreter on the challenger manifest. |

`worker.py` keeps `execute`, `_prepare_data`, `_run_fold`, `_summarise`, signal
handling, failure handling, and the CLI. Its stop flag stays local to the worker;
interruption still takes effect at fold boundaries. Compatibility imports retain
`worker._derive_seed` and `worker._materialize_folds` for existing tests.

The package name prevents collisions with agent helpers such as `metrics.py`
and `folds.py` when the project root is exposed for solution imports. These path
checks and import conventions are not a sandbox for agent code.

## Action logging

The existing `events.jsonl` and stdout event stream retain trial and fold events.
Additional `action_started`, `action_completed`, and `action_failed` records
identify worker phases through `stage`: `data`, `folds`, `agent_code`, `fit`,
`metrics`, and `artifacts`. Repeated fold actions carry `repeat` and `fold`;
terminal action events include duration, and failures include the exception type
and message. Invocation validation and seed resolution have completion records
once validated output paths are available. Invalid invocations continue through
the CLI's existing `trial_failed` path.

All events carry `experimentId`, and include `pipelineRunId` and
`stageInvocationId` when supplied by the supervisor environment. These are nested
worker actions; pipeline stage lifecycle remains owned by the shared executor.

Both `metrics.json` and `trial-result.json` remain required summary artifacts and
contain identical bytes. Version 1 manifest hashes, seed derivation and prediction formats are retained.
Search trials are always ineligible; fixed-parameter confirmation can provide
promotion evidence. Versioned trials also retain source identity.

See [the first measurement packet](../../../docs/harness-measurements.md) for
generic sample manifests, inductive/batch execution, score provenance, bounded
stability comparisons, and advisory versus promotion evidence. `check_measurement.py`
is the shared no-fit import/metadata preflight; `ready()` runs it before agent
pipeline imports. Label-free trials cannot promote. Existing stage task adapters
remain binary text adapters until H1/H2 connect generic controller declarations.

## Verification

Run through the project toolchain:

```sh
./dev python -m unittest discover -s agent/training/python
./dev bun test agent/training
```

Tests pin the pre-refactor manifest hashes for built-in promotion, pilot, and
custom CV fixtures, and cover stop behavior, typed defaults, shared seeds, action
success/failure, and agent helper imports through the unchanged CLI entry point.

See [delivery and limitations](../../../docs/training-search-and-versioning.md)
for versioning, recovery, runtime cap boundaries and acceptance coverage.

`runner.py` owns the durable worker lock, process birth receipt, launch gate,
exit receipt and cumulative runtime measurements. The supervisor supplies an
append-only log descriptor; service loss does not close the worker's log.
`smartlab_trial/recovery.py` validates checksummed checkpoints and loads the
original concrete fold manifest. Single folds checkpoint their authoritative
predictions atomically; search recovery retains completed configurations and
consumes interrupted configurations as failed slots. See
`docs/training-search-and-versioning.md` for the service lifecycle policy.
