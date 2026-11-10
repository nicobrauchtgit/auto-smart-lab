# Expert team: workspace, sandbox and experts

Status: design for package P5 of [the redesign plan](../../../docs/redesign-plan.md),
2026-11-10. Documents only. The decisions in the plan are fixed; this file says
how to realise them with the smallest change to the existing machinery. Paths
are relative to `harness/finetuned/` unless they start with `runs/`. Draft
prompts are in [expert-team/prompts/](expert-team/prompts/); they are not
registered and move to `agent/prompts/experts/` in wave 2.

P1 (observed scripts, one memory pool), P3 (run mechanics) and P4 (scorecard)
are assumed to exist as the plan describes them. "Run observed" below means the
P1 shell: short commands return directly, long ones return an ID and wake the
agent by rule.

## 1. At a glance

| Today | Design | Reused | Deleted |
| --- | --- | --- | --- |
| research, solve, evaluate stages | data, literature, modelling, validation stages | `StageDefinition`, executor, registry, session runner, lesson step | `research_session.ts`, research brief, `evaluate` stage shell |
| research folder, solve scratch folder, `solutions/` | one `solutions/` repository; one git worktree per expert role | `ensureSolutionsRepository`, branch checkpoint code from `branches.ts` | `runs/<task>/research/analysis/`, `copyResearch` |
| research sandbox (full task data), solve sandbox (dev data) | one sandbox policy, dev data only, per-role write mount | `sandboxPolicy`, `isolatedSolveTools`, `trainingSandboxCommand` | `prepareResearchSandbox` |
| sealed split made by solve | sealed split made at `task_configure`, before any expert | `seal()`, `writeDevelopmentZip`, seed plan | sealing inside `prepareSolveWorkspace` |
| `research.md` + brief validator | per-task findings journal with typed entries | URL check of `research/validate.ts` (`webSources`, `resolveSource`) | brief sections, number checks, `check_brief`, research budget |
| one mutating stage | two experts at once, at most one heavy | coordinator, state store, `pipeline_wait` | `followup/` branch switching |
| reviewer reads the sealed confirmation | sealed numbers go to the orchestrator only | confirmation service, receipt, reuse ledger | confirmation input to `evaluation/evidence.ts` |

## 2. The workspace

### 2.1 Layout

`runs/finetuned/solutions/` stays the one versioned repository (created by
`ensureSolutionsRepository`, `agent/training/git.ts:90`). Its layout:

```text
solutions/
  README.md            rules of the workspace (harness-owned, copied from agent/solve/solutions-README.md)
  INDEX.md             one line per module: path, purpose, owner role, tasks that import it
  lib/                 shared across tasks; imported as solutions.lib.<area>.<module>
    io/                reading sample descriptors: archives, members, captures, images
    parse/             format parsers (text, documents, binaries, sessions, images)
    features/          representations: transformers with fit/transform
    models/            reusable estimators and wrappers
    cv/                splitter factories
  checks/              short checks; each file has a header line "Checks: ..."
    lib/               checks of shared modules (run against a small fixture or a sample)
    <task>/            task checks (data facts, leakage controls, output domain)
  tasks/
    <task>.py          harness entrypoint (unchanged contract: build_pipeline, optional CV factory)
    <task>/            task-specific modules that are not (yet) worth sharing
  docs/                notes about formats and modules, one file per topic
```

What is per task: `tasks/<task>.py`, `tasks/<task>/`, `checks/<task>/`. What is
shared: `lib/`, `checks/lib/`, `docs/`. A module moves from `tasks/<task>/` to
`lib/` when a second task imports it; the mover updates `INDEX.md`. Imports of
the form `solutions.lib...` already work in harness trials: the worker puts the
directory holding the trial's `solutions/` on `sys.path` and `PYTHONPATH`
(`agent/training/python/smartlab_trial/agent_code.py:83`).

The findings journal is the one shared record that is not in git (section 5):
two experts write it at the same time and the harness owns its structure, so
merges must never touch it.

`README.md` loses the sentence that the spam task IDs encode labels
(`agent/solve/solutions-README.md`); that fact belongs to the task description,
not to a file every task reads.

### 2.2 Rules and their cheap checks

Rules (stated in the shared workspace prompt):

