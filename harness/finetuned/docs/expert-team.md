# Expert team: workspace, sandbox and experts

Status: design for package P5 of [the redesign plan](../../../docs/redesign-plan.md),
2026-11-10, revised the same day with the user's decisions on the shared tree,
follow-up branches, sealed numbers and the label-free path. Documents only.
Paths are relative to `harness/finetuned/` unless they start with `runs/`.
Draft prompts are in [expert-team/prompts/](expert-team/prompts/); they are not
registered and move to `agent/prompts/` in wave 2.

P1 (observed scripts, one memory pool), P3 (run mechanics) and P4 (scorecard)
are assumed to exist as the plan describes them. "Run observed" means the P1
shell: short commands return directly, long ones return an ID and wake the
agent by rule.

## 1. At a glance

| Today | Design | Reused | Deleted |
| --- | --- | --- | --- |
| research, solve, evaluate stages | data, literature, modelling, validation stages | `StageDefinition`, executor, registry, session runner, lesson step | research session, brief, research budget, evaluate stage |
| research folder, solve scratch folder, `solutions/` | the one checkout `runs/finetuned/solutions` | `ensureSolutionsRepository`, `branches.ts` (follow-up rounds, checkpoint) | `runs/<task>/research/analysis/`, `copyResearch` |
| research sandbox (full task data), solve sandbox (dev data) | one sandbox policy, dev data only | `sandboxPolicy`, `isolatedSolveTools`, `trainingSandboxCommand` | `prepareResearchSandbox` |
| sealed split made by solve | sealed split made at `task_configure` | `seal()`, `writeDevelopmentZip`, seed plan | sealing inside `prepareSolveWorkspace` |
| `research.md` + brief validator | per-task findings journal | URL check of `research/validate.ts` | brief checks, `check_brief` |
| one mutating stage | one code-writing expert, plus literature beside it | coordinator, state store, `pipeline_wait` | none |
| reviewer reads the sealed confirmation | sealed numbers reach the orchestrator only | confirmation service, receipt, reuse ledger | confirmation input to `evaluation/evidence.ts` |

## 2. The workspace

### 2.1 Layout

`runs/finetuned/solutions/` stays the one versioned repository
(`ensureSolutionsRepository`, `agent/training/git.ts:90`) and the one working
tree every expert uses. Its layout:

```text
solutions/
  README.md     rules of the workspace (harness-owned, from agent/solve/solutions-README.md)
  INDEX.md      one line per module: path, purpose, owner role, tasks that import it
  lib/          shared across tasks; imported as solutions.lib.<area>.<module>
    io/         reading sample descriptors: archives, members, captures, images
    parse/      format parsers (text, documents, binaries, sessions, images)
    features/   representations: transformers with fit/transform
    models/     reusable estimators and wrappers
    cv/         splitter factories
  checks/       short checks, run with pytest by the experts and by the harness
    lib/        checks of shared modules on a small fixture or sample
    <task>/     task checks (data facts, leakage controls, output domain)
  tasks/
    <task>.py   harness entrypoint (unchanged contract: build_pipeline, optional CV factory)
    <task>/     task-specific modules not (yet) worth sharing
  docs/         notes about formats and modules, one file per topic
  scratch/      ignored; throwaway output, never committed
```

Per task: `tasks/<task>.py`, `tasks/<task>/`, `checks/<task>/`. Shared:
`lib/`, `checks/lib/`, `docs/`. A module moves from `tasks/<task>/` to `lib/`
when a second task imports it; the mover updates `INDEX.md`. `solutions.lib...`
imports already work in harness trials: the worker puts the directory holding
the trial's `solutions/` on `sys.path` and `PYTHONPATH`
(`agent/training/python/smartlab_trial/agent_code.py:83`).

The findings journal is the one shared record that is not in git (section 5):
the literature expert writes it while a code-writing expert works, and the
harness owns its structure.

`README.md` loses the sentence that the spam task IDs encode labels
(`agent/solve/solutions-README.md`): that fact belongs to the task description,
not to a file every task reads.

### 2.2 Rules and their cheap checks

Rules (stated in the shared workspace prompt):

1. One module per concern: read one format, build one representation, define
   one estimator, run one check.
2. Every Python file starts with a docstring: first line what it does, second
   line its inputs and outputs.
3. `INDEX.md` lists every module under `lib/` and `tasks/<task>/`; adding or
   moving a module updates it in the same commit.
4. Search before writing: `INDEX.md`, then `rg`. Extend an existing module
   (new function, new parameter) instead of copying it.
5. Agent Python lives only in `solutions/`; scratch output in `scratch/`.

`agent/workspace/check.ts` runs after every code-writing invocation and on
demand through a `workspace_check` tool. It is a bounded static pass (no import
of agent code, at most 2 s):

