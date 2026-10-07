# Pipeline integration and observability

Status: partially implemented, updated 2026-09-09. The shared executor, stage
configuration, trace identity, and the research and solve stages exist.
Evaluation and deterministic terminal refit are registered; submission is not registered yet. The dashboard shows
pipeline runs. Dashboard filtering is outside the current scope.

## Running the pipeline

```bash
npm run pipeline -- unit 1 task 1     # or --unit 1 --task 1, or `1 1`, or `spam1`
npm run pipeline -- unit 1 task 1 --dry-run
npm run pipeline -- --list
```

The run resolves the task from unit metadata, starts at the configured entry
stage, and follows each stage's successor while it stays enabled. With only
research enabled it stops as soon as `research.md` passes validation, and exits
non-zero when it does not.

## Code layout

| File | Responsibility |
| --- | --- |
| `agent/pipeline_cli.ts` | Argument parsing, task resolution, optional unit fetch |
| `agent/pipeline/executor.ts` | `invokeStage` and `runPipeline`: the one execution path |
| `agent/pipeline/registry.ts` | Implemented stages |
| `agent/pipeline/config.ts` | Validates the `pipeline` block; snapshot and fingerprint |
| `agent/pipeline/trace.ts` | Pipeline run and stage reporters over the shared event sink |
| `agent/pipeline/stages/research.ts` | Research stage definition and artifacts |
| `agent/pipeline/stages/solve.ts` | Solve stage definition and artifacts |
| `agent/pipeline/run_research.ts` | Research-only entry used by standalone commands |
| `agent/pipeline/run_solve.ts` | Research-through-solve entry for standalone commands |
| `agent/solve/folds.ts` | Fold recommendation and the sealed confirmation split |
| `agent/solve/workspace.ts` | Run workspace preparation and dev/sealed label split |
| `agent/solve/results.ts` | Typed access to one iteration's measurements |
| `agent/solve/iteration.py` | Recomputes every reported number and emits the signal |
| `agent/solve/canary.py` | Filename-leakage canary |
| `agent/solve/champion.py` | Champion re-run under the challenger's folds |
| `libs/smartlab-eval/` | Corpus loader and measurement library, installed into the venv |
| `agent/observability.ts` | Event sink, schema migration, agent session observer |

## Current entry points

- `agent/pipeline_cli.ts` is the pipeline entry point.
- `agent/research_cli.ts` and `orchestrate.ts --research[-only]` run research
  through `runResearchStage`, which calls the same executor.
- `agent/run/session_runner.ts` attaches the shared observer whenever the caller
  passes `observe`, which the stage reporter supplies per attempt. Research keeps
  its local `runs.jsonl` as a workspace record; it is not the trace.
- `pipeline.config.json` carries a `pipeline` block with the entry stage,
  scheduling mode, and per-stage enablement and options.
- `agent/pi_sdk.ts` remains a standalone experiment for the observability stack.
- Legacy evaluation and submission still run through `orchestrate.ts` outside the
  executor. The new `evaluate` stage uses the review contract documented below;
  submission remains unregistered. The
  legacy `runSolverSession` path there is unchanged and separate from the
  registered `solve` stage.

## Execution contract

One executor invokes registered pipeline stages. Both standalone CLIs and
pipeline scheduling call it. Each stage defines typed inputs,
options, and outputs, including references to produced artifacts.

Configuration identifies enabled stages, the initial stage, and stage options,
validated at load time against the implemented stage registry. Availability and
automatic execution are separate: enabling a stage does not imply that every
run must execute it. Initially enable research as the first stage; enable later
stages as they meet this contract.

The effective configuration is recorded after defaults and overrides are
resolved: `pipeline_run_start` carries a versioned snapshot and its fingerprint,
excluding credentials. Standalone tests create their own pipeline run and use the same
stage and session instrumentation.

A future observation/decision agent may invoke enabled stages through a tool
backed by this executor. Record its decision, the observable rationale, input
artifact references, and the resulting invocation. The executor enforces stage
availability, input contracts, and configured budgets for every caller.

## Required observability hooks

Two boundaries are instrumented:

1. The executor records stage start before setup, typed inputs and options,
   validation outcomes, output artifact references, and a terminal outcome:
   success, failure, or cancellation. This includes deterministic stages and
   errors that occur before an agent session can be created.
2. The shared session runner attaches the agent observer before the first
   prompt. Record prompts, emitted messages, tool calls and results, usage,
   retries, errors, and session completion. Flush pending events and release
   the observer and session on completion, error, and cancellation.

