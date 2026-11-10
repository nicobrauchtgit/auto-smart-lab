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
  plus trial directories named by the run's `training_*` artifacts. Kind: `search` when the
  request has `search`, else `scope.kind`. Start: first `events.jsonl` timestamp (else the
  `request.json` mtime). Completed: `trial-result.json` with `status`.
- **Champion**: annotated tag `champion/<task>` in `solutions/`; its score from the trial's
  `trial-result.json`; model family from the entrypoint at the tagged commit (plus the
  local modules it imports, one level).
- **Sealed check**: `<task>/confirmation/latest.json` → result; agrees when the CV mean
  (`score + gap`) lies inside the bootstrap `interval`.
- **Hand-over**: `deliveries/<task>/*/output.csv` (rows) and `manifest.json` (`deliveredAt`);
  a run's own via its `final_delivery` artifacts or the run window.
- **Stage reports / knowledge notes**: `<task>/reports/*<invocation>*`, `stage_report`
  artifacts; `knowledge/index.json` notes whose `origin.pipelineRunId` is the run.
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

A Python file **implements data loading** when it opens the task data itself: it uses
`zipfile`/`ZipFile(` or names one of the declared data files (train/test archive, targets
file). Importing such a module does not count; importing one *and* opening the archives
again does. Files that read a saved copy (`np.load`, `pickle.load`, `joblib.load`, …) are
listed as cache readers, not as loaders.

## Not measurable yet, and the hook each needs

| Fact | Hook |
| --- | --- |
| Peak memory of trials and agent scripts (indicators 4, 6) | P1: Linux sampler writes `peakRssBytes` into the trial's `worker-exit.json`; "run observed" writes one `processes.jsonl` line per script |
| Orchestrator model requests while it waits (indicator 6) | `coordinator.charge()` adds `source: "orchestrator" \| <stage invocation ID>` to the `budget_reserved` payload; the scorecard reads it when every entry has one |
| Module index (indicator 5) | P6 writes the index; set `moduleIndex` in `layout.ts` |
| Faster with memory (indicator 7) | a second run on the task: `--compare <earlier-run-id>` |