| Check | How | Result |
| --- | --- | --- |
| headers | first statement of each `.py` is a docstring | error per file |
| index | every `lib/**/*.py` and `tasks/<task>/**/*.py` is listed in `INDEX.md`; every listed path exists | error per path |
| duplicates | normalised function bodies hashed; same hash in two files | warning with both paths |
| reuse | `solutions.lib` imports of each task entrypoint | measurement (P4 indicator 5) |
| loader count | modules that open the task's input archives | measurement; more than one per format is a warning |
| stray code | agent-written `*.py` outside `solutions/` in the run folders | error |
| size | file over 400 lines | warning |

Errors fail the invocation's validation and are returned as factual feedback;
warnings go into the stage summary.

### 2.3 Research's and solve's folders

`runs/finetuned/<task>/research/` and `runs/finetuned/<task>/solve/agent/` are
no longer written. The harness data profile moves to
`runs/finetuned/<task>/data/profile.json`, built by `agent/research/profile.ts`
on the development data. `solve/training/` stays where trial records are. Old
run folders stay as history; P4 reads them.

## 3. The one sandbox and its data

### 3.1 The sealed split exists before the first expert

Today the split is drawn inside `prepareSolveWorkspace`
(`agent/solve/workspace.ts:121-158`), and research mounts the whole task
directory (`agent/run/solve_sandbox.ts:110`), so research reads sealed rows.

The draw is deterministic: its seed plan depends on the root seed, the task and
the training data hash, with a fixed experiment ID (`workspace.ts:129-133`). It
can move without changing which rows are sealed. `prepareTaskData` (P6) runs
when `Coordinator.configure` (`agent/orchestrator/coordinator.ts:145`) accepts
a configuration and writes `runs/finetuned/<task>/data/`:

- `sealed/`: sealed IDs and `holdout.json` (harness only, never mounted);
- the development archive (sealed members removed, as today);
- `development-samples.json` (descriptors and development targets);
- `profile.json` (harness data profile of the development data);
- `identity.json`: the one dataset fingerprint (development archive plus
  manifest) used by trials, knowledge and findings.

A re-declaration that changes `targets` or `holdout` after any expert has run
is refused, since development rows already seen could become sealed. Every run
on the same task and data draws the same split, so findings from an earlier
run never rest on rows that are sealed in this one.

### 3.2 Per task kind

| Kind / input | Sealed rows | Experts see | Development targets |
| --- | --- | --- | --- |
| binary classification (text, documents, binaries) | stratified, class-based sizing | development archive, test archive | labels in the manifest |
| clustering with families (code, binaries) | whole families (`sealGroups`) | development archive without sealed families, test archive | family IDs in the manifest; scoring only, never passed to `fit` |
| anomaly detection, no labels (images, sessions) | none (`holdout: none`) | all training samples, test samples | none (section 8) |
| anomaly from a capture (`pcap_tcp_connections`) | none; the whole capture is the development input (`workspace.ts:151`) | capture, connection descriptors | none |

### 3.3 One policy

`agent/run/sandbox.ts` (renamed from `solve_sandbox.ts`) keeps `sandboxPolicy`,
`isolatedSolveTools` and `trainingSandboxCommand` and replaces the two prepare
functions by one `expertSandbox(data, role, python)`:

- read-only for every role: `runs/finetuned/<task>/data/` without `sealed/`,
  the test archive, the task text, the findings view, the Python prefix and the
  binaries;
- `runs/finetuned/solutions` (with its `.git`): writable for data, modelling
  and validation, read-only for literature, which has no write or shell tool
  anyway.

No policy mounts `data/sealed/` or the original training archive. The
`solve-isolation` setup check (bubblewrap) now covers every expert.

### 3.4 Test archive visibility

The unlabelled test archive is visible read-only to every expert, as it is to
solve today (`workspace.ts:174`). It carries no labels; the data expert must
compare training and test inputs; batch tasks fit on the test batch itself;
refit reads it anyway. Pseudo-labelling and fitting on test rows are ruled out
by the prompts, by harness trials (only refit with `fit_predict_test_batch`
reads test rows) and by a validation check. Test IDs are neutral.

### 3.5 Who sees sealed numbers

The confirmation still runs at the end of a modelling invocation that leaves a
champion (`agent/run/harness_solve_session.ts:388`); the `holdout_confirmation`
artifact goes to the orchestrator only. Structural changes:

- `evaluation/evidence.ts:58-67` stops requiring and passing the confirmation,
  so the validation expert never sees it;
- `Coordinator.sealedExposure` (`coordinator.ts:130-133`) refuses confirmation
  artifact IDs for every expert; validation output is no longer treated as
  sealed, since validation no longer reads the confirmation;
- `lessons.sealed` is deleted: no expert receives sealed numbers and the
  orchestrator has no lesson step.

Keeping the numbers out of objectives, guidance and feedback text is an
instruction to the orchestrator (its system prompt), not a filter.

### 3.6 Disk and memory