1. One module per concern. A file does one thing: read one format, build one
   representation, define one estimator, run one check.
2. Every Python file starts with a docstring whose first line says what it does
   and whose second line names its inputs and outputs.
3. `INDEX.md` lists every module under `lib/` and `tasks/<task>/` with its
   purpose. Adding or moving a module updates it in the same commit.
4. Search before writing: read `INDEX.md`, then `rg` for the concern. Extend an
   existing module (new function, new parameter) instead of copying it.
5. Agent Python lives only in the expert's worktree of `solutions/`. Scratch
   output goes to the worktree's ignored `scratch/`, which is not committed.

`agent/workspace/check.ts` (new, P6) runs after every expert invocation and on
demand through a `workspace_check` tool. It is a bounded static pass, no
imports of agent code:

| Check | How | Result |
| --- | --- | --- |
| headers | first statement of each `.py` is a docstring of at least one line | error per file |
| index | every `lib/**/*.py` and `tasks/<task>/**/*.py` appears in `INDEX.md`, and every listed path exists | error per path |
| duplicates | normalised function bodies (whitespace, names stripped) hashed; same hash in two files | warning with both paths |
| reuse | for each task entrypoint, the set of `solutions.lib` imports | measurement for P4 indicator 5 |
| loader count | modules that open the task archives (`zipfile`, `open(` on manifest inputs) | measurement; more than one per format is a warning |
| stray code | `*.py` written by agents outside `solutions/` (scan of the run folders the sandbox could write) | error |
| size | file over 400 lines | warning |

Errors fail the invocation's validation with the list as factual feedback;
warnings go into the stage summary. The check is cheap (one `rg`/AST pass in
the project Python, bounded to 2 s) and needs no model.

### 2.3 Research's and solve's folders

`runs/finetuned/<task>/research/` (with `analysis/`, `profile/`, `research.md`)
and `runs/finetuned/<task>/solve/agent/` stop being written. The harness data
profile moves to `runs/finetuned/<task>/data/profile.json` (built by
`agent/research/profile.ts` on the development archive, not the full task
data). The solve folder keeps only harness state: `data/` becomes
`runs/finetuned/<task>/data/` (section 3) and `training/` stays where trial
records are. Old run folders are left untouched as history; P4 reads them.

## 3. The one sandbox and its data

### 3.1 The sealed split exists before the first expert

Today the split is drawn inside `prepareSolveWorkspace`
(`agent/solve/workspace.ts:121-158`), and research mounts the whole task
directory (`agent/run/solve_sandbox.ts:110`), so research reads sealed rows.

The draw is already deterministic: the seed plan depends on the root seed, the
task and the training data hash, with a fixed experiment ID
(`workspace.ts:129-133`). So it can move without changing which rows are
sealed. In the design, `agent/workspace/task_data.ts` (P6) runs
`prepareTaskData(taskId, configuration)` inside `Coordinator.configure`
(`agent/orchestrator/coordinator.ts:145`), right after the task files are
inspected, and writes `runs/finetuned/<task>/data/`:

- `sealed_ids.txt`, `holdout.json` (harness only, never mounted);
- the development archive (sealed members removed, as today);
- `development-samples.json` (descriptors and development targets);
- `profile.json` (harness data profile of the development data);
- `identity.json`: the one dataset fingerprint (development archive plus
  manifest), used by trials, knowledge and findings alike.

A re-declaration that changes `targets` or `holdout` after any expert has run
is refused: dev rows already seen could become sealed. The same split is drawn
by every run on the same task and data, so findings from an earlier run never
rest on rows that are sealed in this one.

### 3.2 Per task kind

| Kind / input | Sealed rows | What experts see | Development targets |
| --- | --- | --- | --- |
| binary classification (text, documents, binaries) | stratified by class, class-based sizing | development archive, test archive | labels in the manifest |
| clustering with families (code, binaries) | whole families (`sealGroups`) | development archive without sealed families, test archive | family IDs in the manifest; used for scoring, never passed to `fit` |
| anomaly detection, no labels (images, sessions, captures) | none (`holdout: none`) | all training samples, test samples | none; evidence labels the experts create (section 7.4) |
| anomaly from a capture (`pcap_tcp_connections`) | none; the whole capture is the development input (`workspace.ts:151`) | capture, connection descriptors | none |