Events carry a pipeline run ID, stage invocation ID, and agent run/attempt ID;
`agent_events` gained nullable `pipeline_run_id`, `stage`, `stage_invocation_id`,
`attempt`, and `task_id` columns, and `pi_session_id` is now nullable for stage
events. Every run is also mirrored to `runs/<task>/pipeline/<run-id>.jsonl`, so a
run stays readable when the database is unavailable — and that degradation is
reported by the CLI rather than passed off as a complete trace. Retain
parent invocation or triggering tool-call references for nested execution.
Every repair session has its own attempt identity within the same stage.
Session completion does not imply stage success: research can still fail
artifact validation and require another attempt.

Extend the event model to support stage events without a PI session. Preserve
existing agent run identities and compatibility with older traces. Recording
failures must be visible; do not silently present an incomplete trace as a
fully observed execution.

## Typed metadata

Module prompts now live in `agent/prompts/`. The executor captures one immutable
template snapshot per run, shared across stages and research attempts. Research
uses a stable opening request and appends factual validation feedback on retry.
Agent traces record prompt IDs, template and rendered hashes, authored and
effective system prompts, and the opening message in `prompt_snapshot` events.
See [prompt management](../agent/prompts/README.md) for the retained legacy files
and tool-definition lifetime.

Store versioned metadata, not labels inferred from prompt text:

- Identity: task, stage, model, pipeline run, invocation, and attempt.
- Effective parameters: typed values such as
  `research.injectStartupContext: true`.
- Supplied inputs: an extensible discriminated union keyed by `kind`, with
  input version, delivery method, availability status, artifact reference,
  content fingerprint, and dataset fingerprint where applicable.
- Observed activity: derive tool use, counts, errors, and durations from events.

For example, a dataset profile can be delivered through `initial_prompt` or
`workspace_file`. Record both the requested injection setting and actual input
availability. An enabled setting does not prove useful context was supplied.
Keep parameter and input schemas validated at runtime as well as typed in code.

Use stable metadata keys when comparing runs. Dashboard filtering is outside the current scope.
Track tools made available separately from tools actually called. Correlate
start and completion events by tool-call ID so streamed updates do not inflate
usage counts. Hashes and artifact references support inspection; stable kinds,
versions, and parameter values support comparisons across runs.

## Module completion criteria

A module is a full pipeline participant when:

- Its registered input/output contract and configuration are validated.
- Standalone and scheduled execution use the same instrumented path.
- Typed parameters and supplied inputs are attached to its trace.
- Agent attempts and tool events link to the enclosing invocation and run.
- Artifact validation and final stage outcome are recorded separately from
  agent-session completion.
- Relevant integration tests cover successful execution, setup or execution
  failure, and repair/cancellation paths where supported.

Research meets these criteria today. Its trace reads as one invocation:

```
pipeline_run_start          config snapshot and fingerprint
  stage_started             research, effective options, upstream artifacts
  stage_input               task prompt, research context, startup profile
  research_context_prepared dataset and context fingerprints
  artifact_validation       state of research.md before any attempt
  agent_attempt_start       attempt 1
    agent_run_start ...     the agent session's own events, same identity
  agent_attempt_end
  artifact_validation       after the attempt; a failure triggers attempt 2
  research_finished         attempts, final validity, whether the document changed
  stage_summary             attempts, context and dataset fingerprints
  stage_finished            outcome, artifacts, supplied inputs
pipeline_run_end            outcome, stop reason, trace degradation
```

A document that fails validation is returned, not thrown: the stage reports the
validation result and the executor decides the outcome, so a failed research run
keeps its artifacts, fingerprints, and attempt count in the trace. Only a failed
session is raised as an error.

## The solve stage

The training ownership contract is defined in
[Harness-owned training framework](harness-owned-training.md). The registered
solve stage now uses the agent-driven harness path: the agent authors a pipeline
and deliberately requests trials, while the harness owns fold materialization,
fitting, predictions, measurements, process control, and promotion evidence.
See the [integration plan](agent-driven-harness-integration.md) for its boundary
and remaining milestones.

The material below describes the retained pre-migration result format. It is
historical compatibility documentation only: the registered solve stage no
longer accepts agent-written `metrics.json` or prediction files as promotion
evidence, and new work must not extend this legacy path.