The machine has about 9 GB free disk, 15 GB RAM and 6 cores. The development
archive is a member copy (`zip --copy`, no inflation), so a 3 GB archive costs
up to 3 GB more. `prepareTaskData` keeps the prepared data of one task at a
time and deletes other tasks' development copies (they are rebuilt
deterministically). A new setup requirement `disk` asks for free space of 1.2
times the training archive plus 1 GB before a configuration is accepted. P1's
machine prompt tells experts the pool size and to stream archives.

## 4. The four experts

Each expert is a registered stage running one session through `runSession`
with its own prompt, tool allowlist and lesson step. Shared tools: read, grep,
find, ls; `findings_read`, `findings_add`, `findings_resolve`;
`workspace_check`; knowledge search/read/capture; `python_environment`
inspect.

| | data | literature | modelling | validation |
| --- | --- | --- | --- | --- |
| Field | what is in the dataset | what to try and why | the pipeline | whether code and evidence hold |
| Delivers | reading code in `lib/`, data facts, data checks | ranked ideas with sources | entrypoint, harness trials, champion | checks, concerns, a verdict |
| Code-writing | yes | no | yes | yes (checks) |
| Shell | run observed | none | run observed | run observed |
| Trials | no | no | `experiment_*` tools | reads records |
| Web search | no | yes | no | no |

### 4.1 Data expert

Field: inputs, formats, sizes, targets, duplicates, train/test differences, and
what the task text states about the data. Delivers the reading code for the
task's input format (extending `lib/io` and `lib/parse` when they exist), facts
in the journal tied to a check, a profile record or a script output, and the
checks under `checks/<task>/` that prove them.

Must not: fit estimators to compare models; report as a problem what the task
text states; write Python outside `solutions/`.

Validated by: `workspace_check` passes; the harness reruns `checks/<task>/`
and `checks/lib/` in the sandbox (observed, bounded) and they pass; at least
one data fact exists; a reading module is listed in `INDEX.md` and imported by
the data checks.

### 4.2 Literature expert

Field: external knowledge at the level of "what and why": what works for this
kind of input and metric, known pitfalls, algorithms and architectures.
Delivers at most five ranked ideas, each with the facts it relies on (entry
IDs, or "general") and at least one source.

Must not: fit, write code, prescribe parameters, state facts about the dataset
that no data entry supports. It has no shell and no write tool, so "no
fitting" is enforced by the tool allowlist. This is also what lets it run
beside a code-writing expert.

Validated by: every URL was returned by this session's `web_search` (the check
in `research/validate.ts:141-178`, kept as `agent/team/sources.ts`); every
idea cites a data entry or says "general"; at most the configured number.

### 4.3 Modelling expert

Field: the pipeline. Delivers `tasks/<task>.py` built from shared modules,
harness trials whose hypotheses name finding IDs, and `result` entries carrying
experiment IDs (the harness fills in the measurements). Local code only for a
construction check on a small sample.

First trial early: the opening message states the target "first harness trial
within 10 minutes"; the harness records `time_to_first_trial`; a modelling
invocation without a trial after 15 minutes gets one factual reminder through
its feedback channel. No hard stop.

Must not: compare models with local fits; rewrite history (git guard stays).

Validated by: the existing collection, eligibility, champion selection and
confirmation (`harness_solve_session.ts:385-398`); `workspace_check` passes.

### 4.4 Validation expert

Field: correctness of code and evidence. It runs between modelling rounds:
after a round that produced trials, and before the hand-over. Delivers checks
under `checks/<task>/` that it runs itself (output domain, ID and order
independence on development rows, a shuffled-target control on a sample,
train/test overlap, no fitting on test rows); concern entries addressed to the
expert who can fix them; a verdict through the existing `evaluation_report`
schema (`agent/evaluation/reviewer.ts`) with a readiness score.

Tools beyond the shared ones: `evaluation_detail` and `evaluation_code` on any
recorded trial (diagnostics from `prepareEvidence`, without the confirmation),
`experiment_history`, `experiment_compare`, run observed. `evaluation_code`
reads the trial's commit (`git show <commit>:<path>`), not the live tree: after
a follow-up round the tree is back on the base branch, so the live file is not
the champion's code (section 6.3).

Must not: start trials, edit pipeline code, see sealed numbers.

Validated by: a recorded `evaluation_report` whose concerns each cite an
experiment ID, a file and line, or a check; its checks pass or fail as reported
when the harness reruns them.

## 5. Collaboration: the findings journal

### 5.1 Storage and tools

`agent/team/findings.ts` keeps one append-only journal per task at
`runs/finetuned/<task>/findings/journal.jsonl` and renders the read-only view
`FINDINGS.md` next to it after every write. Writes go through tools only and
are serialised in the harness process (append under a `claimWorkspace` lock
from `agent/experiments/ownership.ts`).

