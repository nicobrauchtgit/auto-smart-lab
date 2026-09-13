# Build prompt: observed trial fits

Hand this to a fresh session. It builds the experiment supervisor and its live
test. Written 2026-09-09 against branch `solve-stage-hardening`.

## The task

The solve agent writes a scikit-learn pipeline and fits it. Right now it learns
nothing until the process exits, so a fit that converged at iteration 3 of a
configured 500 burns the rest anyway. Build the path that lets the agent watch a
fit while it runs and stop it, and add the runtime guidance that makes fits
observable in the first place.

Two deliverables, and they are very different sizes. Do them in this order,
because the first is most of the value and needs no infrastructure.

## Read first

- [experiment-supervision.md](experiment-supervision.md) is the design. Read all
  of it. The `Measurements` section is why the numbers are what they are, and
  `What the supervisor owns` is the scope boundary.
- [pipeline-integration.md](pipeline-integration.md) is the contract every stage
  and module obeys. Identity, typed inputs, artifact validation.
- [AGENTS.md](../AGENTS.md) for repository rules, especially the Python
  environment and the rule that development guidance stays out of pipeline
  context.
- [agent/prompts/README.md](../agent/prompts/README.md) before writing any
  runtime guidance. Prompts are authored files with stable IDs, not strings in
  TypeScript.
- [research/sklearn-observability/](research/sklearn-observability/) holds the
  measurement harness. `procinfo.py` is close to the sampler you need, and
  `fit_case.py` already has the fixtures the acceptance tests describe.

`agent/subagents/` is the shape to copy: an optional module with `index.ts`,
`types.ts`, `tools.ts`, a manager, a `README.md`, unit tests, and `live_smoke.ts`
for the paid live check. Build `agent/experiments/` the same way.

## Deliverable 1: make fits observable

This is prompt work plus a small measurement addition. No new infrastructure.

Runtime guidance under `agent/prompts/`, with stable IDs in `registry.ts`:

- Start with a small pilot sized to the estimator, not a fixed number.
- Structure the fit so progress exists. Loop over folds or `partial_fit`
  batches and print a labelled score line per step rather than handing
  `cross_validate` one opaque call. Twelve classifiers expose `partial_fit`,
  including the whole naive Bayes family.
- Turn on what the estimator already has: `verbose`, `early_stopping`,
  `n_iter_no_change`, `tol`, `warm_start`. All default to off or absent.
- Label a loss as a loss and a score as a score. They are not the same series.
- Attach callbacks as `AutoPropagatedCallback`, never plain `FitCallback`. A
  plain one set on a `Pipeline` never reaches the estimator inside it.

Two caveats the guidance must state explicitly or they will be missed.
`early_stopping=True` holds out `validation_fraction` from training, so it is
not free. And it does not apply to `partial_fit`, so an agent driving its own
batch loop has to write its own break.

In `agent/solve/iteration.py`, record configured work against actual work:
`n_iter_` against the configured `max_iter`, whether `early_stopping` was set,
and any `ConvergenceWarning` raised. A large `max_iter` in the source proves
nothing about what ran. This needs no new channel; read fitted attributes after
the fit.

Do not read `loss_curve_` or other fitted state from another thread while `fit`
is still mutating the estimator.

## Deliverable 2: the supervisor

Roughly 150 lines. It exists because a fit inside a tool call blocks the agent
until the call returns, so `steer` cannot reach it. Observation is what it
delivers; not blocking is why it must exist.

1. `experiment_start` spawns detached in its own process group and returns an ID
   immediately. Set `PYTHONUNBUFFERED=1`. Persist argv, cwd, fingerprints,
   pipeline and invocation IDs, and the process group ID before spawning. Take
   dependency identity from `readPythonEnvironment()`, which already returns a
   `fingerprint`.
2. Drain stdout and stderr line by line to `runs/<task>/experiments/<id>/`. The
   log file is the record. Do not build an event ledger or a typed event union.
3. `experiment_stop` signals the process group. `kill(-pgid)`, never
   `kill(pid)`. Idempotent.
4. Sample the process group through libproc. Start from `procinfo.py`.
5. Coalesce and push through `session.steer()` while the agent is running, or
   `sendCustomMessage({triggerTurn: true})` when it is idle. Pick one, never
   both.