A label-free task has no sealed rows, so the "no agent sees sealed rows" rule is
met trivially; its independent check is the sealed evidence part (section 7.4).

### 3.3 One policy

`agent/run/sandbox.ts` (renamed from `solve_sandbox.ts`) keeps `sandboxPolicy`,
`isolatedSolveTools` and `trainingSandboxCommand` and replaces the two prepare
functions by one `expertSandbox(task, role)`:

- read-only: `runs/finetuned/<task>/data/` except the sealed files, the test
  archive, the task text, the integration checkout of `solutions/`, the
  findings view, the Python prefix, binaries;
- writable: the role's worktree (section 6.3) and the repository's git common
  directory (objects, refs; needed for commits);
- literature gets no shell and no write tool (section 4), so its mounts only
  matter for the read tool.

The sealed files live in `data/sealed/`, a directory no policy mounts. The
setup check `solve-isolation` (bubblewrap) stays and now covers every expert.

### 3.4 Test archive visibility

The unlabelled test archive is visible read-only to every expert, as it is to
solve today (`workspace.ts:174`). Reasons: it carries no labels; the data
expert must compare training and test inputs (shift, formats, duplicates);
batch tasks fit on the test batch itself; refit reads it anyway. The risks are
pseudo-labelling and fitting representations on test rows; they are ruled out
by the prompts, by harness trials (only refit with `fit_predict_test_batch`
reads test rows) and by a validation check. Test IDs are neutral.

### 3.5 Who sees sealed numbers

The confirmation still runs at the end of a modelling invocation that leaves a
champion (`agent/run/harness_solve_session.ts:388`) and produces the
`holdout_confirmation` artifact. Only the orchestrator receives it. Changes:

- `evaluation/evidence.ts:58-67` stops requiring and passing the confirmation;
  the validation expert never sees it;
- `Coordinator.sealedExposure` (`coordinator.ts:130`) applies to every expert,
  and no longer treats validation output as sealed;
- guidance and feedback text is rejected when it contains a sealed metric
  rendered at two to four decimals (cheap string check, done in `start` and
  `feedback`);
- `lessons.sealed` stays for the orchestrator's own notes only; experts never
  receive sealed numbers, so they need no instruction about them.

### 3.6 Disk and memory

The machine has about 9 GB free disk, 15 GB RAM and 6 cores. The development
archive is a member copy (`zip --copy`, no inflation), so a 3 GB archive costs
up to 3 GB more. `prepareTaskData` keeps the prepared data of one task at a
time, deletes other tasks' development copies (they are rebuilt
deterministically) and the new setup check `disk` requires free space of
1.2 times the training archive plus 1 GB before `task_configure` is accepted.
Trial worktrees hold only source. Experts are told the pool size and to
stream archives (P1's machine prompt).

## 4. The four experts

Each expert is a registered stage running one session through `runSession`
with its own prompt, tool allowlist and lesson step. Shared by all: read, grep,
find, ls; `findings_read`, `findings_add`, `findings_resolve`;
`workspace_check`; knowledge search/read/capture; `python_environment`
inspect. "Heavy" decides parallel calls (section 6.2).

| | data | literature | modelling | validation |
| --- | --- | --- | --- | --- |
| Field | what is in the dataset | what to try and why | the pipeline | whether code and evidence hold |
| Delivers | loader and parsers in `lib/`, data facts, data checks | ranked ideas with sources | entrypoint, harness trials, champion | checks, concerns, a verdict |
| Writes code | yes | no | yes | checks only |
| Shell | run observed | none | run observed | run observed |
| Trials | no | no | `experiment_*` tools | read-only history and compare |
| Web search | no | yes | no | no |
| Heavy | yes | no | yes | no |
| Lesson step | yes | yes | yes | yes |

### 4.1 Data expert

Field: inputs, formats, sizes, targets, duplicates, train/test differences,
what the task text states about the data. Delivers the shared reading code for
the task's input format (extending `lib/io` and `lib/parse` when they exist),
facts in the findings journal, each tied to a check file, a profile record or
a script output, and the checks under `checks/<task>/` that prove them. For a
label-free task it also proposes evidence labels (section 7.4).

Must not: fit estimators to compare models; report as a problem what the task
text states (a fact the task description gives is context, not a finding of
leakage); write outside its worktree.

Validated by: `workspace_check` passes; the harness reruns `checks/<task>/` and
`checks/lib/` in the sandbox (observed, bounded) and they pass; at least one
data fact entry exists; a loader module is listed in `INDEX.md` and imported by
the data checks.

### 4.2 Literature expert

Field: external knowledge. What works for this kind of input and metric,
known pitfalls, algorithms and architectures, at the level of "what and why".
Delivers at most five ranked idea entries. Each states the idea, why it fits
facts already in the journal (cites their entry IDs) and at least one source.

Must not: fit models, write code, prescribe parameters or step-by-step
implementations, state facts about this dataset that no data entry supports.
It has no shell and no write tool, so the "no fitting" rule is enforced by the
tool allowlist, not by instruction.

Validated by: every URL was returned by this session's `web_search` (the
existing check in `research/validate.ts:141-178`, kept as
`agent/team/sources.ts`); every idea cites at least one data entry or says
"general"; no more than the configured number of ideas; its worktree is
untouched.