```json
{ "id": "F12", "kind": "fact|idea|result|question|answer|concern|check|decision",
  "author": { "role": "data", "invocationId": "...", "runId": "..." },
  "title": "≤ 100 chars", "text": "≤ 800 chars",
  "refs": [{ "experiment": "..." }, { "file": "lib/io/x.py", "line": 12 }, { "check": "checks/t/c.py" },
           { "url": "..." }, { "profile": "training.sizes" }, { "entry": "F3" }],
  "to": "modelling", "answers": "F9", "status": "open|answered|superseded",
  "datasetSha256": "...", "authority": "verified|observed|idea" }
```

- `findings_add` appends; `question` needs `to`, `answer` needs `answers`.
- `findings_resolve({id, status, supersededBy?})`: authors supersede their own
  entries; anyone may mark a question answered by citing an answer.
- `findings_read({kinds?, since?, to?})` returns bounded pages.
- `result` entries carry an experiment ID; the harness adds metric, spread and
  cost from the trial record.
- `authority` is set by the harness (section 9).

View sections: Facts, Ideas, Results and decisions, Checks and concerns, Open
questions by addressee, Established and Earlier observations (earlier runs).

### 5.2 Questions between experts

A question to an expert that is running (at most the one code-writing expert
beside literature, or the reverse) is also delivered into its session through
the invocation feedback channel (`InvocationFeedback`,
`agent/pipeline/executor.ts:77`); the answer goes back the same way while the
asker still runs. At most eight routed messages per invocation. Questions to an
expert that is not running wait in the journal; the orchestrator sees them and
decides whether to start that expert.

### 5.3 What the orchestrator sees

`pipeline_status` gains a bounded `findings` block: counts per kind and
authority, open questions with addressee and title, and titles of entries added
since the last acknowledged cursor (at most 12). Each completed expert
invocation adds a `findings_snapshot` artifact that `artifact_inspect` pages
through. This replaces reliance on the 480-byte report excerpt
(`knowledge/lessons.ts:39`).

### 5.4 Stage report and lesson step

The lesson step stays (`agent/knowledge/lessons.ts`), with `LessonStage`
extended to the four roles. The report asks for Status, Delivered (entry IDs,
modules, experiment IDs), Open questions, Next. The journal holds this task's
facts; the knowledge store keeps lessons that transfer to other tasks. The
capture prompt says so, so a fact is not written to both.

## 6. How the orchestrator calls experts

### 6.1 Tools and state

- `stage_start.stage` becomes `data | literature | modelling | validation |
  refit | submit`, with an optional `findingIds` (at most 16) rendered into the
  opening message.
- `pipeline_wait` (P3) returns when any running invocation finishes.
- `pipeline_status` adds the `findings` block; the follow-up branch list stays.

`StageName` (`agent/pipeline/types.ts:16`) and `KNOWN_STAGES`
(`agent/pipeline/registry.ts`) change accordingly; `research`, `solve` and
`evaluate` leave the registry and `pipeline.config.json`.

The one-stage rule lives in two places today: `validate` in
`orchestrator/state.ts:88` and `Coordinator.start` (`coordinator.ts:165`). Both
call one rule in `agent/orchestrator/parallel.ts`:

- two active works only if one of them is the literature expert;
- never two of the same role; refit and submit run alone;
- an interrupted modelling work that needs training recovery blocks everything
  but a new modelling invocation (the rule at `coordinator.ts:166`).

Budget counters stay; P3 charges trials when they run.

### 6.2 Parallel calls

Allowed pairs: data with literature, modelling with literature. Validation runs
alone, between modelling rounds. Literature makes only model and web requests,
so it does not compete for the 6 cores; the model server scales (plan decision
9).

Concurrent sessions in one process need one fix. `runSession` writes its
environment into `process.env` for the session's lifetime, including the
invocation identity (`agent/run/session_runner.ts:131-146`), and `web_search`
reads its limits and log path from `process.env`
(`agent/tools/web_search.ts:26,87`). Literature running beside another session
would overwrite the other's identity. The fix passes environment to tools
through their factories and spawn hooks and removes the global mutation.

### 6.3 One tree, one writer

All experts work in `runs/finetuned/solutions`. At most one code-writing
expert (data, modelling, validation) is active at a time; literature has no
write or shell tool, so it cannot change the tree, the index or a commit while
it runs. With one writer:

- `experiment_start`'s clean-tree requirement (`training/service.ts:546`) is
  never broken by another expert's files;
- trial records keep binding the one repository path, so recovery, champion
  selection and refit compare paths as today (`training/service.ts:446`,
  `training/development_selection.ts:50`, `refit/service.ts:141`);
- there are no merges between experts.

Start and end of a code-writing invocation call `beginCodeWork` and
`endCodeWork` (P6, `agent/workspace/tree.ts`). Begin closes a follow-up round a
crash left open (`recoverFollowUp`, `training/branches.ts:67`) and commits
leftover work where it was made (`checkpoint`, `branches.ts:43`, exported).
End commits the invocation's leftover work, so the next expert finds a clean
tree. The data and validation stages call them; modelling keeps its own
sequence in `harness_solve_session.ts:319-334,378-382`, which already does both.

