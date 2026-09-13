**Live Training Observability with scikit-learn 1.9**
*Framework design notes for agent-controlled ML runs*
Scope: runtime telemetry, loss/score curves, interruption, restart decisions, and fallbacks
# 1. Executive summary
**Recommendation. **Treat scikit-learn callbacks as the preferred native telemetry source when available, but put them behind a framework-level observation interface. The framework should ingest native callbacks, estimator-specific live output, stdout/stderr, and process lifecycle/resource signals into one normalized event stream.
- scikit-learn 1.9 introduces an experimental callback API with task-level begin/end hooks, nested task context, progress reporting, metric monitoring, and the ability for a callback to request interruption at a task boundary.
- For supported iterative estimators, emit a curve during the run. Prefer a validation metric when available; training loss alone is useful for convergence/plateau detection but is not sufficient to diagnose overfitting.
- Do not impose a fixed wall-clock timeout. Let the agent observe progress and decide whether a run is productive, stalled, converged, numerically unhealthy, or worth stopping.
- If a native callback can stop the current fit, stop in-place instead of killing the process. Restart only when the next experiment needs materially different hyperparameters or the estimator cannot be controlled in-place.
# 2. What scikit-learn 1.9 offers during a run
scikit-learn 1.9 adds an experimental callback framework. Compatible estimators expose set_callbacks(...). During fit, callbacks are invoked at the beginning and end of tasks. Tasks can represent iterations, pipeline steps, cross-validation folds, candidate evaluations, or the overall fit, producing a natural task tree.
| Capability | scikit-learn 1.9 | Use in our framework |
| --- | --- | --- |
| Task begin/end events | Yes, for compatible estimators | Run/stage/iteration lifecycle events |
| Nested task hierarchy | Yes | Represent Pipeline → CV fold → model → iteration |
| Progress | ProgressBar callback | Human-readable progress and task completion |
| Per-iteration score | ScoringMonitor | Curve suitable for convergence analysis |
| Run IDs / timestamps / lineage | Available in ScoringMonitor logs | Correlate observations across nested fits |
| Interrupt fitting | Supported by callback protocol | Adaptive early stop without hard timeout |
| Universal raw training loss | No | Estimator-specific adapter/fallback required |
| CPU / RAM / GPU telemetry | No | Collect from process/system layer |

**Current built-in callback coverage is limited. **In 1.9, callback support is documented for LogisticRegression with the L-BFGS solver, GridSearchCV, RandomizedSearchCV, both halving search variants, Pipeline, and StandardScaler. The API is explicitly experimental.
# 3. Can we get a training-loss curve while the run is active?
**Yes in some cases, but not as one universal sklearn field. **There are three distinct mechanisms, and the framework should distinguish them.
## 3.1 Native callback score curve (best path where supported)
ScoringMonitor computes a scorer at the end of iterative tasks and stores the measurements with run/task context. The scorer is evaluated on training data in the current built-in implementation. For LogisticRegression/L-BFGS, the official example monitors a log-loss-derived score at each optimizer iteration and plots convergence across fits.
monitor = ScoringMonitor(scoring="d2_log_loss_score")
model.set_callbacks(monitor, ProgressBar())
model.fit(X, y)

# monitor logs contain one value per supported iterative task
Important distinction: a monitored sklearn scorer is not necessarily the optimizer's exact internal objective. It is still valuable as a monotonic/plateau signal, but the event schema should name it as a score/metric unless the estimator explicitly exposes its raw loss.
## 3.2 Estimator-specific loss curves
Some estimators expose loss history independently of the new callback API. MLPClassifier, for example, documents loss_, best_loss_, loss_curve_, validation_scores_, verbose output, convergence tolerance, n_iter_no_change, and early-stopping behavior. Its loss_curve_ contains one training-loss value per iteration. These features are useful, but they are estimator-specific rather than a universal sklearn contract.
**Runtime caveat. **An attribute such as loss_curve_ is guaranteed as fitted state, but reading it concurrently from another thread/process while fit mutates the estimator should not be the generic mechanism. Prefer native callback events or explicit estimator output. For unsupported estimators, stdout parsing or a wrapper around an incremental API can be a fallback.
## 3.3 Validation curve is more useful for overfitting
A decreasing training-loss curve can tell us that optimization is still making progress, has flattened, or is unstable. It cannot by itself tell us that the model is overfitting: training loss may continue to improve while generalization gets worse. When possible, the observation stream should contain both a training signal and a held-out validation signal.
iteration  35   train_loss=0.182   val_score=0.812
iteration  50   train_loss=0.137   val_score=0.817
iteration  70   train_loss=0.103   val_score=0.816
iteration  90   train_loss=0.081   val_score=0.807

Interpretation: training still improves, but validation peaked earlier.
Action: stop; next run may use fewer iterations / stronger regularization.
# 4. Interruption and restart strategy
The desired behavior should be adaptive rather than timeout-driven. scikit-learn's callback implementation explicitly allows a callback to signal stopping at the end of a task, which provides a clean control path for supported estimators.
| Observed pattern | Preferred action | Reason |
| --- | --- | --- |
| Training metric still improves meaningfully | Continue | Useful optimization is ongoing |
| Metric has plateaued for a meaningful window | Stop current fit | Additional iterations are unlikely to help |
| Validation deteriorates while training improves | Stop; plan a new run | Likely overfitting; fewer iterations or stronger regularization may help |
| Loss becomes NaN/Inf or clearly unstable | Stop; restart with changed setup | Current optimization is unhealthy |
| Progress is slow but still improving | Usually continue | No fixed timeout; runtime alone is not failure |
| Run completes normally | Evaluate final metrics | Decide next experiment from completed evidence |