### 4.3 Modelling expert

Field: building the pipeline and testing ideas. Delivers
`tasks/<task>.py` built from shared modules, harness trials with hypotheses
that name finding IDs, and result entries that the harness fills with measured
numbers from trial records (agents name the experiment ID; they do not type
scores). Local code only for a construction check on a small sample, as the
current solve prompt asks.

First trial early: the opening message states the target "first harness trial
within 10 minutes" and the harness records `time_to_first_trial`; a modelling
invocation that has run no trial after 15 minutes receives one factual
reminder through its feedback channel. No hard stop.

Must not: compare models with local fits; read sealed files (not mounted);
rewrite history (git guard stays).

Validated by: the existing collection, eligibility, champion selection and
confirmation (`harness_solve_session.ts:385-398`); `workspace_check` passes.

### 4.4 Validation expert

Field: correctness of code and evidence. It can be called after the first
trial, in parallel with modelling, and again before the hand-over. Delivers
concern and check entries; checks under `checks/<task>/` it can run itself
(output domain, id/order independence on development rows, a shuffled-target
control on a sample, train/test overlap, for label-free tasks the evidence
review); and a structured verdict through the existing `evaluation_report`
schema (`agent/evaluation/reviewer.ts`) with its readiness score.

Tools beyond the shared ones: `evaluation_detail` and `evaluation_code` on any
recorded trial (diagnostics from `prepareEvidence`, without the confirmation),
`experiment_history`, `experiment_compare`, run observed.