Follow-up branches stay as they are. A modelling round on a task with a
champion runs on `followup/<task>/<id>` from the champion commit and the
harness switches back afterwards (`branches.ts:79-115`). Literature running
beside it is unaffected: it reads files and writes only the journal. Data and
validation never run during a round, so they always start on the base branch.

Two consequences:

- Code written in a follow-up round stays on its branch, as today: the base
  branch does not get the round's shared-module changes, and later rounds
  start from the champion commit, not from data work done on the base branch
  afterwards. The modelling prompt says the base branch may hold newer shared
  code and that `git merge` is allowed. Whether the harness should merge a
  round that produced the new champion is open question 1.
- The live entrypoint after a round is the base branch's, not the champion's.
  Today `entrypointArtifact` compares the live file with the trial commit and
  reports a mismatch (`pipeline/stages/solve.ts:30-44`); this already happens
  for follow-up champions. The modelling stage reads the entrypoint from the
  commit instead, and `evaluation_code` reads trial code from its commit
  (4.4). This is needed because of follow-up branches, not for worktrees.

### 6.4 What replaces the research brief

The opening of a run is data with literature; modelling starts when the journal
has a reading module, the main facts and ideas. The brief's validator is
replaced by per-expert checks (section 4) and `workspace_check`. Deleted:
`research/validate.ts` brief checks, `research/tools.ts`, `research/budget.ts`,
`research/startup_context.ts`, `prompts/research/*`, `copyResearch`, and solve's
requirement of an upstream `research_document` (`pipeline/stages/solve.ts:120-123`).
Kept: `research/profile.ts` and the URL check. `research/context.ts` stays for
now: the orchestrator computes its task fingerprint from it
(`orchestrator/run.ts:59-61`).

## 7. What stays of the training machinery

The contract in [harness-owned-training.md](harness-owned-training.md) is
unchanged: harness-run trials are the only evidence, seeds and folds belong to
the harness, the champion tag is the only selection rule, the sealed check
runs on the frozen champion, terminal refit includes sealed rows and is
terminal. The training service is still created per modelling invocation
(`harness_solve_session.ts:280`): the modelling stage is today's solve stage
with a new prompt and no research copy. Follow-up branches stay (6.3).

Removed or simplified:

- the evaluate stage; its evidence preparation and tools serve validation;
- the 50%/20% notices and the per-solve trial reservation (P3);
- `agent/subagents/`, unused: experts are executor stages, and question
  routing (5.2) covers what it offered. P7a deletes it (section 10).

Hand-over for labelled tasks is unchanged: the orchestrator refits the
champion, P3 refits at budget end if it has not. The validation verdict is
advice.

## 8. Label-free tasks (package P7c, after wave 2)

Today a label-free run cannot promote a champion and "ends after solve"
(`prompts/orchestrator/system.md`). P7c is built after P6, P7a and P7b are
merged and spam1 and the malicious-code clustering task reach a hand-over.
P7a and P7b do not depend on it: they run label-free tasks up to trials with
label-free diagnostics, as solve does today. Example: Adversarial Example
Detection, 2,990 training images (PNG, about 2 KB), no labels, about 4%
manipulated as the task text says.

**Step 1, unscored hand-over (offline only).** The orchestrator names a
completed, valid trial and its reason; the harness writes a `declared`
champion tag recording that choice instead of a promotion score
(`training/development_selection.ts`); refit accepts it only for
`metric: none` under an offline policy; the hand-over is marked unscored. Every
label-free run then ends with files.

**Step 2, evidence labels with a held-back part.** The harness already supports
evidence selection for anomaly tasks: partial 0/1 labels for development IDs,
both classes per fold, selection by evidence average precision or ROC AUC
(`pipeline/task_configuration.ts:122-140`, `training/service.ts:622`).

1. Configuration: `anomaly_detection`, targets `none`, holdout `none`, metric
   `none`, `selection: {basis: evidence, metric: evidence_average_precision,
   direction: maximize, population: development}`.
2. The data expert proposes clear positives and clear negatives with
   `evidence_label({ids, label, reason, method})`. The validation expert
   reviews each proposed positive independently and accepts or rejects it.
   Only accepted labels count.
3. An accepted label goes to the held-back part when a seeded hash of its
   sample ID falls below one third, so the split does not depend on when labels
   were accepted. Held-back labels go to `data/sealed/evidence.json`; the rest
   form the development evidence file that `measurement.evidence` points to
   (agent-written today, `workspace.ts:163`; harness-written then). The label
   store is not mounted; `evidence_label` returns only the caller's proposals
   and counts; journal entries give counts and methods, not sample IDs.
4. Trials select by development evidence; the confirmation scores the frozen
   champion on the held-back labels for the orchestrator only.