Mirror lifecycle and decision events through `StageReporter.event`, which already
attaches the shared identity. Do not build a parallel sink. Leave
`agent/solve/results.ts` alone: its buffer-and-wait `run()` measures a finished
iteration and is not a trial fit.

`experiment_watch` is optional. Add it only if push proves insufficient.
Durable recovery across a supervisor crash is deferred. Record lost supervision
rather than claiming recovery from a stale PID.

## Traps that will cost you a session

Each of these was measured. Do not rediscover them.

- `ps -o time,rss,vsz` fails on Darwin 25 with `requires entitlement`. Use
  `proc_pidinfo` with `PROC_PIDTASKINFO`.
- Its CPU fields are mach ticks, not nanoseconds. Apple Silicon's timebase is
  125/3. Read them as nanoseconds and a pegged core reports 2.4%, so every
  healthy fit looks deadlocked.
- Enumerating group membership with `ps -o pid= -g` costs 3.6 ms because it
  forks. The libproc call costs 0.9 us. Refresh membership rarely.
- Without `PYTHONUNBUFFERED=1` a child's stdout is block-buffered, so `verbose`
  output arrives in 8 KB chunks or at exit. That reproduces the exact problem
  you are fixing.
- `steer()` delivers after the current turn's tool calls finish. It cannot
  interrupt a blocking call.
- `ScoringMonitor` scores training data. It cannot detect overfitting.
- Eight estimators support callbacks. `LogisticRegression` emits per-iteration
  events only with the lbfgs solver.
- The first 1.6 to 1.9 s of every trial is scikit-learn importing. Silent and
  normal. A cold first run took 8.6 s.

## Live test

Unit tests come from the acceptance list in the design document. This is the
live check, modelled on `agent/subagents/live_smoke.ts`. It calls the configured
model provider, so keep it out of CI.

Run against both corpora, because one will not catch a fixed threshold:

```bash
P="$PWD/.venv/bin/python"
devbox run -- bun agent/experiments/live_smoke.ts --task spam1
devbox run -- bun agent/experiments/live_smoke.ts --task spam2
```

The run must establish all of the following, each asserted separately rather
than inferred from a successful exit:

1. Progress reaches the agent while the fit is running. Assert a steered message
   arrives strictly before process exit. Receiving everything at exit is a fail.
2. The negative case: a fit started inside a blocking tool call delivers nothing
   until it returns. This is what stops the non-blocking start regressing.
3. The agent stops a running fit on evidence, and the process group is gone
   afterwards. Assert against a `n_jobs=4` fixture and check for orphaned joblib
   workers by process group, not by PID.
4. Stuck detection separates the two cases. A silent fit pegged near 100% CPU is
   not reported as stuck; a fit alive at 0% CPU is. Cover the tick conversion
   directly: assert a pegged core reads near 100 and not 2.4.
5. The threshold scales. `spam1` and `spam2` differ by 5.8x in longest
   legitimate silence, 6.2 s against 35.7 s. Neither run may report a false
   stall. A constant that passes one will fail the other.
6. The import prelude does not trigger a stall report.
7. The coalescer bounds the wake rate. `SGDClassifier(verbose=1)` emits 152
   lines in 2.9 s on `spam1`, about 52 per second. Assert wakes are far fewer
   than lines.
8. Memory is reported. `gridsearch_parallel` reached 5.8 GB on `spam2`.
9. A fit continues across a model turn and across compaction.
10. Trial results cannot promote a champion, and sealed rows stay unavailable.

Reference numbers to check against, from
[research/sklearn-observability/](research/sklearn-observability/):

| | spam1 | spam2 |
| --- | --- | --- |
| Longest legitimate silence | 6.2 s | 35.7 s |
| Grid search, `n_jobs=1` | 51.6 s | 226.9 s |
| Peak RSS, `n_jobs=4` | 2450 MB | 5782 MB |
| Import prelude | 1.6 s | 1.9 s |

They are machine-specific. Treat a large divergence as a signal to investigate,
not as a test failure.

## Done means

Deliverable 1 is done when a solve run shows the agent fitting in batches or
folds, printing labelled score lines, and the iteration record carries configured
against actual work. That is worth having on its own: the measured waste of six
to seven epochs out of eight is recoverable from configuration alone, with no
supervisor involved.

Deliverable 2 is done when the acceptance list in the design document passes and
the live test above passes on both corpora. Only then remove the fixed session
deadline, and change convergence separately.
