# Pipeline integration and observability

Status: partially implemented, updated 2026-09-09. The shared executor, stage
configuration, trace identity, and the research and solve stages exist.
Evaluation and submission are not registered stages yet, and the dashboard shows
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
- Evaluation and submission still run through `orchestrate.ts` outside the
  executor. They are unregistered stages until they meet this contract. The
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

Remaining work: register evaluation and submission stages; carry a champion across pipeline runs;
add autonomous scheduling and the decision agent's `invoke_stage` tool through
the same executor.