5. Verify well means: at least the configured minimum of accepted positives
   (default 12 development, 6 held back); two experts agree on every positive;
   label-free diagnostics recorded; the flagged share on test compared with
   the rate the task text states; the verdict names the bias of hand-found
   positives (they are the clearest cases, so evidence AP overstates).
6. Refit as for labelled tasks (`refit/service.ts:101-104` already handles
   anomaly score semantics). With too few positives, step 1 applies.

The same path serves the FTP intrusion task (10,000 sessions, label-free).

### Other tasks in scope

- Document malware (PDF, DOCX, RTF; archives of 0.5 to 1.2 GB): binary
  classification as today; disk check and streaming readers matter; parsers go
  to `lib/parse/` and are reused by the code clustering task.
- Clustering of malicious code (PHP, Windows and Android binaries, up to 3 GB):
  `holdout: group`, sealed families; one task's data prepared at a time.
- Tor website fingerprinting: closed world is multi-class classification,
  which the harness does not support. Growth points: a
  `multiclass_classification` kind and `targets.kind: classes`
  (`task_configuration.ts:26,41`), per-class sealing (`sealConfirmationSet`
  takes 0/1 labels, `workspace.ts:102`), a multi-class metric and measurement
  packet, evidence diagnostics, and a `class_id` prediction domain in refit and
  submission. Open world adds an unknown class. The experts need no change.

## 9. Memory

Every journal entry records the fingerprint from `identity.json`. Today
research, solve and review use three fingerprints (the full task snapshot,
`run/research_session.ts:208`; the development archive plus manifest,
`run/harness_solve_session.ts:98-103`; the trial seed plan in evaluation), so the
knowledge store treats research notes as another dataset
(`knowledge/service.ts:113`). The design uses the development fingerprint
everywhere.

The harness sets `authority` when an entry is written and again at the start
of each run:

- `verified`: every ref is a harness record on the same fingerprint (a trial
  record, a profile record, or a check under `checks/` that passes when the
  harness reruns it on the current base branch);
- `observed`: refs that are not all harness records;
- `idea`: literature entries, with the experiments that tested them.

A later run on the same data shows verified entries as "Established" facts with
their record IDs, and the orchestrator's opening context says so instead of
"Prior work only; revalidate" (`orchestrator/run.ts:153`). The champion tag
persists, so modelling starts from the champion. A second task starts with
`INDEX.md` and `lib/`; P4 counts `lib` imports and model requests.

## 10. Wave-2 packages

P6, P7a and P7b are built in parallel. No file belongs to two packages. Where a
package needs another's function, the signature below is the contract;
the using package codes against it with an injected stub until the provider is merged.
Merge order: P6, then P7a, then P7b; an integration test runs after the third.

### Contracts between packages

| Function (file) | Provider | Used by |
| --- | --- | --- |
| `prepareTaskData(taskId: string, configuration: TaskConfiguration, options?: { seed?: number }): TaskData` (`agent/workspace/task_data.ts`) | P6 | P7b (`configure`) |
| `readTaskData(taskId: string): TaskData \| undefined` (same file) | P6 | P7a, P7b |
| `TaskData = { root; devArchive; manifestPath; profilePath; testArchive?; datasetSha256; split: { scheme; sealedRows; sha256 } }` | P6 | P7a, P7b |
| `expertSandbox(data: TaskData, role: ExpertRole, python: PythonEnvironment): SolveSandbox` (`agent/run/sandbox.ts`) | P6 | P7a |
| `beginCodeWork(root: string, label: string): TreeState` and `endCodeWork(root: string, label: string): TreeState` (`agent/workspace/tree.ts`) | P6 | P7a |
| `checkWorkspace(root: string, taskId: string): WorkspaceCheck` and `workspaceCheckTool(root: string, taskId: string, prompts: PromptSnapshot): ToolDefinition` (`agent/workspace/check.ts`) | P6 | P7a |
| `prepareModellingWorkspace(data: TaskData, configuration: TaskConfiguration): SolveWorkspace` (`agent/solve/workspace.ts`) | P6 | P7a |
| `findingsStatus(taskId: string, cursor?: number): FindingsStatus` (`agent/team/findings.ts`) | P7a | P7b (`status`) |
| artifact kind `findings_snapshot` in stage results | P7a | P7b (`inspect` allowlist, `coordinator.ts:299`) |
| setup requirement `"disk"` in the `SetupRequirement` union and `setupChecks` (`agent/pipeline/setup.ts`) | P6 | P7b (`run.ts` checks it with the chain) |
| `StageName` union and `ExpertRole = "data" \| "literature" \| "modelling" \| "validation"` (`agent/pipeline/types.ts`) | P7a, first commit | P6, P7b |
| `RunSessionOptions.env` applied only to the session's tools; `webSearchExtension(options: { maxCalls: number; maxResults: number; logPath: string }): ExtensionFactory` (`agent/run/session_runner.ts`, `agent/tools/web_search.ts`) | P7b | P7a (literature) |

