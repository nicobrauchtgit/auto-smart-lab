# Agent-driven harness integration plan

Status: milestone 1 implemented; follow-on milestones planned, 2026-09-25.

This plan connects the framework in [harness-owned-training.md](harness-owned-training.md)
to the registered solve stage. The solve agent remains the experiment designer;
the harness becomes the only authority for folds, fitting, predictions, and
measurements.

## Boundary

The solve agent must:

- author a real pipeline under `solutions/`;
- choose features, estimator, parameters, CV semantics, and search strategy;
- decide when to start, inspect, continue, promote, or stop a trial; and
- invoke the typed training tools deliberately.

The harness must:

- reject requests that do not reference agent-owned project code;
- derive every seed and materialize every fold before fitting;
- own the worker and its descendants, authoritative predictions, metrics, and
  artifacts;
- remain observable and interruptible while a fit runs; and
- decide whether the resulting evidence is complete and promotion-eligible.

There is no production fallback pipeline. A session that never authors a
pipeline and starts a valid harness trial produces no training evidence and the
solve stage fails validation. A completed agent session is never sufficient for
stage success.

The model API credential belongs to the agent session only. Training workers
receive an explicit environment allowlist and never receive model, Smart Lab,
search, cloud, or unrelated credentials.

## Milestone 1: replace the legacy solve execution path

1. Prepare the task, development archive, development labels, research inputs,
   solution directory, and immutable prompt snapshot through the existing solve
   workspace path. Do not scaffold a working estimator.
2. Construct one session-scoped harness before the first agent prompt. Bind it
   to the observed agent session and expose only `experiment_start`,
   `experiment_status`, `experiment_output`, and `experiment_stop` alongside the
   normal file and shell tools. Do not expose the generic arbitrary-command
   experiment tools.
3. Tell the agent to create its pipeline and use the training tools. The agent
   may run several pilots and promotion trials during the same session; tool
   calls return IDs immediately so it can observe or stop owned processes.
   `solve.experimentUpdateIntervalSeconds` in `pipeline.config.json` sets the
   minimum gap between routine progress messages. The configured value is 30
   seconds. Exit, warning, memory, and stall updates can arrive sooner.
4. Pass each accepted request through `TrainingService`. The service supplies
   the executable, cwd, inputs, output directory, and seed lineage and starts
   only the fixed worker.
5. Always close the harness scope in `finally`. Session failure, cancellation,
   or ordinary completion must stop every remaining descendant.
6. After the session is closed, validate every durable trial directory. Preserve
   failed and interrupted evidence. The stage is valid only when at least one
   complete promotion result and all of its authoritative artifacts validate.
7. Remove the legacy agent-written OOF evaluator from the registered path. Do
   not accept `metrics.json` or predictions authored by the agent as promotion
   evidence.

## Security and code ownership

- Production pipeline and CV modules must be safe project-relative paths under
  `solutions/`. Test fixtures may be enabled only by explicit test setup.
- The worker environment is built from a small runtime allowlist. In particular,
  `SAIA_API_KEY`, `LAB_USER`, `LAB_PASS`, `TAVILY_API_KEY`, cloud credentials,
  and arbitrary caller variables are absent.
- Typed runtime inputs expose task data and development labels, not full labels,
  sealed IDs, or sealed rows. This does not make otherwise accessible repository
  files unreadable to shell or file tools.
- Automatic repository context loading remains disabled. This is prompt
  isolation, not filesystem isolation; enforced workspace isolation is separate
  future hardening.

## Observability and artifacts

All training events use the enclosing pipeline run and solve-stage invocation
IDs. Record:

- the solve agent observation and tool calls;
- typed task, research, dataset, Python environment, and training-framework
  inputs;
- accepted requests and seed-plan identity;
- worker lifecycle and resource observations;
- fold manifest, fold results, OOF predictions, metrics, and terminal result;
- validation errors for missing, corrupt, incomplete, pilot, stopped, or failed
  trials; and
- the deterministically selected eligible result for the stage summary.

The executor continues to own `stage_started` and `stage_finished`. The solve
module returns artifact validation; it never records stage success itself.

## Acceptance checks

- With no agent-authored pipeline or no training-tool call, solve returns failed
  validation and no promotion evidence.
- The agent can choose a valid pipeline, parameters, and built-in or custom CV,
  but cannot choose a seed, executable, cwd, output path, or predictions.
- Fold assignments are durable before the first `fold_started` event.
- A pilot and an interrupted trial are never promotion-eligible.
- A complete promotion trial produces harness-authored OOF predictions and
  metrics and can make the stage valid.
- The solve agent cannot resolve the generic experiment start tool.
- The worker cannot read model, Smart Lab, search, or cloud credentials from its
  environment.
- Session error and cancellation close the scope and leave no worker descendants.
- Agent events, training events, inputs, and artifacts share pipeline and stage
  identities.
- The standalone solve command and scheduled pipeline use this same path.
- No test or solve execution invokes evaluation, upload, or submission.

## Follow-on milestones

Milestone 1 proves the agent-triggered ownership boundary for development
trials. The remaining framework work stays ordered:

1. persist candidate/cohort identity and compare a frozen champion on the exact
   challenger manifest;
2. connect one-use sealed confirmation without disclosing sealed rows or labels;
3. freeze source, parameters, dependencies, seed lineage, and supporting
   evidence; then perform terminal full-data refit and test prediction; and
4. add search adapters only after the single-candidate lifecycle is complete.

Evaluation and submission remain disabled throughout these milestones.