Must not: start trials, edit pipeline code (it writes checks and concerns;
fixes are the modelling expert's), see sealed numbers.

Validated by: a recorded `evaluation_report` whose concerns each cite an
experiment ID, a file and line, or a check; its checks pass or fail as it
reported when the harness reruns them.

## 5. Collaboration: the findings journal

### 5.1 Storage and tools

`agent/team/findings.ts` (P7a) keeps one append-only journal per task at
`runs/finetuned/<task>/findings/journal.jsonl` and renders a read-only view
`FINDINGS.md` next to it after every write. Writes go through tools only and
are serialised by the harness process (one writer, `atomicJson`/append under a
`claimWorkspace` lock from `agent/experiments/ownership.ts`).

An entry:

```json
{ "id": "F12", "kind": "fact|idea|result|question|answer|concern|check|decision",
  "author": { "role": "data", "invocationId": "...", "runId": "..." },
  "title": "≤ 100 chars", "text": "≤ 800 chars",
  "refs": [{ "experiment": "..." }, { "file": "lib/io/x.py", "line": 12 }, { "check": "checks/t/c.py" },
           { "url": "..." }, { "profile": "training.sizes" }, { "entry": "F3" }],
  "to": "modelling", "answers": "F9", "status": "open|answered|superseded",
  "datasetSha256": "...", "authority": "verified|observed|idea" }
```

- `findings_add` appends. `question` needs `to`; `answer` needs `answers`.
- `findings_resolve({id, status, supersededBy?})`: authors supersede their own
  entries; anyone may mark a question answered by citing an answer.
- `findings_read({kinds?, since?, to?})` returns bounded pages.
- `result` entries carry only an experiment ID; the harness adds the measured
  metric, spread and cost from the trial record when it renders the view.
- `authority` is set by the harness, never by the agent (section 8).

View sections: Facts (data), Ideas (literature), Results and decisions
(modelling), Checks and concerns (validation), Open questions (by addressee),
Earlier runs (section 8).

### 5.2 Questions between experts

A question addressed to an expert that is running is also delivered into its
session through the existing invocation feedback channel
(`InvocationFeedback`, `agent/pipeline/executor.ts:77`), with the author and
entry ID; the answer goes back the same way if the asker still runs. At most
eight routed messages per invocation. A question to an expert that is not
running waits in the journal; the orchestrator sees it in the stage summary and
decides whether to start that expert. Experts never message the orchestrator
except through their stage report.

### 5.3 What the orchestrator sees

`pipeline_status` gains a bounded `findings` block: counts per kind and
authority, open questions with addressee and title, and the titles of entries
added since the last acknowledged cursor (at most 12). Each completed expert
invocation adds a `findings_snapshot` artifact (the rendered view at that
moment) that `artifact_inspect` pages through like a stage report. This
replaces reliance on the 480-byte report excerpt (`lessons.ts:39`).

### 5.4 Stage report and lesson step

The lesson step stays as it is (`agent/knowledge/lessons.ts`), with
`LessonStage` extended to the four roles. The report prompt asks for: Status,
Delivered (entry IDs, modules, experiment IDs), Open questions, Next. The
journal holds task facts for this run and later runs; the knowledge store keeps
lessons that transfer to other tasks (a parser pitfall, a tool error and its
fix). The capture prompt says so, so the same fact is not written to both.

## 6. How the orchestrator calls experts

### 6.1 Tools and state

The controller tools stay; their arguments change little:

- `stage_start.stage` becomes `data | literature | modelling | validation |
  refit | submit`. A new optional `findingIds` (≤ 16) points the expert at
  entries, typically open questions; they are rendered into the opening message.
- `pipeline_wait` (P3: blocks until stage input) returns when any running
  invocation finishes.
- `pipeline_status` adds `findings` (5.3) and lists the role worktrees with
  their branch head and merge state instead of follow-up branches.

`StageName` in `agent/pipeline/types.ts:16` and `KNOWN_STAGES` in
`agent/pipeline/registry.ts` change accordingly; `research`, `solve` and
`evaluate` are removed from the registry and `pipeline.config.json`.

State (`agent/orchestrator/state.ts`): `validate` today rejects more than one
active work (`state.ts:88`) and `Coordinator.start` refuses a second stage
(`coordinator.ts:165`). Both become one rule in `agent/orchestrator/parallel.ts`:

- at most two active expert works; never two of the same role;
- at most one heavy (data, modelling); refit and submit run alone;
- an interrupted modelling work that needs training recovery blocks everything
  but a new modelling invocation (the existing rule at `coordinator.ts:166`).

Budget counters stay. P3's charge-on-run trial accounting applies.

### 6.2 Parallel calls

Useful pairs: data with literature at the start; modelling with literature
(new ideas while trials run); modelling with validation (checks on finished
trials). The P1 pool gives trials CPU priority over agent scripts, so a light
expert's checks cannot starve a trial; the rule above keeps two heavy experts
from competing for 6 cores. The model server scales (plan decision 9), so two
sessions cost little extra in latency.

Concurrent sessions in one process require one fix: `runSession` writes its
environment into `process.env` for the session's lifetime
(`agent/run/session_runner.ts:131-146`), including the invocation identity, and
`web_search` reads its limits and log path from `process.env`
(`agent/tools/web_search.ts:26,87`). Two sessions would overwrite each other.
Wave 2 passes environment to tools through their factories and spawn hooks and
removes the global mutation; a regression test runs two sessions with
different identities concurrently.

### 6.3 Two agents in one repository

Mechanism: one git worktree per expert role per task, at a stable path,
merged by the harness.

- `runs/finetuned/work/<task>/<role>/solutions` on branch `team/<task>/<role>`.
  The integration checkout `runs/finetuned/solutions` (branch `main`) is
  written only by the harness.
- Invocation start: the harness commits leftovers in the role worktree (the
  checkpoint code of `agent/training/branches.ts:43-57`), then merges `main`
  into the role branch. A conflict is left in the worktree and the opening
  message says to resolve and commit it first.
- Invocation end: checkpoint commit, then `git merge --no-ff team/<task>/<role>`
  in the integration checkout under a lock in the git common directory. On a
  conflict the harness aborts the merge, keeps the branch, and records
  `merge_conflict` with the files in the stage result; the next invocation of
  that role resolves it.

Why this and not one shared tree: `experiment_start` requires a clean tree
(`agent/training/service.ts:546`), so one expert's uncommitted file would block
the other's trial, and two agents staging in one index corrupt each other's
commits. Why a stable path per role and not one per invocation: trial records
bind the repository path, and recovery, champion selection and refit compare
it (`training/service.ts:446`, `training/development_selection.ts:50`,
`refit/service.ts:141`). Those three comparisons change to compare the git
common directory (`git rev-parse --git-common-dir`), so refit can run from the
integration checkout on a champion measured in the modelling worktree. The
champion tag and the terminal markers already live in the common directory
(`training/terminal.ts:14-17`), so they are shared by all worktrees.

### 6.4 What replaces the research brief

Nothing of the same shape. The opening of the run is data with literature; the
orchestrator moves to modelling when the journal has a loader, data facts and
ideas. The brief's validator is replaced by per-expert artifact checks
(section 4) and `workspace_check`. Deleted: `research/validate.ts` brief
checks, `research/tools.ts` (`check_brief`), `research/budget.ts`,
`research/startup_context.ts`, `prompts/research/*`, `copyResearch`, the solve
stage's requirement of an upstream `research_document`
(`pipeline/stages/solve.ts:120-123`). Kept: `research/profile.ts` (harness data
profile) and the URL check.

## 7. What stays of the training machinery

### 7.1 Kept as is

The contract in [harness-owned-training.md](harness-owned-training.md) stands
unchanged: harness-run trials are the only evidence, seeds and folds are the
harness's, the champion tag is the only selection rule, the sealed check runs
on the frozen champion, terminal refit includes sealed rows and is terminal.
The training service is still created per modelling invocation
(`harness_solve_session.ts:280`); the modelling stage is today's solve stage
with a new prompt, the role worktree as `solutionsRoot`, and no research copy.

### 7.2 Simplified or removed

- Follow-up branches (`training/branches.ts`): removed as a separate mechanism.
  Every modelling invocation already works on its role branch from `main`,
  which contains the champion; the champion tag decides. The checkpoint and
  crash-marker code moves into `agent/workspace/repository.ts`.
- The evaluate stage: removed; its evidence preparation and tools serve the
  validation expert.
- The orchestrator's 50%/20% notices and per-solve trial reservation: removed
  by P3.
- `agent/subagents/`: not used. Experts are executor stages, not children of
  one session; routing of questions (5.2) covers what the module offered. It is
  deleted with its prompts after the imports in `prompts/registry.ts` and three
  tests are removed.

### 7.3 Hand-over

Unchanged for labelled tasks: the orchestrator refits the champion; P3 refits
at budget end if it has not. The validation verdict is advice.

### 7.4 Label-free tasks to a hand-over

Today a label-free run cannot promote a champion and "ends after solve"
(`prompts/orchestrator/system.md`). The harness already supports explicit
evidence selection for anomaly tasks: partial 0/1 labels for development IDs,
both classes per fold, selection by evidence average precision or ROC AUC
(`pipeline/task_configuration.ts:122-140`, `training/service.ts:622`). The
design uses that path end to end. Example: Adversarial Example Detection
(2,990 training images, no labels, about 4% manipulated as the task text says).

1. Configuration: `anomaly_detection`, targets `none`, holdout `none`, metric
   `none`, `selection: {basis: evidence, metric: evidence_average_precision,
   direction: maximize, population: development}`.
2. Evidence labels: the data expert inspects the training inputs and proposes
   clear positives and clear negatives with `evidence_label({ids, label,
   reason, method})`; each label carries its method (visual inspection, a
   statistic, a check file). The validation expert reviews every proposed
   positive independently and accepts or rejects it. Only accepted labels count.
3. Sealed evidence: when the orchestrator starts the first modelling
   invocation, the harness draws a seeded third of the accepted labels per
   class into `data/sealed/evidence.json` and writes the rest as development
   evidence (the path `measurement.evidence` points to, `workspace.ts:163`).
   Modelling sees only development evidence and its counts.
4. Trials select by development evidence. The sealed check scores the frozen
   champion on the sealed evidence for the orchestrator only.
5. Verify well means: at least the configured minimum of accepted positives
   (default 12 development, 6 sealed), agreement of two experts on every
   positive, label-free diagnostics (score health, stability) recorded, the
   flagged share on test compared with the rate the task text states, and the
   validation verdict naming the bias of hand-found positives (they are the
   easy ones; evidence AP overstates performance).
6. Refit and hand-over as for labelled tasks (`refit/service.ts:101-104`
   already handles anomaly score semantics).

If too few positives can be established, the orchestrator may hand over an
"unscored" candidate: a validated, completed trial chosen by the orchestrator
with its reason, refit offline only and marked unscored in the hand-over
(open question 2).

### 7.5 Other tasks in scope

- Document malware (PDF, DOCX, RTF; archives of 0.5 to 1.2 GB): binary
  classification as today; the disk check and streaming readers matter; the
  data expert's parsers go to `lib/parse/` and are reused by the clustering
  task on code.
- Clustering of malicious code (PHP, Windows and Android binaries, up to 3 GB):
  `holdout: group`, sealed families; one task's data prepared at a time.
- FTP intrusion (10,000 sessions, label-free): same path as 7.4 with evidence
  labels on sessions.
- Tor website fingerprinting: closed world is multi-class classification, which
  the harness does not support. Growth points: a `multiclass_classification`
  kind and `targets.kind: classes` (`task_configuration.ts:26,41`), a
  per-class stratified seal (`sealConfirmationSet` takes 0/1 labels,
  `workspace.ts:102`), a multi-class metric and measurement packet, the
  evidence diagnostics, and a `class_id` prediction domain in refit and
  submission. Open world adds an unknown class (classification plus
  rejection). The expert design needs no change for either.

## 8. Memory

Each journal entry records the dataset fingerprint of `identity.json`. Today
research, solve and review use three different fingerprints (the full task
snapshot in `research_session.ts:208`, the development archive plus manifest in
`harness_solve_session.ts:98-103`, the trial seed plan in evaluation), so the
knowledge store treats research notes as another dataset
(`knowledge/service.ts:113`). The design uses the development fingerprint
everywhere.

`authority` is computed by the harness when an entry is written and again at
the start of each run:

- `verified`: every ref is a harness record on the same fingerprint (a trial
  record, a profile record, or a check under `checks/` that passes when the
  harness reruns it at the current `main`);
- `observed`: an agent's statement with refs that are not all harness records;
- `idea`: literature entries, with the experiments that tested them.

A later run on the same data shows verified entries under "Established" as
facts, with their record IDs, and the orchestrator's opening context says so
instead of "Prior work only; revalidate" (`orchestrator/run.ts:153`). Observed
entries are shown as earlier observations, ideas with their outcomes. The
champion tag and the role branches persist, so modelling starts from the
champion. A second task (spam2 after spam1, or the clustering task after the
document task) starts with `INDEX.md` and `lib/`: the data expert's first step
is to search the index for a reader of the format, and P4 counts `lib` imports
and model requests.

## 9. Wave-2 packages

Shared contract fixed before the packages start (this section): `StageName`
values, `expertSandbox(task, role)`, `roleWorktree(task, role)` and
`integrate(task, role)` signatures, the findings entry schema of 5.1.

### P6. One workspace and one sandbox

Owns: `agent/workspace/` (new: `task_data.ts`, `repository.ts`, `check.ts`),
`agent/solve/workspace.ts` (reduced to the modelling workspace),
`agent/solve/solutions-README.md`, `agent/run/solve_sandbox.ts` → `sandbox.ts`,
`agent/research/profile.ts` (dev input), `agent/training/branches.ts`
(removed), the path comparisons in `training/service.ts`,
`training/development_selection.ts`, `refit/service.ts`, `pipeline/setup.ts`
(`disk` requirement), the sealed evidence split.
Must not touch: orchestrator, stage definitions, prompts, findings.
Order: task data and identity first, then sandbox, then worktrees and merge,
then the check.
Tests: the split drawn at configure equals the split today's
`prepareSolveWorkspace` draws for spam1 (same sealed IDs and hash); no expert
policy mounts `data/sealed/` or the full training archive; two worktrees commit
concurrently and both merge into `main`; a conflicting merge is aborted and
reported; a trial measured in the modelling worktree is refit from the
integration checkout; `workspace_check` flags a missing header, an unlisted
module and a duplicated function on fixtures in under 2 s; setup refuses a task
when free disk is below the bound; on a label-free image fixture the evidence
split puts a third of each class into the sealed file.

### P7a. The four experts and the findings journal

Owns: `agent/team/` (`findings.ts`, `sources.ts`, `evidence_labels.ts`),
`agent/pipeline/stages/{data,literature,modelling,validation}.ts`,
`agent/pipeline/registry.ts`, `agent/pipeline/types.ts` (`StageName`),
`agent/prompts/experts/` (from the drafts), `agent/prompts/lessons/report.md`,
`agent/knowledge/lessons.ts`, `agent/evaluation/evidence.ts` (no
confirmation), deletion of the research stage, session, brief, budget and
prompts and of the evaluate stage.
Must not touch: coordinator, state, controller tools, sandbox internals.
Depends on: P6's sandbox and worktree functions (stubs until merged).
Tests: literature has no bash, write or edit tool and its URL check rejects an
unsearched URL; a question to a running expert arrives through its feedback
channel and the answer comes back; result entries show the trial's measured
metric, not agent text; the validation expert's tools never return
confirmation fields; a fixture `AGENTS.md` marker does not enter any expert's
system prompt while the expert prompt does; prompt templates reject missing and
unknown variables.

### P7b. Parallel calls and the orchestrator

Owns: `agent/orchestrator/` (`coordinator.ts`, `state.ts`, `tools.ts`,
`parallel.ts`, `run.ts`), `agent/prompts/orchestrator/`,
`agent/run/session_runner.ts` (no `process.env` mutation),
`agent/tools/web_search.ts` (limits from its factory), deletion of
`agent/subagents/`.
Must not touch: stages, workspace, findings internals (reads the status block
through an interface P7a provides).
Tests: data and literature run at once, data and modelling are refused, two of
a role are refused, refit refuses to start beside an expert; persisted state
with two active works validates and resumes; two concurrent sessions keep
their own invocation IDs in telemetry and their own web-search limits;
guidance containing a sealed metric value is rejected; with fake experts the
orchestrator makes the same number of model requests for 1 s and 30 s stages.

### Measured on spam1 after wave 2 (P4 indicators)

Indicator 5: one loader module in `lib/`, imported by the entrypoint and the
checks; no agent Python outside `solutions/`; index complete. Indicator 6:
first trial within 10 minutes of the modelling start. Indicator 2: hand-over
within 45 minutes, at most 8 trials. Indicator 3: confirmation ran; validation
entries recorded. Indicator 7: a second spam1 run shows "Established" entries
and fewer model requests in data and literature.

Non-spam check: an Adversarial Example Detection run (between waves, from the
main checkout) reaches either an evidence-selected champion with refit files
for 2,990 test images, or an unscored hand-over with its reason; it records
accepted evidence counts, the sealed evidence score for the orchestrator, and
peak memory under the pool.

## 10. Risks and open questions

1. **Worktree per role or one tree with a lock?** A lock is simpler but
   serialises all writing and still breaks the clean-tree rule for trials.
   Recommended: worktree per role (6.3).
2. **Label-free task with too little evidence.** Recommended: allow an
   offline "unscored" hand-over chosen by the orchestrator with a reason, so
   every run ends with files; never online.
3. **May validation start trials?** Controls such as a shuffled-target fit are
   cheaper locally on a sample. Recommended: no trials; it runs short checks
   and asks modelling for a harness control when it needs one.
4. **Findings outside git.** They are not versioned with code, but survive in
   `runs/finetuned/<task>/findings/` across runs. Recommended: keep them out of
   git; the view is mounted read-only.
5. **Test archive visible to all experts.** Recommended: yes, read-only (3.4);
   validation checks that no trial reads test rows outside batch refit.
