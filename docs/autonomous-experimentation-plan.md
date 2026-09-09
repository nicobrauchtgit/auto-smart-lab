# Auto SmartLab: Autonomous Experimentation and Safety Plan

## 1. Purpose

Auto SmartLab should autonomously solve machine-learning challenges, evaluate its own work, and submit results without requiring human approval during the normal workflow.

The system should give the solver agent enough context and control to make informed decisions about experiments. Training duration alone must not terminate an experiment. Instead, the agent should receive meaningful progress signals as they occur and decide whether to continue, adjust, or interrupt the run.

This plan defines the desired framework and behavioral contract. It intentionally avoids prescribing concrete implementation mechanisms.

## 2. Core principles

1. **Autonomous, but not reckless.** The pipeline should not require routine human approval, but ambiguity or malformed agent output must never silently become permission to consume a limited submission.
2. **Semantic stopping, not wall-clock stopping.** Ten minutes is useful prior knowledge about expected task scale, not an automatic deadline.
3. **Push-first observability.** Progress should flow from the running experiment to the agent when new information becomes available.
4. **Explicit interruption control.** The agent must be able to stop an experiment and all of its child processes cleanly.
5. **Context continuity.** Long-running work should preserve the solver's reasoning, experiment history, and current state. Context must not be discarded merely because an arbitrary duration elapsed.
6. **Least privilege.** Solver and evaluator agents should receive only the tools, files, network access, and credentials required for their roles.
7. **Deterministic safety boundaries.** Submission accounting, archive construction, validation gates, and credential handling should remain outside model judgment.
8. **Framework-agnostic instrumentation.** Use native callbacks, verbose/debug output, or metrics APIs when a learning framework provides them, while retaining a standard progress protocol for stdlib-only or custom models.

## 3. Current repository findings

The repository has a clear high-level separation between solver, evaluator, and deterministic submission logic. Several current behaviors nevertheless make unattended operation unsafe or unreliable.

### 3.1 Critical: submission archives may include runtime credentials

The deterministic submission component recursively builds `source.zip` from the project tree using an extension allowlist. It does not use `.gitignore` as a security boundary and does not sufficiently isolate runtime state.

Consequences may include submitting ignored files such as PI authentication state, model runtime state, agent memory, or session metadata. Following filesystem links can broaden this exposure further.

Desired change:

- Define the submission artifact from a minimal, explicit set of required source files.
- Exclude all credential, session, memory, trace, environment, and unrelated project state by construction.
- Treat links and unexpected file types as invalid rather than following them.
- Verify archive contents before upload.

### 3.2 Critical: malformed evaluator output currently approves submission

When the evaluator does not emit the expected decision sentinel, the current logic defaults to approval. That can consume one of only three submissions without an affirmative, parseable decision.

Desired change:

- Evaluator output must be structurally validated.
- Missing, contradictory, or malformed decisions must never authorize submission.
- The autonomous recovery path may rerun evaluation, repair the evaluator response, or terminate safely, but it must not submit by default.

### 3.3 Critical: solver and evaluator receive submission authority and credentials

The shared session setup loads the SmartLab submission extension for solver and evaluator sessions while the process environment contains lab and model credentials. The solver also consumes externally supplied task content and has powerful filesystem and shell capabilities.

This creates an unnecessary prompt-injection and credential-exposure boundary.

Desired change:

- Solver sessions must not receive the submission capability.
- Evaluator sessions must not receive the submission capability.
- Lab credentials should be available only to deterministic fetch and submission components.
- Model and search credentials should be isolated from shell commands and task-controlled code wherever feasible.
- Each agent role should have a distinct capability profile.

### 3.4 High: the agent session has an arbitrary 30-minute lifetime

The shared session runner currently applies a 30-minute timer to the entire agent session. This conflates agent lifetime with the duration of an individual experiment and can discard useful context.

Desired change:

- Remove the ordinary wall-clock lifetime from the agent session.
- End a session when its workflow settles, it is explicitly cancelled, or an unrecoverable infrastructure failure occurs.
- Manage experiments independently of agent lifetime.

### 3.5 High: rejection can produce an unbounded autonomous loop

The outer solver/evaluator loop has no convergence policy. Repeated evaluator rejection can spend unbounded model time even though it does not consume SmartLab submissions.

Desired change:

- Replace an unbounded loop with evidence-based convergence rules.
- Preserve autonomy: the terminal state can be successful submission, a safe no-submit result, or a machine-readable unrecoverable failure.
- Do not impose an arbitrary fixed number of experiments. Use experiment history, improvement potential, repeated feedback, and available submission value to decide whether further work is justified.

### 3.6 High: documentation and active configuration disagree

The README advertises model identifiers and defaults that are not present in the active pipeline configuration. The environment example omits credentials required by the orchestrator, and the quick start mixes npm installation with a Bun-managed repository.

Desired change:

- Generate or validate documented model choices against active configuration.
- Document one canonical setup path.
- Make required and optional environment values consistent across examples, runtime checks, and configuration.

### 3.7 High: no automated project verification

The repository has no GitHub Actions runs or commit status checks, no visible automated test suite, and a test command that intentionally fails.

Desired change:

- Add automated checks for orchestration state transitions, evaluator parsing, archive safety, process interruption, progress events, and documentation/configuration consistency.
- Require the checks for changes affecting autonomous execution or submission.

### 3.8 Medium: observability is not connected to the main orchestration path

The trace dashboard infrastructure exists, but the shared solver/evaluator session path does not appear to publish its sessions through that observability layer.

Desired change:

- Use one event model for agent sessions, experiment processes, evaluator decisions, and submissions.
- Make the dashboard reflect the actual autonomous pipeline rather than only standalone SDK activity.

### 3.9 Medium: public coursework artifacts require review

The public repository includes a solver, task material, reports, and agent-run artifacts. This may be intentional, but public exposure should be checked against course rules and privacy expectations.

Desired change:

- Decide explicitly which task inputs, solutions, traces, and reports may be public.
- Keep generated runs and detailed traces out of version control unless publication is intentional.

## 4. Target autonomous workflow

The target workflow should behave as follows:

1. The orchestrator resolves and prepares a task.
2. A solver session begins with task context, prior experiment history, and a clearly bounded capability set.
3. The solver proposes and launches an experiment.
4. The experiment publishes progress events while it runs.
5. The solver receives those events and decides to continue, interrupt, or adjust the experiment.
6. Completed experiment results become durable structured evidence available to the same solver context.
7. The solver repeats only when it has a concrete improvement hypothesis.
8. The evaluator checks the proposed result using structured evidence and deterministic file validation.
9. A valid affirmative evaluation authorizes the isolated deterministic submission component.
10. Submission state and attempt accounting are recorded idempotently.

No routine human approval is part of this lifecycle.

## 5. Experiment supervision framework

### 5.1 Responsibilities

The experiment supervision layer should:

- Start a training, validation, feature-analysis, or search process without blocking the solver's ability to reason.
- Associate every process with a durable experiment identity.
- Capture structured progress, ordinary output, warnings, errors, resource behavior, artifacts, and final results.
- Deliver new progress to the active solver session.
- Allow the solver to interrupt the complete process tree.
- Preserve enough state to recover after context compaction or a session restart.
- Distinguish successful completion, agent-requested interruption, process failure, infrastructure failure, and lost supervision.

It should not decide that elapsed time alone makes an experiment invalid.

### 5.2 Push-based progress

Push delivery is the preferred operating mode. A training run should publish an event whenever it has meaningful new information. The supervision layer should forward that event into the agent workflow without requiring repeated blind status requests.

The event stream should support:

- Experiment lifecycle events: accepted, started, paused, resumed, stopping, stopped, completed, and failed.
- Training progress: epoch, iteration, batch, trial, fold, phase, and estimated completion.
- Quality metrics: training loss, validation loss, task metric, best metric, and improvement since the previous or best observation.
- Search progress: parameter values, completed trials, remaining trials, and current best configuration.
- Operational signals: heartbeat, CPU use, memory use, output activity, warnings, exceptions, and child-process health.
- Artifact events: checkpoint, prediction file, validation report, and diagnostic output produced.

Events should be structured and timestamped so the agent can reason over trends rather than isolated log lines.

If the agent runtime cannot accept unsolicited events during reasoning, a long-lived watch/subscription interaction is the preferred compatibility mechanism. Short polling is only a final fallback.

### 5.3 Instrumentation adapters

The framework should normalize signals from different learning implementations:

- Native callbacks or event APIs where supported.
- Verbose/debug output adapters where callbacks are unavailable.
- Training-history and metric objects exposed by the framework.
- Standard wrappers around cross-validation and parameter search.
- A small structured progress protocol for custom and Python-stdlib implementations.
- A coarse heartbeat and process-health stream when no model-level progress is available.