Solve inverts the balance the legacy solver had. That path prescribed the
implementation -- a fixed `download`/`validate`/`solve` module, one holdout split
-- and trusted a `SOLVER_DONE val_score=...` line scraped from model output.
Solve prescribes nothing about the model and trusts nothing it is told.

The agent writes its own scikit-learn pipeline under `solutions/`, organised
however it likes. `solutions/tasks/<task_id>.py` is the one convention: an
orchestration entrypoint declaring a factory that returns an unfitted estimator
taking a frame with `id` and `text` columns. That exists so the harness can
re-run the agent's own pipeline for the canary and the paired comparison.
`solutions/` persists across tasks and runs, so it accumulates reusable code.

The dataset zips are handed over unmodified. Only the labels file is filtered:
a stratified `sealedFraction` of rows is absent from it, so the confirmation
split cannot be scored locally.

### The results contract

| File | Written by | Content |
| --- | --- | --- |
| `metrics.json` | agent | `cv`, `entrypoint`, `mean_bacc`, `folds`, `approach`, `variants_compared`, `done` |
| `oof_predictions.csv` | agent | `id;repeat;fold;prediction` plus optional `score` |
| `confirmation_predictions.csv` | agent | `id;prediction` for exactly the sealed ids |
| `notes.md` | agent | what was built, tried, and rejected |
| `iterations.jsonl` | harness | one measured record per iteration |
| `iterations/<n>/` | harness | snapshot of `solutions/` for a promoted champion |

`smartlab_eval` (`libs/smartlab-eval/`, installed into the venv) reads the corpus, writes this contract
from accumulated fold predictions, and offers ROC, threshold, calibration, and
paired-bootstrap diagnostics. The stage still reads the files rather than the
library, so a differently-produced set of files grades identically -- but the
prompt instructs the agent to use it for loading and writing, because both are
plumbing with one correct answer and a failure mode that costs a whole session.
Modelling stays entirely the agent's.

An example's id is its full path inside the zip. The labels file, the sealed id
list, and both prediction files all use that form, and `load_corpus` /
`load_labelled` return it, so ids stay consistent by passing through rather than
being reconstructed. Those loaders also open each archive exactly once:
`zipfile.ZipFile()` reparses the whole central directory on construction, so
opening per document turns a 0.2 s read of the corpus into roughly ten minutes
and can consume an entire session on IO alone.

### Compliance and diagnostics are separate

Compliance establishes that a score covers the development set and only it, so
two iterations are comparable. Failing it makes the iteration unmeasurable: no
score is recorded and nothing is promoted.

It does not make the iteration silent. The canary reads the agent's entrypoint
and its own sample of the corpus, so it depends on nothing the results files
say and runs either way; fold scores are recomputed over whatever rows were
scorable and reported as explicitly partial, alongside how much of the
development set they cover. A discrepancy check against the reported figure is
skipped while coverage is partial, because the difference would be an artefact
of the missing rows rather than a disagreement.

This matters because the common compliance failure is a formatting mistake. An
id written as a file name invalidates every row at once while saying nothing
about the model, and reporting it as thousands of missing predictions reads as
the wrong problem entirely; the error names the id form directly instead.

### Why the signal is not a single score

An out-of-fold score is honest once. Iterated against, it becomes a selection
target and drifts optimistic. Four mechanisms answer that:

- The fold seed rotates every iteration, derived from the stage invocation id, so
  a gain that exists on only one partition does not survive the next iteration.
- Every reported number is recomputed from the agent's own predictions. A
  disagreement is reported to the agent and recorded, not accepted.
- The challenger is compared against the champion on identical examples: delta
  with a stratified paired-bootstrap interval, folds improved, errors corrected
  against errors introduced, per-class recall deltas. Promotion requires the
  delta to clear its interval, so the champion does not move on fold noise.
- The sealed split is scored every iteration and shown to the agent only at the
  end. `sealed_gap_trend` in the stage summary is the direct measurement of how
  far the loop drifted; a widening gap is the loop overfitting its folds.

Because the champion snapshot usually shares module names with the current tree,
it is re-run in a separate interpreter. Loading both in one process would hand
the second import Python's cached copy of the first and silently compare the
challenger with itself.

### The leakage canary

Training filenames end in `.0`/`.1` and encode the label; test files end in `.x`.
The canary fits the agent's pipeline twice on identical text, once with real ids
and once with ids rewritten to the neutral form, and requires identical output.

