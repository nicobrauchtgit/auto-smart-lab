# Observable trial fits and experiment control

Status: proposed implementation, revised 2026-09-09 after measuring the real
corpus. The user prioritised shorter trial fits and the agent's ability to
observe and interrupt a fit while it runs. Build this control path before
removing session deadlines and iteration caps. The existing limits stay in
place during this work.

The user's main concern is wasted training after early convergence. The default
agent workflow must begin with a small pilot fit. Do not begin with a huge
iteration allowance and rely on later intervention to rescue it.

See [pipeline-signals.md](pipeline-signals.md) for statistical diagnostics and
[WIP.md](WIP.md) for the current roadmap. The tools below are not implemented.

An earlier draft of this document proposed a custom progress event API, a typed
event ledger, and durable supervisor recovery. Measurement replaced most of it.
scikit-learn 1.9 already provides the callback hooks, and the agent's own
`print` covers the rest. What remains is smaller and is listed under
[what the supervisor owns](#what-the-supervisor-owns).

## Measurements

Measured on two tasks from unit 1, on this machine. `spam1` has 16,662
documents averaging 1.4 KB. `spam2` has 18,756 documents averaging 8.0 KB, so
5.5x the text, and is imbalanced at 69.7% positive.

The findings about *what emits a signal at all* generalise. Those are properties
of scikit-learn, not of a corpus. Every duration here does not.

| | spam1 | spam2 | ratio |
| --- | --- | --- | --- |
| Longest legitimate silence (5-fold CV, no telemetry) | 6.2 s | 35.7 s | 5.8x |
| Grid search, 6 candidates, `n_jobs=1` | 51.6 s | 226.9 s | 4.4x |
| Grid search, same, `n_jobs=4` | 23.6 s | 89.6 s | 3.8x |
| Peak resident memory, `n_jobs=4` | 2450 MB | 5782 MB | 2.4x |
| Silent import prelude | 1.6 s | 1.9 s | 1.2x |
| Lines from `SGDClassifier(verbose=1)` | 152 | 152 | 1.0x |

Three consequences for the design.

**Silence scales with data volume, so no constant works.** The longest silence
grew 5.8x against 5.5x more text, near-proportional. A stuck-detection threshold
tuned on `spam1` would fire constantly on `spam2`, and one tuned on `spam2` would
sleep through a real hang on `spam1`. This is still unit 1. The useful part is
that the relationship is roughly linear, so a pilot on a fraction of the data
predicts the full run's gap. Derive the interval from the pilot.

**The silent prelude is a constant, not a fraction.** It is scikit-learn's import
time, around 1.6 to 1.9 s on both tasks, and it does not grow with the corpus. A
fixed carve-out covers it. Data loading and vectorising happen after it and are
part of the first working gap.

**Output volume is bounded by estimator configuration, not corpus size.**
`SGDClassifier(verbose=1)` emitted exactly 152 lines on both. The rate fell from
52 to 15 lines per second, so the smaller task is the harder case for the
coalescer and a limit set there holds for larger ones.

Memory deserves its own watch. The same grid search reached 5.8 GB across four
workers on `spam2`. On a larger unit that is the constraint that ends the run,
and it is invisible on the output channel.

## Observability is a property of how the agent structures the fit

This is the central finding, and it moves most of the work out of
infrastructure and into the prompt.

`MultinomialNB` inside a `Pipeline` emits nothing during `fit`. Not because
anything withholds it, but because there is no intermediate state: the fit is
one counting pass over a sparse matrix. Driving the same estimator over batches
with `partial_fit` produces a learning curve:

```text
seen=1000/13329   val_bacc=0.9784
seen=3000         val_bacc=0.9850
seen=6000         val_bacc=0.9868
seen=8000         val_bacc=0.9880
seen=10000        val_bacc=0.9880
seen=13329        val_bacc=0.9892
```

No loss exists, because naive Bayes counts rather than optimises. A learning
curve still exists, and it says that data beyond roughly 8,000 rows buys about
0.001. That is the evidence the pilot policy asks for, from the estimator that
looked opaque.

The same code on `spam2` says the opposite, which is the point:

```text
spam1   seen=6000 -> 0.9868   seen=10000 -> 0.9880   seen=13329 -> 0.9892
spam2   seen=6000 -> 0.9591   seen=10000 -> 0.9696   seen=15004 -> 0.9830
```

`spam1` is flat from about 8,000 rows. `spam2` is still climbing at 15,004. On
one task "stop adding data" is correct and on the other it costs real accuracy,
and only measurement separates them. No standing rule about pilot size can.

The same restructuring on `SGDClassifier` gives a real loss alongside the
validation score, and shows the failure this whole capability exists for:

```text
epoch 1/8   train_loss=0.1003   val_bacc=0.9838
epoch 2/8   train_loss=0.1020   val_bacc=0.9841
epoch 4/8   train_loss=0.1029   val_bacc=0.9841
epoch 8/8   train_loss=0.1033   val_bacc=0.9838
```

Best at epoch 1. Seven of eight epochs wasted, and visible by epoch 2. On
`spam2` the same loop peaks at epoch 2 and wastes six of eight. Unlike the data
question above, this answer is consistent across both tasks.

Classify estimators by learning procedure rather than by name:

| Regime | Signal during the fit | Coverage among classifiers |
| --- | --- | --- |
| Iterative optimisation | A true loss per step | `SGDClassifier`, `MLPClassifier`, `LogisticRegression` with lbfgs |
| Incremental or streaming | A learning curve over rows seen. A score, not a loss | 12 classifiers expose `partial_fit`, including the whole naive Bayes family |
| Single-shot analytic | Nothing exists to report | 25 classifiers have neither `partial_fit` nor `warm_start`: `LinearSVC`, `SVC`, `LDA`, `QDA`, `KNeighborsClassifier`, single trees |

Regimes one and two cover most of what a spam solver reaches for, and the move
between opaque and observable is the agent writing a loop over `partial_fit`
instead of a single `fit` call. That belongs in runtime guidance. A plain
`print` of a labelled score line is more flexible than any callback here,
because the agent already owns the loop.

Regime three is genuinely dark. Do not synthesise progress for it, and do not
push the agent off an estimator to gain telemetry. Watch the process instead.

## What scikit-learn 1.9 already provides

Prefer the native mechanism wherever one exists. Three of them do.

**Estimator verbosity and early stopping.** `verbose`, `early_stopping`,
`n_iter_no_change`, `tol`, and `warm_start` are per-estimator parameters that
already exist. `n_iter_` after the fit records work actually completed, which is
the only honest answer to "did it run all 500 iterations". Non-convergence
already raises `ConvergenceWarning`, and that warning reaches the output stream
while the fit is still running.

**The callback framework.** `sklearn.callback` ships in 1.9 with task begin and
end hooks, nested task context, and `ScoringMonitor`. Two properties matter
beyond telemetry: `on_fit_task_end` returns a `stop` boolean, which ends a fit
at a task boundary without waiting for a model turn, and it receives
`fitted_estimator`, an instance ready to predict as if the fit had stopped
there. Those are the local convergence rule and the checkpoint, already
implemented and tested upstream. `_transport.py` ships callback messages from
joblib workers back to the main process over a local socket, so `n_jobs > 1`
already works.

Three limits, all verified against the installed package:

- Eight estimators support callbacks: `GridSearchCV`, `RandomizedSearchCV`,
  `HalvingGridSearchCV`, `HalvingRandomSearchCV`, `LogisticRegression`,
  `LogisticRegressionCV`, `Pipeline`, `StandardScaler`. The halving variants
  sit behind `enable_halving_search_cv`. The API is experimental.
- `LogisticRegression` opens a per-iteration subcontext only for the lbfgs
  solver. `saga`, `liblinear`, and `newton-cg` give task-level events and
  nothing per iteration.
- `ScoringMonitor` calls its scorer on the **training** data. A clean falling
  curve from it is compatible with validation having peaked much earlier, so it
  cannot detect the overfitting that most justifies stopping a fit.

`set_callbacks` on a meta-estimator does not reach sub-estimators on its own.
The same callback on the same `Pipeline` produced 5 lines as a plain
`FitCallback` and 30 as an `AutoPropagatedCallback`, at identical wall time.
Auto-propagation is not an optimisation, it is what makes callbacks useful.

**Pipeline verbosity is a receipt, not progress.** `Pipeline(verbose=True)`
prints each step after that step finishes. On the full corpus every line landed
in the final 0.01 s of a 10.2 s process, and the classifier is the last step, so
its line arrives once the fit is already over.

Every run also spends its first 1.6 to 1.9 s importing scikit-learn before any
user code runs, and a cold first run of the day spent 8.6 s. A silent prelude of
that length is normal, and a heartbeat that does not know about it will report a
healthy trial as stuck before it has begun.

## Start small and expand only on evidence

Runtime guidance should require the agent to start with a modest trial suited
to its estimator. A few epochs or optimisation steps can be enough for an
iterative learner. An opaque batch estimator may need a development subset and
one fold instead. The agent chooses the actual values. A single numeric limit
would mean different amounts of work for different models.

A shorter trial is deliberately less work, such as a stratified development
subset, one validation fold, or fewer training epochs. It is not a universal
wall-clock timeout. Keep the validation subset and seed fixed when comparing
trials at the same scope, record that scope, and keep sealed rows unavailable.

After the pilot, inspect completed steps, runtime, training and validation
metrics, warnings, and convergence status. Record both the configured maximum
and the work actually completed.

Continue only with evidence that more work helps. If the fit is still improving
at the end of its allowance, extend in small steps where the estimator supports
continuation. If it has converged, finish that fit. If validation degrades while
training improves, keep the best checkpoint and let the agent decide what to
change. Confirm promising pilot results with fuller validation.

Stopping in place is not the same as restarting with a lower allowance. A
callback stop at a plateau already *is* the smaller budget, and the fitted
result is kept. Re-running the identical configuration with a reduced `max_iter`
buys nothing. Restart when other parameters change too, or when a clean
reproducible run at the learned budget is worth its cost.

Use two levels of intervention:

- A callback or training loop checks the trial's declared convergence rule at
  each supported step. It stops immediately and records the reason, without
  paying for or waiting on a model turn. The agent chooses the metric,
  tolerance, observation window, and patience.
- The agent sees compact updates and decides whether to continue, stop earlier,
  change the next trial, or invest in full validation. Process stop stays
  available even when the estimator has no callbacks.

This expresses an experiment policy, not a required model implementation. The
harness records requested work, actual work, and the measured outcome. It does
not force an estimator, prescribe a global iteration cap, or treat three flat
observations as universal proof of convergence. Smaller samples can change
rankings and hide slow improvements, so the scope and the reason for stopping
must accompany each pilot result.

## What the supervisor owns

The agent cannot own the fitting process. In the Pi session model a tool call
*is* ownership: the process lives and dies inside it, and the agent reaches no
model-call boundary until the call returns. Streaming output into a blocking
tool call wakes nothing. The agent therefore holds an experiment ID while the
supervisor holds the process, and the fit's lifetime stops being bounded by a
tool call, a turn, or context compaction.

Four responsibilities follow, and they are the whole of the infrastructure:

1. **Start without blocking.** `experiment_start` accepts argv, workspace,
   hypothesis, and trial scope, spawns the process detached in its own process
   group, and returns an ID immediately.
2. **Carry the output out.** Drain stdout and stderr line by line into
   `runs/<task>/experiments/<id>/`. The log file is the record. Set
   `PYTHONUNBUFFERED=1`: a child's stdout is block-buffered when it is not a
   tty, so without it `verbose` output arrives in 8 KB chunks or at exit, which
   reproduces the exact problem being fixed.
3. **Stop the group.** `experiment_stop` records the agent's reason and cited
   observations, then signals the process group. `n_jobs=-1` means joblib worker
   processes, and killing only the parent orphans them to keep burning CPU into
   the next iteration. Use `kill(-pgid)`, not `kill(pid)`. Repeating stop is
   idempotent.
4. **Watch the process.** See below. This is the only signal available for
   regime-three fits.

Persist the accepted specification before spawning: argv, working directory,
input and code fingerprints, pipeline and invocation IDs, requesting agent and
tool-call IDs, and the process group ID. Take the dependency identity from
`readPythonEnvironment()`, which already returns a `fingerprint`; do not build a
second inventory. Use the existing Devbox Python. Pass an environment snapshot
and never mutate `process.env`.

Mirror lifecycle and decision events through `StageReporter.event`, which
already attaches `pipelineRunId`, `stageInvocationId`, and `attempt` and writes
to both `agent_events` and the local JSONL mirror. Do not build a parallel sink.

A detached process can outlive the whole run, so the recorded process group ID
is what lets a later run clean up strays. Durable recovery across a supervisor
crash is deferred: if the Bun process dies the pipeline run is over anyway.
Record lost supervision rather than claiming recovery from a stale PID.

`agent/solve/results.ts` keeps its current buffer-and-wait `run()` helper. That
call measures a finished iteration and is not a trial fit.

## Watching the process

`ps -o time,rss,vsz` fails on Darwin 25 with `requires entitlement`, so the
supervisor cannot read CPU or memory that way. `proc_pidinfo` with
`PROC_PIDTASKINFO` through libproc works for own-user processes and costs 0.9 us
per call. Enumerating group membership with `ps -o pid= -g` costs 3.6 ms because
it forks, so refresh membership rarely and sample libproc often.

`pti_total_user` and `pti_total_system` are mach ticks, not nanoseconds. The
timebase on Apple Silicon is 125/3, or 41.67 ns per tick. Reading the fields as
nanoseconds reports 2.4% for a fully pegged core, a 41x underread that makes
every healthy fit look deadlocked. Convert with `mach_timebase_info`.

The measured separation is clean. A deliberately deadlocked trial sat at 0% CPU
through 89.5 s of silence. Every genuinely working configuration sat between
56% and 105%, and at 310% under `n_jobs=4`.

CPU proves liveness, not usefulness. A trial doing arithmetic that will be
discarded reads 105% and is indistinguishable from productive work. Process
telemetry rules out hangs. Only the loss or validation series rules out waste.
Both layers are needed and neither substitutes for the other.

Memory is decision-relevant on its own. The same grid search peaked at 777 MB on
one process and 2450 MB across seven at `n_jobs=4`, buying 2.2x speed for 3x
memory. Report it and let the agent choose.

## Waking the agent

`AgentSession.steer()` delivers after the current assistant turn finishes its
tool calls and before the next model call. `sendCustomMessage` with
`triggerTurn` starts a turn when the agent is idle. The drain must pick the
right one for the agent's current state and must not deliver through both.

Sampling and waking are separate. Sampling every 250 ms costs nothing and never
spends a turn. A wake is a model call, billed in tokens, so trigger it from a
rule over the samples rather than from a timer:

- CPU below roughly 5% for longer than a multiple of the pilot's observed gap.
  Wake with CPU, RSS, and elapsed time attached, so the agent can tell a hang
  from slow work.
- Process exit, a non-finite metric, or output matching an error or warning
  pattern. These jump the queue ahead of routine progress.
- Resident memory trending toward the machine's limit.
- Healthy CPU with output still flowing produces no wake at all.

A timer is only a backstop, and its interval comes from the pilot's observed
inter-event gap rather than a constant. The longest legitimate silence was 6.2 s
on `spam1` and 35.7 s on `spam2`, so no single value serves both, and both are
unit 1. Scale the threshold from the pilot's measured gap, and exclude the
roughly 2 s import prelude, which is silent by nature.

Coalesce routine progress. `SGDClassifier(verbose=1)` produced 152 lines in
2.9 s, about 52 per second, and one wake per line is unaffordable in both
context and money. Hold current and best values, emit at most one update per
interval, and send the delta with the last few lines rather than the whole tail.
Keep the full sequence in the log and preserve cursors so observation resumes
without replaying history into the model context.

Because the callback `stop` rule already ends a converged fit locally at zero
model turns, waking the agent should be the exception. Diverging, far slower
than projected, warning raised, exited. Not a loop the agent sits in.

## Where guidance, evidence, and enforcement belong

| Responsibility | Mechanism | Examples |
| --- | --- | --- |
| Stable experiment policy | Short, explicitly selected prompts in `agent/prompts/` | Start with a small pilot; fit over folds or batches so progress exists; expand only on measured evidence; distinguish pilot from full validation |
| Estimator-specific help | On-demand authored recipes from the run's prompt snapshot | How to drive `partial_fit` over batches, attach an auto-propagated callback, set `early_stopping`, or read a convergence warning |
| Current run facts | Typed inputs, tool results, and recorded custom messages | Trial scope, actual steps, metric history, current and best checkpoint, CPU and memory, warnings, previous failures |
| Repeated arithmetic and IO | Tested Python helpers exposed through thin tools | Dataset loading, result writing, ROC and PR, threshold diagnostics, calibration, paired comparison |
| Process control and validity | Deterministic supervisor and tool validation | Start and stop ownership, prediction alignment, finite scores, complete final results, sealed feedback exclusion |

Keep model and feature choices with the agent. Pilot size, estimator, tolerance,
and the next hypothesis are agent decisions. A large requested allowance can
trigger a factual hint about missing pilot evidence. It does not prove the
estimator will execute every allowed step. Do not silently rewrite model
parameters or regex-match bash commands to enforce a training policy.

All authored hints belong in the prompt registry with typed variables. Load
templates once per run, select one when an event warrants it, and record its
prompt identity and rendered hash. Measurements stay data. Never turn process
output into system instructions.

Distinguish a loss from a score in anything the agent reads. A monitored scorer
is not the optimiser's objective, and `ScoringMonitor` scores training data.
Record whether a number came from an agent-authored line, a native callback, a
parsed verbose format, or the deterministic measurement code. Never send sealed
feedback into a continuing fit.

Do not read `loss_curve_` or other fitted attributes from another thread while
`fit` is still mutating the estimator. Read the emitted stream instead.

Telemetry is not free. `ScoringMonitor` re-scores the training set at every
iterative step, which on a text corpus can rival the fit itself. Any per-step
scoring the agent adds needs a frequency control, such as scoring every k-th
task.

Cross-validation and search run nested fits concurrently under joblib, so
preserve task lineage. Without it, curves from different folds and candidates
blend into one meaningless series.

Pi's `tool_call` hook can reject a call, but the tool must validate its own
inputs so other callers behave the same. Hard failures should name invalid
requests or unusable evidence: a missing artifact, mismatched prediction IDs,
unsupported controls, non-finite scores. Pilot quality is evidence for agent
judgement, not a gate. Final artifact validation stays a controller gate.

## Reuse the diagnostic library

`libs/smartlab-eval/smartlab_eval/metrics.py` already implements ROC and AUC,
precision-recall and average precision, threshold sweeps, calibration bins,
confusion counts, per-class recall, paired comparisons, and paired bootstrap
intervals. `Results` and the corpus loaders already handle data and result
plumbing. Keep one numerical implementation behind both Python calls and agent
tools.

Diagnostic tools should accept artifact references rather than large arrays
pasted into model messages. Resolve and validate labels, IDs, fold and split
identity, score kind, positive class, and input hashes before computing. Return
a compact JSON summary plus paths to detailed data and optional plots. Cache by
input hashes, diagnostic version, and options. Never retrain a model to produce
a ROC plot.

ROC and PR need continuous scores. Calibration expects probabilities, and a
decision margin is not a probability. Default thresholds depend on score kind.
The current helpers are mainly binary diagnostics, so wrappers must report
unsupported tasks rather than silently applying them. See the official
[metric](https://scikit-learn.org/stable/modules/model_evaluation.html#roc-metrics)
and [calibration](https://scikit-learn.org/stable/modules/calibration.html)
guides.

Threshold search is diagnostic selection on the supplied predictions. Its best
score is not a fresh unbiased evaluation of the selected threshold. Keep tuning
and evaluation separated, as described in the
[threshold-tuning guide](https://scikit-learn.org/stable/modules/classification_threshold.html).

The current solve evaluator computes ROC AUC and threshold diagnostics when
scores exist. Its rendered iteration message includes ROC AUC but omits the
threshold summary. Calibration and PR are callable library functions, not agent
tools or automatic solve feedback yet. Exposing these results is separate from
rebuilding their mathematics.

## First implementation and acceptance tests

Build the supervisor, the process sampler, and the start, status, output, and
stop tools as an optional module, with runtime guidance under `agent/prompts/`.
Exercise them through an executor-backed fixture before wiring them into solve.
Use a small deterministic training fixture with selectable improving, flat,
diverging, silent, and failing behaviour.

`experiment_watch` is optional. Push through `steer` covers the same need
without a polling tool. Add it only if push delivery proves insufficient.

The first integration test must establish all of the following:

- Start returns before the fit finishes, and progress reaches the agent during
  the fit. Receiving output only at process exit fails the test.
- A blocking fit inside a tool call does not deliver progress. Assert the
  negative case so the non-blocking start cannot silently regress.
- The scripted agent continues an improving trial, observes a later regression,
  requests stop, and starts a revised trial in the same session.
- Stop reaches the process group, leaves no owned workers running, and retains
  logs and any checkpoint actually written. Assert against a fixture that
  spawns joblib workers.
- A model turn or compaction does not terminate the fit. Cursors let observation
  resume without replaying every metric into the model context.
- A silent fixture pegged at full CPU is not reported as stuck, and a fixture
  that is alive at 0% CPU is. Cover the mach-tick conversion directly: a pegged
  core must read near 100% and not 2.4%.
- The import prelude does not trigger a stuck report.
- The stuck threshold is derived from the pilot rather than fixed. Run the same
  fixture at two data scales whose longest legitimate silence differs by roughly
  5x, matching the measured `spam1` and `spam2` gap, and assert neither reports
  a false stall.
- Invalid lines, partial lines, and noisy high-rate output cannot stop ingestion
  or create false completion. Include a 52-lines-per-second fixture and assert
  the coalescer bounds the wake rate.
- Trial scope stays explicit and trial results cannot promote a champion.
- A fixture that converges after three updates stops locally, without running
  out a large configured allowance and without waiting for a model turn.
- A fixture still improving at the pilot boundary can receive more work. The
  initial allowance does not become a global training limit.
- Selected runtime prompts stay present and development-context markers stay out
  of assembled system prompts.

After these tests pass, connect the tools to the registered solve session and
replace the fixed session lifetime. Change convergence separately, using the
agent's recorded hypotheses and observed results. Automatic 100k-token handovers
and session replacement remain deferred.