The current SmartLab instructions state that submitted solvers must use Python's standard library because the execution VM lacks packages such as scikit-learn. Therefore, scikit-learn and similar integrations should be supported as optional adapters, not assumed as a universal runtime dependency. The same agent-facing event contract should work for both framework-based local experiments and stdlib-compatible final solvers.

### 5.4 Signals required for agent judgment

At any meaningful update, the solver should be able to determine:

- What phase is running?
- How much logical work has completed?
- What is the latest training and validation quality?
- What is the best result so far?
- Is improvement continuing, flattening, oscillating, or reversing?
- Is training improving while validation degrades?
- How long has it been since a meaningful update?
- Is the process still using compute normally?
- Are memory use, data volume, or output volume becoming unreasonable?
- What warnings or errors have appeared?
- What result or checkpoint can be retained if the run is interrupted?

The signal contract should expose raw observations and derived trends. It may flag likely stagnation or overfitting, but the solver agent remains responsible for the stopping decision.

### 5.5 Time as context, not enforcement

The solver should receive domain guidance that SmartLab experiments will normally show their useful result within roughly five to ten minutes. This guidance changes how critically the solver evaluates a long-running experiment, but it creates no automatic termination.

An experiment may continue beyond ten minutes when its metrics, phase progress, and expected completion justify doing so. Conversely, the solver may interrupt much earlier when evidence shows that the run is stuck, overfitting, incorrectly configured, or no longer improving meaningfully.

## 6. Agent experimentation policy

The solver prompt and runtime contract should teach the following behavior:

1. Form a concrete experiment hypothesis before launching work.
2. Define the metric and observations that would support or refute it.
3. Prefer instrumented training paths that publish model-level progress.
4. Stay engaged with the experiment instead of waiting through one opaque blocking command.
5. Interpret progress as a time series, not as a single latest score.
6. Interrupt when evidence indicates overfitting, stagnation, divergence, unreasonable complexity, implementation failure, or negligible expected value.
7. Retain useful artifacts and diagnostics from interrupted runs.
8. Record why the experiment was continued or stopped.
9. Launch another experiment only when there is a specific change expected to improve the outcome.
10. Finish when the target quality is reached or no credible improvement hypothesis remains.

The prompt should include examples of common framework signals and how to interpret them, without hard-coding one learning library as the only valid approach.

## 7. Context continuity and recovery

Context management should be based on meaningful workflow boundaries rather than elapsed time.

The durable solver state should include:

- Task understanding and constraints.
- Current hypothesis.
- Experiment definitions and identities.
- Ordered metric and event history.
- Best result and associated artifacts.
- Rejected or disproven approaches.
- Active process state.
- Evaluator feedback.
- Intended next action.

Where the agent runtime supports it, evaluator feedback should return to the same logical solver context. If a fresh model session is unavoidable, it should reconstruct the exact logical state from the structured record rather than relying on a vague prose summary.

Context compaction must not terminate an active experiment. A resumed agent should be able to rediscover the experiment, subscribe to its current event stream, and continue supervision.

## 8. Evaluation and submission safety

The evaluator may use model judgment, but authorization to submit must combine that judgment with deterministic checks.

Required gates should include:

- A structurally valid affirmative evaluator decision.
- Existence and readability of the selected prediction artifact.
- Exact validation of row count, schema, delimiter, labels, ordering, and task association.
- Confirmation that the evaluator approved the same artifact that will be uploaded.
- Confirmation of the remaining submission budget from authoritative platform state where possible.
- Protection against duplicate upload after retry, crash, or ambiguous network response.
- A verified minimal source archive containing no runtime secrets or unrelated artifacts.

An ambiguous state should resolve autonomously when safe—for example by checking platform state or rerunning evaluation. It must not be interpreted as approval.

## 9. Role and capability boundaries

### Solver

Needs task inputs, permitted workspace files, experiment control, progress events, safe memory, and model access. It does not need lab login credentials or submission authority.

### Evaluator

Needs the task specification, solver artifact, validation evidence, experiment history, and read-only inspection capabilities. It does not need lab credentials or submission authority.

### Experiment supervisor

Needs authority to create and control bounded experiment processes and collect their signals. It should not have submission credentials.

### Submission component

Needs the approved artifact, minimal approved source set, platform endpoint, and lab credentials. It should not interpret task prompts or make modeling decisions.

### Observability component