It compares `predict_proba` or `decision_function` rather than predicted labels.
Comparing labels only detects a leak that flips a decision; where the text alone
already separates the classes a pipeline can read the filename and still predict
identically, and the leak stays invisible until the test set. This is the one
check the stage gates on, because a failure invalidates every other number.

A failure is not automatically a leak. Before it can compare anything the canary
has to load the declared entrypoint and re-fit the pipeline, and either can fail
on its own, so `CanaryResult` reports a `kind`: `id_dependence`,
`entrypoint_failed`, `fit_failed`, or `sample_unusable`. Only the first is
evidence about the model. The guidance the agent receives branches on the kind,
because telling it to remove whatever reads the id when its module path was
wrong sends it hunting a leak that does not exist. Promotion is blocked for
every kind, since an unverified pipeline is not a verified one.

### Trace shape

```
  stage_started             solve, effective options, upstream research artifact
  stage_input               task prompt, research document, research analysis,
                            dataset zips, sealed split, fold recommendation
  solve_workspace_prepared  development and sealed row counts, sealed fingerprint
    agent_attempt_start     iteration 1, rotated fold seed
      agent_run_start ...   the agent session's own events
    agent_attempt_end
  solve_iteration           recomputed measurements and coverage, discrepancies,
                            sealed gap, paired delta
  leakage_canary            pass or fail, with a reason and a failure kind
  champion_promoted         only where a paired delta cleared its interval
  ...                       further iterations
  solve_finished            iterations, stop reason, champion, sealed gap trend
  stage_summary             stop reason, champion score, sealed gap trend
  stage_finished            outcome, artifacts, supplied inputs
```

The loop stops on `agent_declared`, `no_measurable_gain` (two consecutive
iterations without a delta clearing its interval), `budget`, `cancelled`, or
`never_measured`. Stage success requires a champion whose canary passed; a run
that never produced one returns its artifacts and a failed validation rather
than throwing, so the iteration history stays in the trace.

Remaining work: register the submission stage; carry a champion across pipeline runs;
add autonomous scheduling and the decision agent's `invoke_stage` tool through
the same executor.

### Context continuity within an attempt

The shared runner monitors Pi context through `agent/context/session.ts`. At
the configured context threshold (currently 5k for testing; normally 120k), it completes the current tool batch, collects a tool-free handoff,
and creates another observed Pi session under the same stage invocation and
attempt. `context_usage` and `context_handoff_*` events link the physical
sessions; this transition does not complete or restart the stage. Stage-owned
training and optional subagent scopes survive it. The runner's `onSessionReady`
callback receives every new agent-run ID so optional subagent scopes can rebind
future spawns. See [smart context sessions](../agent/context/README.md).

### Setup preflight

Before any stage runs, the executor checks the prerequisites declared by every
stage on the requested path, respecting `--stage` and `--stop-after`. Standalone
research/solve commands use this same check. Run checks only with:

```bash
bun agent/pipeline_cli.ts unit 1 task 1 --stop-after solve --check-setup
```

Checks cover selected model credentials and a tiny live completion, research's
Tavily credential and read-only usage endpoint, local unit metadata/prompt,
labels and archive integrity, Python lock/environment health, training imports,
and the `zip` executable. All local failures are collected before remote probes;
a failed setup prevents every stage from starting. The model probe may incur a
small API charge; it uses no tools or dataset content. `setup.timeoutMs` and
`setup.modelMaxTokens` live in `harness.config.json`. `--dry-run` remains plan-only.

Setup events record check IDs, outcomes and fixed remediation text under the
pipeline identity (or invocation identity for direct stage calls). Credentials
and raw remote errors are never recorded. Successful probes are reused only
within one run. The trace database remains optional with an explicit degradation
warning and local JSONL fallback; Langfuse is not a required dependency until its
exporter is integrated. Add prerequisite declarations and failure tests with
new features; see AGENTS.md.

## Short evaluation stage

`evaluate` is now registered and enabled after solve. It reviews the selected
harness trial's OOF metrics and implementation, returning an advisory submission
readiness score out of 5 with evidence-linked issues and limitations. It cannot
submit or promote a model. `submit` remains unregistered. See
[model evaluation](../agent/evaluation/README.md) for tools, artifacts, the
scoring rubric, setup checks and standalone usage.

### Research test-input comparison