### P6. One workspace and one sandbox

Owns: `agent/workspace/task_data.ts`, `tree.ts`, `check.ts` and
`agent/workspace/python/workspace_check.py` (new) with their tests;
`agent/solve/workspace.ts` (reduced to `prepareModellingWorkspace`; deletes
`copyResearch`), `agent/solve/folds.ts`, `agent/solve/solutions-README.md`,
`agent/solve/*.test.ts` (deletes `research_copy.test.ts`);
`agent/run/solve_sandbox.ts` renamed `agent/run/sandbox.ts`, its tests
(deletes `research_sandbox.test.ts`); `agent/research/profile.ts` and its test
(development input); `agent/training/branches.ts` (exports `checkpoint`) and
its test; `agent/pipeline/setup.ts` and its test (`disk`, sandbox check for all
experts).
Must not touch: orchestrator, stages, prompts, session runner, findings.
Order: task data and identity, sandbox, tree functions, check.
Tests:
- the split drawn by `prepareTaskData` for spam1 equals today's
  `prepareSolveWorkspace` split (same sealed IDs and hash);
- no role's mounts contain `data/sealed/` or the original training archive;
  literature's mount of `solutions/` is read-only;
- `beginCodeWork` closes an open follow-up marker and commits leftovers;
  `endCodeWork` leaves `uncommittedFiles` empty;
- `workspace_check` flags a missing header, an unlisted module and a duplicated
  function on fixtures, in under 2 s;
- setup refuses a configuration when free disk is below the bound.

### P7a. The four experts and the findings journal

Owns: `agent/team/findings.ts`, `agent/team/sources.ts` (new) and tests;
`agent/pipeline/stages/{data,literature,modelling,validation}.ts` (new;
`modelling.ts` replaces `solve.ts`) and tests; deletes
`agent/pipeline/stages/{research,solve,evaluate}.ts` and `solve.test.ts`;
`agent/pipeline/registry.ts`, `agent/pipeline/types.ts`;
`agent/pipeline/run_{research,solve,evaluate}.ts` and
`agent/{research,solve,evaluate}_cli.ts`, replaced by `run_expert.ts` and
`expert_cli.ts` on the same executor path; `agent/run/research_session.ts`
(deleted), `agent/run/harness_solve_session.ts` (modelling session),
`agent/run/expert_session.ts` (new, data/literature/validation);
`agent/research/{validate,tools,budget,startup_context}.ts` and tests
(deleted after moving the URL check); `agent/evaluation/{evidence,code,reviewer}.ts`
and tests; `agent/knowledge/lessons.ts` and test; `agent/prompts/registry.ts`,
`agent/prompts/{research,solve}.ts`, new `agent/prompts/experts/`,
`agent/prompts/lessons/`, deletion of `agent/prompts/{research,subagents}/`,
`agent/prompts/review/{system,start}.md`, `agent/prompts/solve/{system,start}.md`
and `agent/prompts/context/subagent-probe*.md`; deletion of `agent/subagents/`
with the subagent parts of `agent/harness/config.ts`, `harness.config.json`,
`agent/knowledge/session.test.ts`, `agent/context/session.test.ts` and
`agent/harness/config.test.ts`; `pipeline.config.json` stage entries;
stage fixtures in `agent/pipeline/{executor,run_pipeline,config}.test.ts`.
Must not touch: orchestrator, state, controller tools and prompts, session
runner, web search, sandbox and workspace internals.
Tests:
- literature's tool list has no bash, write or edit, and its URL check rejects
  an unsearched URL;
- a question to a running expert arrives through its feedback channel, and the
  answer comes back;
- result entries show the trial's measured metric, never agent text;
- validation's tools return no confirmation field; `evaluation_code` returns
  the commit's content after the live file changed;
- the modelling stage's entrypoint artifact matches a follow-up champion's
  commit after the switch back;
- a fixture `AGENTS.md` marker is absent from every expert's system prompt
  while the expert prompt is present; templates reject missing and unknown
  variables;
- data and validation stages leave a clean tree.

### P7b. Parallel calls and the orchestrator

Owns: `agent/orchestrator/{coordinator,state,tools,run,session}.ts`, new
`parallel.ts`, their tests and `README.md`;
`agent/prompts/orchestrator/{system,start,tool}.md` (content only; the IDs stay
in the registry P7a owns); `agent/run/session_runner.ts` and its test;
`agent/tools/web_search.ts`.
Must not touch: stages, sessions other than the runner, workspace, findings
internals, prompt registry, harness config.
Tests:
- data with literature and modelling with literature start; data with
  modelling, validation with anything, two of a role, and refit beside an
  expert are refused;