**Stopping versus restarting with fewer iterations. **If the current estimator supports an interruption callback, stopping at the detected plateau is already equivalent to having used a smaller effective iteration budget for that run. There is usually no value in immediately re-running the exact same configuration merely with max_iter reduced. A restart makes sense when we want a clean reproducible experiment with the newly learned budget, or when other parameters also change (regularization, learning rate, model complexity, validation strategy, etc.).
# 5. Proposed framework abstraction
Do not expose sklearn-specific callback objects as the agent-facing contract. Normalize all training frameworks into a small semantic event model.
Training process
  ├─ native framework callbacks
  │    ├─ sklearn 1.9 callbacks
  │    ├─ XGBoost / LightGBM callbacks
  │    └─ framework-specific hooks
  ├─ estimator-specific telemetry
  ├─ stdout / stderr fallback
  └─ process & resource telemetry
            │
            ▼
      Normalized event stream
            │
            ▼
           Agent
## 5.1 Suggested normalized events
- run_started / run_finished / run_failed
- task_started / task_finished (pipeline stage, fold, candidate, estimator fit)
- iteration_finished
- metric_observed(name, value, split=train|validation|test, iteration, task_id)
- loss_observed(name, value, iteration, task_id) when a true loss is available
- progress_observed(current, total, task_id)
- resource_observed(cpu, memory, gpu, elapsed)
- stop_requested(reason, evidence)
## 5.2 Agent-level decision signals
The observation layer should provide raw evidence plus lightweight derived signals. The model can reason over them; the infrastructure should avoid prematurely encoding one hard-coded definition of “bad training.”
- plateau: improvement over the last N observations is below a configurable tolerance
- divergence: loss/metric is rapidly worsening or becomes non-finite
- overfit indication: validation trend worsens while training trend continues to improve
- convergence: metric/loss is stable and estimator is near its effective optimum
- heartbeat: process is alive even if a framework emits no semantic event for a while
# 6. scikit-learn adapter behavior
The adapter can choose the richest available path at runtime:
**1. Detect callback support: **If estimator exposes the 1.9 callback contract, register a telemetry callback and optionally a stopping callback.
**2. Capture task topology: **Preserve task name, task ID, parent/lineage, estimator name, and run ID.
**3. Monitor a meaningful scorer: **Use ScoringMonitor where appropriate; label it explicitly as train score unless validation metadata is actually available.
**4. Capture true loss when exposed: **Use estimator-specific adapters for genuine objective/loss signals such as iterative neural-network loss.
**5. Fall back gracefully: **Use verbose output parsing or lifecycle heartbeat for estimators with no callback/iterative telemetry. Do not pretend there is iteration-level observability when none exists.
**6. Apply stop decision: **Where callback-based interruption is supported, request an orderly stop at a task boundary. Otherwise terminate the worker only when the agent has enough evidence and graceful estimator control is unavailable.
# 7. Recommended curve policy for the first version
For the first implementation, the goal should be broad useful observability rather than perfect loss semantics for every sklearn estimator.
- Always collect task/progress events where callbacks provide them.
- Collect one or more per-iteration metrics through ScoringMonitor for compatible iterative estimators.
- If a true train loss is exposed, add it as a separate series instead of relabeling a scorer as loss.
- When a held-out validation metric can be obtained safely and cheaply, collect it; prioritize this for stop decisions related to overfitting.
- Use a rolling trend/window rather than a single bad observation before requesting stop.
- Record the stop reason and evidence so a subsequent agent can understand why the run ended.
- Do not set an automatic hard time limit. Elapsed time and resource use are observations, not by themselves termination criteria.
# 8. Example decision flow
Run starts: max_iter=1000

iter 10  train_metric=0.742
iter 20  train_metric=0.801
iter 30  train_metric=0.828
iter 40  train_metric=0.837
iter 50  train_metric=0.839
iter 60  train_metric=0.839

Agent observation:
- process healthy
- metric improvement over last 20 iterations ~0
- no evidence that additional iterations are useful

Decision:
- request graceful stop at the next supported task boundary
- keep the result
- do not rerun merely to lower max_iter
- for the next comparable experiment, use the observed convergence range
  as context for choosing the budget
# 9. Limitations to design around
- The callback API is experimental in sklearn 1.9 and may change.
- Only a small subset of sklearn estimators currently supports callbacks.
- ScoringMonitor currently scores training data; training score is not a substitute for validation behavior.
- Not every algorithm has a meaningful “epoch” or loss curve. Tree ensembles, closed-form estimators, and meta-estimators can have different natural units of progress.
- Computing a metric every iteration can add overhead, especially on large data. Telemetry frequency should be controllable.
- Cross-validation and search create concurrent/nested fits, so run/task lineage must be preserved to avoid mixing curves from different candidates or folds.
# 10. Conclusion
**The framework should use the curve as evidence, not as a fixed timeout replacement. **For supported sklearn 1.9 estimators, callbacks can give us push-based task events and per-iteration scores and can also request an orderly early stop. A true training-loss curve is available only for certain estimators, so the agent-facing interface should distinguish loss from arbitrary metrics and combine training behavior with validation evidence whenever possible. This gives the agent enough information to stop wasteful runs while still allowing legitimately slow but improving training to continue.
# Sources (scikit-learn 1.9 documentation)
  •    •    •    •    •    •