Research stage v2 explicitly identifies training features, training labels and
unlabeled test features in its context and supplied-input events. A dedicated
`research.test-distribution` prompt directs a sequential second pass over the
test inputs, comparing candidate availability and investigating more transferable
features when literal patterns shift. The report needs cited split-specific
training and test evidence when test inputs are available. This uses the existing
filesystem/bash tools and shared archive preflight, and adds no model sessions
or dependencies. See [research workflow](../agent/research/README.md).

### Training restart recovery

Solve and standalone solve invoke the same training-service startup recovery
before the agent session. Recovery keeps the originating training root and
budget, while events retain origin run/invocation fields alongside the current
reporter's identity. Recovered source is declared through the same typed
`training_source` input callback. Tool instructions for `experiment_resume`
come from the per-run prompt snapshot. Kernel locking/process identity and
worker files are scoped prerequisites of `training` in shared preflight; no
provider credentials are added. See the [durable recovery contract](training-search-and-versioning.md#durable-interrupted-experiment-recovery).

## Terminal refit stage

`agent/pipeline/stages/refit.ts` registers deterministic terminal training;
`agent/pipeline/run_refit.ts` and `agent/refit_cli.ts` provide the standalone
executor path (`npm run refit-stage -- <task-id> [--check-setup]`). The configured
chain is research → solve → evaluate → refit. Submission stays unregistered and
disabled. Refit has no successor or model session. Evaluation remains advisory.

Refit resolves the chosen champion tag rather than the generic score-sorted
selection artifact. It records typed freeze/evidence inputs, supervised process
events and validated final predictions/model/result artifacts under shared
pipeline/invocation IDs. Setup declares `python`, `task` and `refit`, without any
model or web credentials. Whole-chain preflight checks data/runtime availability
before solve; candidate evidence is checked at refit invocation when solve is its
producer. Standalone checks include chosen candidate integrity up front.

See [terminal freeze, execution, artifacts and retry semantics](harness-owned-training.md#implemented-terminal-refit).

## Invocation guidance and live feedback

The module context interface is available without an orchestrator agent. Research,
solve and evaluate accept optional `StageGuidance` run data. Refit and submission
refuse guidance and feedback. No providers or dependencies are added by this
interface; stage-specific prerequisites and the entire configured chain still
use shared setup before workers start. Local evidence and note validation run
before that chain starts, including `--check-setup`.

```ts
import { runPipeline, startStageInvocation } from "../agent/pipeline/executor.js";
import { guidanceHash } from "../agent/pipeline/guidance.js";

const body = {
  id: "solve-transfer-risk", version: 1, stage: "solve" as const,
  taskId: "spam1", content: "Investigate the observed vocabulary shift.",
  objective: "Check whether OOF evidence supports transfer to test inputs.",
  author: { name: "caller", logicalSessionId: "logical-owner", physicalSessionId: "session-1" },
  evidence: [],
};
const guidance = { ...body, contentSha256: guidanceHash(body) };
await runPipeline({
  taskId: "spam1", stopAfter: "solve", guidance: { solve: guidance },
  // An optional research note can be supplied separately in the same map.
  onInvocation(handle) {
    // Keep handles to send factual feedback or cancel; result is artifact validation.
    console.log(handle.invocationId, handle.state());
  },
});

// With an existing run-owned trace and resolved enabled configuration:
const handle = startStageInvocation({
  stage: "solve", config, trace,
  input: { taskId: "spam1", upstream, guidance, evidenceCatalog },
});
const facts = { id: "feedback-1", stage: "solve" as const, taskId: "spam1",
  content: "A new reviewed artifact identifies a coverage gap.", evidence: [] };
const receipt = await handle.feedback({ ...facts, contentSha256: guidanceHash(facts) });
// receipt.status: queued, delivered, or refused. Reuse the same ID to query its receipt.
handle.cancel();
const invocation = await handle.result;
```

`invokeStage` remains the awaitable compatibility API. `runResearchStage`,
`runSolveStage` and `runEvaluateStage` forward optional `guidance` maps and
`evidenceCatalog` to `runPipeline`. Solve-through-research accepts separate notes
for both stages. The pipeline CLI also accepts `--guidance notes.json`, with
exact top-level keys `{ "guidance": { "solve": { ... } }, "evidenceCatalog": [] }`.
`--stage` and `--stop-after` support standalone use of this same path. A note for
an unrequested stage is rejected, as are unknown note fields and prompt variables.

The caller owns the trusted provenance catalog. Evidence references contain
`artifactId`, `taskId`, `pipelineRunId`, producer `invocationId`, `sha256`, and
optional `datasetSha256`/`candidateId`. Each reference must match exactly one
catalog artifact's `provenance` and `sha256`, have the invocation's task binding,
and still hash to the cited bytes on disk. Optional dataset hashes must be SHA-256
values and match the catalog. The executor adds producer provenance to outputs
with valid SHA-256 hashes. Legacy artifacts without producer provenance remain
usable upstream but cannot be cited as guidance evidence until the caller supplies
verified provenance. A path or note hash alone does not establish ownership.
This is a trusted caller interface, not a cryptographic artifact registry.

Guidance hashes cover the canonical sorted-key JSON body, excluding
`contentSha256` itself. Notes allow 8 KiB content, 2 KiB objective, 16 evidence
references, 256-byte identity fields and 24 KiB total serialized content.
Referenced files are hash-checked with a 64 MiB size bound. Guidance is deeply
snapshotted before the invocation's first await; all planned notes are validated
before any earlier worker starts. A later revision needs a new invocation.
Research repair attempts and physical context replacements use the same note.
Opening templates expose an optional `guidance` variable whose absent value is
empty, preserving unguided rendered text. Base contracts remain authoritative.

Guidance metadata uses `stage_guidance` supplied inputs and an invocation-specific
JSON artifact beside the trace. Note content and artifact hashes are distinct
from authored template and rendered-message hashes. Live feedback uses separate
`stage_feedback` inputs and an append-only, flushed receipt journal beside the
trace, including accepted note payloads and shared run/invocation identities.
Accepted IDs are retained without eviction; each invocation allows at most 64
receipts, each under the same message/evidence byte bounds as guidance. Reusing
an ID with different content is rejected. Duplicate requests return the existing
receipt without rereading evidence that may since have changed.

Handle states are `preparing`, `active`, `between-attempts`, `finishing` and
`terminal`. The runner binds one logical facade per attempt, preserving existing
training-service bindings on every physical session. Feedback is queued through
handoff and injected as identity-bearing custom messages only when the SDK
naturally assembles another model request. `delivered` means included in that
request context, not successful remote receipt or model agreement. It never starts
an extra turn after a final answer. Already delivered IDs are not replayed as live
feedback on replacement. Remaining queued IDs get a durable refusal at cancellation
or invocation completion; late feedback explicitly asks for the next invocation.
A finished session remains separate from the stage's artifact validation result.

The journals are durable receipts, not host-crash recovery or a coordinator state
store. This interface adds no scheduling loop, caller shell/tool access, provider
calls, submission permission, promotion evidence, sealed-data access, or ability
to change the frozen refit candidate. Factual feedback is caller-supplied data;
workers must inspect evidence and the harness still validates their artifacts.

## Dynamic agent scheduling and recovery

`agent/orchestrator/run.ts` replaces scheduling policy while retaining this executor.
The explicit `orchestrate` CLI authorizes an immutable controller submission policy;
configured scheduling and the generic pipeline API never grant uploads merely by
enabling submit. `scheduling: "agent"` is opt-in; the generic API uses no-submit mode.
All available enabled capabilities receive shared preflight before the first agent.
Official recovery and already-complete goals can terminate before model prerequisites.

`InvokeStageOptions.invocationId` reserves a durable identity before effects.
`executionGuard` supplies durable physical-session/request/tool budgets through the
existing reporter observation. `StageInvocation.summary` retains stage-authored
measurements separate from validation/outcome. Content-hashed provenance IDs
version changed receipts when the same invocation reconciles later.

`StageInput.submissionPolicy` is controller data:
`{version:1,authorized,maxSubmissions,pipelineRunId,controllerInvocationId}`. The cap
is an absolute total task cap in 0..3, less consumed official and unknown reserved
attempts. `controllerInvocationId` is the reserved submission work ID; root control
ownership is stored separately. No model or stage option supplies authorization.

`StageDefinition.reconcile` and `recoverySetupRequirements` declare deterministic
restart recovery. Executor `mode: "reconcile"` runs only the registered reconciliation
handler and never falls back to `run`. Unknown submission outcomes use read-only
network reconciliation/receipt writes; absent intents refuse fresh uploads. Physical
agent sessions cannot be reattached after host death. Guidance/feedback remain
bounded typed inputs under the original controller/executor identities.

See [orchestrator runtime](../agent/orchestrator/README.md) for state/journal APIs,
notification acknowledgment, action deduplication, budgets and current limitations.