- persisted state with an expert and literature active validates and resumes;
- two concurrent sessions keep their own invocation IDs in telemetry and their
  own web-search limits, and `process.env` is unchanged afterwards;
- confirmation artifact IDs are refused for every expert; validation output is
  accepted as upstream for modelling;
- a re-declaration changing targets or holdout after an expert ran is refused;
- with fake experts the orchestrator makes the same number of model requests
  for 1 s and 30 s stages.

### Measured on runs after wave 2 (P4 indicators)

On spam1: one reading module in `lib/` imported by the entrypoint and the
checks, no agent Python outside `solutions/`, index complete (5); first trial
within 10 minutes of the modelling start (6); hand-over within 45 minutes and
at most 8 trials (2); confirmation ran and validation entries exist (3); a
second run shows Established entries and fewer data and literature model
requests (7). On the malicious-code clustering task: a hand-over with sealed
families confirmed, peak memory under the pool, disk check passed. Both are the
condition for starting P7c.

### P7c. Label-free hand-over (after the above)

Owns: `agent/team/evidence_labels.ts` (new), the `declared` tag in
`agent/training/development_selection.ts` and `agent/refit/service.ts`,
evidence scoring in `agent/confirmation/`, the label-free prompt fragments
([expert-team/prompts/label-free/](expert-team/prompts/label-free/)), and the
label-free paragraph of the orchestrator prompt. Step 1 first, then step 2.
Tests: a `declared` tag is refit for a label-free fixture offline and refused
online or for a labelled task; on an image fixture about a third of each class
lands in the held-back file whatever the acceptance order; a positive without
validation's acceptance is in neither file; the held-back score reaches only
the orchestrator. Run: Adversarial Example Detection ends with refit files for
2,990 test images, either evidence-selected or unscored with its reason.

## 11. Risks and open questions

1. **Does a follow-up round that produced the new champion reach the base
   branch?** Today it does not (`branches.ts` keeps the branch "for
   comparison"), so shared modules improved in the round are invisible to the
   next data expert and to other tasks. Recommended: at the end of such a round
   the harness merges the round branch into the base branch (one writer, so a
   conflict only arises from the modelling expert's own branch; abort and
   report it); rounds that changed nothing stay as branches.
2. **Validation only between rounds.** It cannot check trials while modelling
   runs, which may add a round. Recommended: accept; the orchestrator runs it
   after the first round with trials and once before the hand-over.
3. **Validation's write scope.** It may write anywhere in the tree although it
   should write only checks. Recommended: no enforcement; `workspace_check`
   warns when validation's commits touch files outside `checks/`.
4. **Findings outside git.** Recommended: keep them out of git in
   `runs/finetuned/<task>/findings/`, with the read-only view.
5. **Test archive visible to all experts.** Recommended: yes, read-only, with
   a validation check that nothing fits on test rows.

## 12. Where the current code resists the decisions

- One mutating stage is enforced twice: `orchestrator/state.ts:88` and
  `orchestrator/coordinator.ts:165`.
- Sessions share `process.env`: `run/session_runner.ts:131-146`, read back by
  `tools/web_search.ts:26,87`; literature beside another expert needs this
  removed first.
- Research reads sealed rows: `run/solve_sandbox.ts:110` mounts the whole task
  directory; the split is made only in `solve/workspace.ts:133`.
- `experiment_start` needs a clean tree (`training/service.ts:546`): the reason
  for one code-writing expert at a time.
- The training service lives for one solve session
  (`run/harness_solve_session.ts:280,378`), so only modelling runs trials.
- Follow-up rounds switch the one tree to another branch and back
  (`training/branches.ts:79-115`); during a round the base branch is not checked
  out, so no other code-writing expert may run, and the round's code does not
  reach the base branch (open question 1).
- The selected entrypoint is read from the live file and compared with its
  commit (`pipeline/stages/solve.ts:30-44`); for a follow-up champion the live
  file is the base branch's after the switch back. The review's code reader
  reads live files too (`evaluation/code.ts:21`).
- Three dataset fingerprints for one task (`run/research_session.ts:208`,
  `run/harness_solve_session.ts:98-103`, evaluation's seed plan) keep knowledge
  from passing between stages.
- The reviewer is bound to the sealed confirmation
  (`evaluation/evidence.ts:58-67`), and the coordinator treats all evaluate
  output as sealed (`orchestrator/coordinator.ts:130-133`).
- Controller detail is limited to a fixed list of artifact kinds
  (`orchestrator/coordinator.ts:299`); `findings_snapshot` must be added.
- The orchestrator's task fingerprint comes from the research context
  (`orchestrator/run.ts:59-61`), not from the development data identity.
- Label-free runs stop at solve by policy (orchestrator prompt) although
  evidence selection exists; the evidence file is agent-written
  (`solve/workspace.ts:163`).
- Multi-class targets are absent from the configuration
  (`pipeline/task_configuration.ts:26,41`) and from sealing
  (`solve/workspace.ts:102`).