Needs sanitized events. Secrets and raw credential-bearing environment state must never enter traces.

## 10. Unified observability model

One event model should cover:

- Orchestrator state changes.
- Solver and evaluator session activity.
- Experiment lifecycle and progress.
- Agent stop/continue decisions and their rationale.
- Artifact validation.
- Submission preparation, upload, and authoritative result confirmation.

The dashboard should answer:

- What is the pipeline doing now?
- Which experiment is active?
- Are metrics still improving?
- Why did the agent stop the previous run?
- Which artifact is currently considered best?
- What did the evaluator approve or reject?
- How many submissions remain?
- Has any component failed or lost contact?

Sensitive prompt content, credentials, cookies, and full environment dumps must be excluded or redacted before events are stored.

## 11. Delivery sequence

### Phase 0: immediate safety corrections

- Replace recursive source collection with a minimal submission manifest.
- Make evaluator parsing fail closed.
- Remove submission tools and lab credentials from solver and evaluator roles.
- Review public run artifacts and coursework exposure.

### Phase 1: define the experiment contract

- Define experiment states and terminal outcomes.
- Define the normalized progress-event schema.
- Define artifact ownership and retention.
- Define interruption semantics and process-tree ownership.
- Define recovery behavior after compaction, restart, or lost supervision.

### Phase 2: introduce autonomous experiment supervision

- Allow experiments to run independently of the agent's reasoning turn.
- Deliver progress push-first, with a watch/subscription fallback.
- Give the solver explicit interruption control.
- Preserve active and completed experiment history durably.
- Remove the agent-wide 30-minute timeout.

### Phase 3: update solver behavior and context management

- Replace the fixed three-iteration instruction with hypothesis- and evidence-driven experimentation.
- Add framework-specific examples and stdlib-compatible progress examples.
- Teach the agent how to identify overfitting, stagnation, divergence, and disproportionate computation.
- Preserve one logical solver context across experiments and evaluator feedback.

### Phase 4: harden autonomous evaluation and submission

- Introduce structured evaluator output.
- Add deterministic artifact gates.
- Make submission accounting and retries idempotent.
- Define autonomous recovery for malformed decisions and ambiguous upload responses.
- Add a safe no-submit terminal state.

### Phase 5: verification, documentation, and dashboard integration

- Add automated tests and continuous integration.
- Connect orchestrated sessions and experiments to the trace dashboard.
- Align the README, environment example, package manager, and active model configuration.
- Document supported instrumentation adapters and fallback behavior.

## 12. Acceptance criteria

The framework is ready when all of the following are true:

1. An agent session can remain active beyond 30 minutes without being cleared solely because of elapsed time.
2. A training process can publish meaningful progress to the solver as it occurs.
3. The same event contract supports framework callbacks, parsed verbose output, custom stdlib progress, and coarse heartbeats.
4. The solver can interrupt the complete experiment process tree and immediately continue reasoning.
5. Ten minutes is represented only as advisory task knowledge, never as an automatic kill condition.
6. The agent can justify every continuation and interruption using recorded signals.
7. Context compaction or session recovery preserves the active experiment and its history.
8. Malformed evaluator output cannot trigger submission.
9. Solver and evaluator sessions cannot access lab credentials or invoke submission.
10. The uploaded source archive contains only explicitly approved files and no runtime state.
11. Artifact validation proves that the evaluator-approved file is the file being submitted.
12. Network ambiguity cannot cause duplicate submission attempts.
13. The outer autonomous loop reaches a defined terminal state without an arbitrary experiment count or an unbounded rejection cycle.
14. Automated checks cover the critical safety and lifecycle behaviors.
15. The dashboard reflects the real solver, experiment, evaluator, and submission lifecycle.

## 13. Explicit non-goals

- Do not require routine human approval.
- Do not impose a universal model-training timeout.
- Do not assume scikit-learn or any other third-party library exists in the SmartLab execution VM.
- Do not let the evaluator or solver directly own submission credentials.
- Do not treat `.gitignore` as a security mechanism for upload packaging.
- Do not use context compaction or elapsed time as a reason to discard active workflow state.

## 14. Final target

The final system should behave like an autonomous research worker operating inside deterministic safety rails: it proposes experiments, receives live evidence, monitors learning behavior, interrupts unproductive work, preserves its context, evaluates results, and submits only when an explicit and verifiable authorization path has completed.

The framework supplies visibility, control, recovery, and isolation. The solver agent supplies judgment.
