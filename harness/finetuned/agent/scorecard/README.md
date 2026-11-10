# Scorecard

Reads one finished (or dead) finetuned run and prints its plain numbers and the
seven indicators of [a good spam1 run](../../../../docs/redesign-plan.md#what-a-good-spam1-run-looks-like),
each **pass**, **fail** or **not measurable yet** (with the missing fact and the
smallest hook that would record it). Two runs are also compared for indicator 7.

```sh
./dev bun run scorecard -- spam1                                  # newest run of spam1
./dev bun run scorecard -- spam1 --run <run-id>
./dev bun run scorecard -- spam1 --run <earlier> --run <later>    # or --run <later> --compare <earlier>
./dev bun run scorecard -- spam1 --runs /path/to/runs/finetuned --json
```

`--runs` defaults to `runs/finetuned/`; `--targets` overrides `targets/<task>.json`.
The command is read-only: it reads files and runs `git` with optional locks
disabled; a test checks that the runs directory is unchanged afterwards.

## Files

| File | Role |
| --- | --- |
| `layout.ts` | **Every folder, file and stage name the scorecard assumes.** Change this when the workspace changes (P6/P7: one `solutions/` workspace, four experts). |
| `facts.ts` | Reads a run: `state.json` (journal, works, counters), trial folders, champion tag, sealed check, hand-over, reports, knowledge notes, memory records. |
| `code.ts` | Census of agent-written Python and the data-loading heuristic. |
| `indicators.ts` | The seven indicators against `targets/<task>.json`. |
| `index.ts`, `format.ts` | Entry point, comparison, text output. `../scorecard_cli.ts` is the command. |
| `targets/spam1.json` | Targets from the plan's table. Copy it for another task. |

## Where the facts come from

- **Outcome, total time**: `state.status`/`reason`; start is `state.startedAt`, end the last journal entry.
- **Stages**: `works[]`; times from `work.result.startedAt/finishedAt`, else the journal's
  `stage_dispatched`/`stage_completed`. An interrupted stage ends at its last journal
  activity before `agent_invocation_interrupted` (marked "to last activity").
- **Model requests, sessions, tool calls**: `counters`; each model request is also a
  `budget_reserved` journal entry, split into "while a stage ran" and "outside stages".
- **Trials**: directories with `request.json` below each modelling stage's training dir,
  only. Training artifacts from other invocations are `referencedTrials`, never run trials, promotions or timing evidence. Kind: `search` when the
  request has `search`, else `scope.kind`. Start: first `events.jsonl` timestamp (else the
  `request.json` mtime). Completed: `trial-result.json` with `status`.
- **Champion**: this run's `training_selected_result` artifact (including work-result
  artifacts) or `selected_experiment_id` summary, with source commit from the trial's
  `invocation.json`. A surviving `champion/<task>` tag is a fallback only if it predates
  the run's end. A later tag cannot establish an earlier selection. Missing historical
  evidence is **not measurable**, rather than "no champion".
- **Sealed check**: the run's immutable `holdout_confirmation` artifact first, then
  `<task>/confirmation/latest.json` only with run attribution. Overwritten or missing
  historical evidence is not measurable. Agreement uses the recorded interval and gap.
- **Validation checks**: a readable `evaluation_report` JSON artifact with recorded
  task, metrics, source artifacts, validation result and structured review fields;
  stage success alone supplies no validation evidence.
- **Rounds**: a modelling invocation after a successful round is a follow-up;
  invocations after interrupted or failed rounds count separately as recovery retries.
- **Hand-over**: `deliveries/<task>/*/output.csv` (rows) and `manifest.json` (`deliveredAt`);
  a run's own via its `final_delivery` artifacts or the run window.
- **Stage reports / knowledge notes**: `<task>/reports/*<invocation>*`, `stage_report`
  artifacts; `knowledge/index.json` notes whose `origin.pipelineRunId` is the run.
  Revisions use `revision.author.pipelineRunId`, never the note creator. Missing
  revision authors are counted as unknown and are not attributed to any run.
- **Memory** (not recorded today): any `peakRssBytes`/`peakMemoryBytes` (or `…Mb`) key in a
  trial's `worker-exit.json`, `worker-runtime.json`, `supervisor-state.json`,
  `trial-result.json` or `resources.json`; agent scripts from `processes.jsonl` lines
  (`pipelineRunId` or `at`, `command`, `durationSeconds`/`durationMs`, `peakRssBytes`)
  anywhere below `<task>/` or `solutions/`. P1 should write one of these shapes, or
  `layout.ts` should be adapted to what it writes.

## Code attribution and the data-loading heuristic

Task folders and `solutions/` are reused between runs, so a file belongs to a run by
its modification time: **before**, **during** or **after** the run window. mtime records
only the last change. Files changed after the run are listed but not judged.
Harness-owned folders (trial source snapshots, data, refit, confirmation) are skipped;
`solve/research` is a harness copy of research and is listed but not counted.

The static census counts **confirmed read operations** naming declared task data,
including archives, CSV/table reads, image opens and binary/NumPy reads. Imports,
comments and filename mentions alone do not count. A known path assignment can
connect a read to declared task data. Dynamic/configuration paths and unresolved
reads are **uncertain candidates**, listed separately from confirmed implementations.
They prevent a reuse pass when more loaders may exist. Multiple confirmed loaders
still establish a failure. Cache readers remain listed. This is conservative static
analysis, not Python execution or a complete path-provenance proof.

## Task targets and evidence coverage

Indicator 1 compares the champion's recorded score with `simpleModel.minCvScore`
and its recorded total cross-validation fit time (`diagnostics.fitSeconds`) with
`simpleModel.maxFitSeconds`. The latter is a task-specific bound relative to its
reference; spam1 uses 42 seconds. Wall-clock worker runtime is not fit-time evidence.
No estimator, feature representation or classification type is required.
Optional `simpleModel.familyHint: true` enables a lexical family hint using
`featurePatterns`, `linearEstimators` and `nonLinearEstimators`. It is labelled as
unverified and never affects any verdict; it is off by default.

`targets/code2.json` (adjusted Rand index) and `targets/attacks1.json` (selection
score when available) have the same schema as spam1, with pending score and fit-time
bounds. A **null target** means **no target set** and is never a pass or fail.
`measurements.handOverRows` can also be null. Set task-specific targets before
judging those measurements; label-free tasks need recorded score evidence before
a numeric goal can be judged. Sealed confirmation is configurable, not assumed.

Both memory checks need recorded peaks for every run trial and nonempty script
observations with peaks for every observed script. A lone trial peak does not
establish script coverage. Missing coverage is not measurable; any observed peak
above the bound is still a definite failure. Observation producers must record all
scripts: absent records cannot prove that unobserved scripts stayed under a limit.

## Not measurable yet, and the hook each needs

| Fact | Hook |
| --- | --- |
| Peak memory of trials and agent scripts (indicators 4, 6) | P1: Linux sampler writes `peakRssBytes` into the trial's `worker-exit.json`; "run observed" writes one `processes.jsonl` line per script |
| Orchestrator model requests while it waits (indicator 6) | `coordinator.charge()` adds `source: "orchestrator" \| <stage invocation ID>` to the `budget_reserved` payload; the scorecard reads it when every entry has one |
| Module index (indicator 5) | P6 writes the index; set `moduleIndex` in `layout.ts` |
| Faster with memory (indicator 7) | a second run on the task: `--compare <earlier-run-id>` |
