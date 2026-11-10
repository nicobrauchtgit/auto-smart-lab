# Expert team: workspace, sandbox and experts

Design for P5 of [the fixed redesign plan](../../../docs/redesign-plan.md),
revised 2026-11-10. Documents only. Paths are relative to
`harness/finetuned/` unless prefixed by `runs/`, `experiment/` or “root”.
[Draft prompts](expert-team/prompts/) are not registered runtime prompts.
P1 (observed processes and one memory pool), P3 (run mechanics) and P4
(scorecard) remain prerequisites. This design does not change their decisions.

## 1. Workspace and execution

Four executor stages replace research, solve and evaluate: **data** establishes
inputs and writes reusable readers; **literature** supplies sourced ideas at
the level of what and why; **modelling** builds pipelines and runs harness
trials; **validation** checks trial code and evidence. Every session uses
explicit module prompts, typed inputs, prompt snapshots, shared telemetry and
`noContextFiles: true`. Standalone expert CLIs use the same executor and
whole-chain setup checks. A completed session is not stage success: artifact
validation decides. Harness-run trials remain the only model-selection evidence.

All experts share one working tree, `runs/finetuned/solutions/`:

```text
README.md             harness-owned workspace rules
INDEX.md              module path, purpose, owner role, importing tasks
lib/{io,parse,features,models,cv}/
tasks/<task>.py       build_pipeline and optional CV factory
tasks/<task>/         task-specific modules
checks/{lib,<task>}/  short executable checks
docs/                 format and module notes
scratch/              ignored large files and temporary output
```

Search `INDEX.md` and `rg` first; extend existing modules. One concern per
module; every Python file starts with a two-line purpose/input-output
docstring. Update the index with code. Move task code into `lib/` when a
second task imports it. Python stays inside `solutions/`; large and temporary
files go in ignored `scratch/`. Remove the spam-specific filename-label rule
from the shared README; task text supplies such facts.

Only data+literature and modelling+literature may overlap. Validation runs
alone, between modelling rounds and once before hand-over when budget allows.
Never two of a role; refit and submit run alone. Training recovery blocks all
roles except modelling recovery. One shared parallel rule validates both
persisted state and new starts. Literature has read-only file tools, web search
and findings/knowledge tools, no shell/write/edit and no fitting.

`beginCodeWork` closes any interrupted follow-up before starting a code writer;
a failure fails the stage with its reason, without starting that expert.
Checkpoint leftovers on their original branch. Move oversized untracked files
(above the existing 1 MB threshold) to collision-safe paths in `scratch/` and
report old/new paths; commit other leftovers. `endCodeWork` must leave
`uncommittedFiles` empty. Temporary output belongs in scratch from the start.
The current checkpoint leaves large files behind
(`agent/training/branches.ts:43-55`); the solve runner catches a failed round
recovery and continues (`agent/run/harness_solve_session.ts:319-334`). P6 fixes
both, including the legacy solve execution path.

Follow-up rounds start from the champion on a branch in this same tree.
After switching back, the harness merges a round that produced the new champion
into the base branch; the champion tag stays on the measured commit. A conflict
aborts the merge and is reported, with the round retained and no expert started
on a conflicted tree. Persist switch/merge progress so recovery is idempotent.
Rounds without a new champion remain branches. Today switching back performs
no merge (`agent/training/branches.ts:104-115`). Literature may read the checked
out round; data and validation start only after round closure.

`workspace_check` is a static pass, without importing agent code, bounded to
2 s: missing docstrings/index entries, nonexistent indexed paths and stray
Python are errors; duplicate function bodies and files over 400 lines are
warnings. Record shared imports and archive loaders for P4. Validation may
write anywhere: record every changed path (including files the expert commits),
and warn on edits outside `checks/`; do not claim a filesystem write boundary.

## 2. Task data and sealing

P6 prepares task data at configuration, before any expert. Store it under
`runs/finetuned/<task>/data/`: development archive, sample/target manifest,
profile, identity and harness-only `sealed/` containing IDs, holdout metadata,
original input identity and seed plan. The development archive plus manifest
hash is the one dataset fingerprint for trials, findings and memory.

**The split is task-level state, not run state.** Persist the accepted split
declaration atomically before producing any agent-visible data. It records task,
archive bytes and membership, targets identity, holdout policy and root seed.
Every later run reuses that declaration and its exact split. Reject changes to
holdout, targets, seed or archive membership/identity with the differing fields
and the reason: previously exposed rows must not become sealed. Only an
explicit task-state reset permits a new declaration. Never overwrite a corrupt
record or redraw after interruption: resume materialization from the stored
split, or fail with a repair reason. Tests cover a fresh run and interrupted
configuration reusing the stored split. With unchanged inputs and seed, spam1's
first split must equal today's draw (`agent/solve/workspace.ts:129-146`).

Prepared data for all tasks is retained until an explicit reset. The disk setup
check requires free space of 1.2 times the training archive plus 1 GB before
preparing a new task; reuse needs only missing materialization space. Refit
rereads the measured development archive and manifest
(`agent/refit/service.ts:149-154`), so their paths and bytes must remain stable
for refit and recovery. Stream archives and respect P1's memory pool.

| Contract | Sealing | Agent-visible targets |
| --- | --- | --- |
| binary classification | stratified rows | development labels |
| clustering with families | whole withheld families | development family IDs for scoring only, never fit |
| label-free anomaly (images/sessions) | no row split initially; P7c can hold back evidence labels | none |
| label-free capture | whole capture is development input | none |

One `expertSandbox` policy replaces the two preparation policies: explicit
read-only mounts for development data, profile, task text, test inputs, findings
view, Python and binaries; solutions writable for data/modelling/validation,
read-only for literature. Never mount the original training archive, sealed
directory or a parent exposing either. P6's bubblewrap preflight covers every
expert. Harness-only confirmation metadata stays in `TaskData`, not in expert
inputs. Today research mounts the task directory
(`agent/run/solve_sandbox.ts:110`), before solve draws the split
(`agent/solve/workspace.ts:121-146`).

Test inputs are visible read-only. Prompt rules are rendered from the typed
execution contract and prediction domain, never a universal ban on fitting:

- **Inductive:** fits use only fold-training development inputs; no fit on
  validation or test inputs. Test inspection compares inputs only.
- **Batch:** harness execution may fit the declared validation/test batch
  without its scoring labels, including clustering unknown items and batch
  anomaly detection. No invented targets or pseudo-labels. Local development
  checks follow the same contract and do not become selection evidence.
- **Scalar labels/scores:** permute inputs, undo the permutation on outputs,
  then compare within the declared numerical tolerance.
- **Cluster IDs:** undo the row permutation, compare the partition modulo
  cluster-label renaming (and preserve the declared noise convention).

[Execution fragments](expert-team/prompts/execution/) supply both variants;
assemble and test prompts for family clustering and label-free batch images.

Sealed results go only to the orchestrator, never experts, their lessons or
findings. Remove confirmation from validation evidence and reject confirmation
artifact IDs as expert inputs. The orchestrator instruction keeps outcomes out
of objectives, guidance and feedback. Confirmation is advisory, never upload
permission. **Until P7c, clustering hand-over reports confirmation `skipped`
with its reason**: the service skips every non-binary kind
(`agent/confirmation/service.ts:74-77`). Withheld families alone do not establish
a completed sealed check.

## 3. Expert deliverables and validation

All experts read the findings journal, answer addressed questions, and deliver
an executor-validated stage report: Status, Delivered (entries/modules/trials),
Open questions, Next. Knowledge capture stores transferable lessons, not a
second copy of task facts. Shared tools include findings read/add/resolve,
workspace check and Python environment inspection; role tools are allowlisted.

| Expert | Delivers | Completion checks |
| --- | --- | --- |
| data | readers in `lib/io`/`lib/parse`, indexed modules, input facts with profile/check/output references, short checks | static workspace check, bounded observed data checks, at least one referenced fact and indexed reader imported by checks |
| literature | at most five ranked ideas, each citing a data finding or “general”, and searched sources | URL provenance, finding references and configured idea limit; no code or parameters prescribed |
| modelling | `tasks/<task>.py`, hypothesis finding IDs, harness experiments and result entries | trial collection/eligibility/selection, workspace check, entrypoint artifact from the measured commit |
| validation | executable checks, referenced concerns addressed to owners, advisory `evaluation_report` readiness verdict | record checks with trial/commit, output and exit status; verdict reflects failures and limits; workspace check |

Data does not compare models. Literature does not run code. Modelling chooses
features, estimator, hyperparameters and CV; local fits are only small
construction checks. The harness owns seeds, folds, processes, predictions,
measurements and promotion. The modelling prompt states that the run is
measured from modelling start to its first harness trial, target ten minutes.
At fifteen minutes without a trial, send one factual reminder, no hard stop.

Validation checks output domain, permutation-aligned outputs, fold fitting,
CV design, overlap and execution-contract compliance. It cannot start trials;
it recommends pipeline fixes to modelling. Its intended deliverable is checks;
outside-check edits are recorded and warned about, not prevented.

**Executable trial checks use immutable trial source, including imports.**
`evaluation_code` and the check runner select the same experiment and commit.
Mount that trial's `source` read-only and supply `VALIDATION_SOURCE_ROOT` (the
parent of its `solutions/` package) and `VALIDATION_EXPERIMENT_ID` in the session
environment. Run checks written in the live `checks/` against that snapshot in
a fresh Python process: put the snapshot first on `sys.path`/`PYTHONPATH`, remove
live solutions import roots and verify imported pipeline modules resolve under
the snapshot. Check code may change; checked pipeline code may not. Report
missing source explicitly; never fall back to live code. Data-only checks can
use live readers and must be identified separately.

Trials create snapshots using `addWorktree`
(`agent/training/git.ts:169-172`, `agent/training/service.ts:652-676`), but close
removes them (`agent/training/service.ts:905-940`). P6 supplies snapshot
resolution/reconstruction from the recorded commit/tree when absent, verifies
identity, and mounts it read-only; it never changes the live branch. These are
trial snapshots, not separate expert working trees. P7a runs validation checks
through this path. Regression: live pipeline passes, champion snapshot fails;
validation must fail, also after switch-back and a later live commit.

## 4. Findings and memory

One append-only file outside git:
`runs/finetuned/<task>/findings/journal.jsonl`. Serialize writes across sessions
and processes: wait and retry an exclusive lock, with cancellation, instead of
failing on contention. Do not change training's lock semantics: its
`claimWorkspace` deliberately throws on contention
(`agent/experiments/ownership.ts:11-19`). Append and flush a complete record
before acknowledging; derive paged read views on demand, with no persisted
`FINDINGS.md` to reconcile after crashes. Ignore an incomplete trailing record
on read, report it, and truncate only that tail under the writer lock before
appending again. A malformed complete record is an error.

The shared contract defines entries and append-only resolution events:

```ts
type FindingKind = "fact" | "idea" | "result" | "question" | "answer" |
  "concern" | "check" | "decision";
type FindingRef = { experiment: string } | { file: string; line: number; commit?: string } |
  { check: string; experiment?: string; sha256: string } | { url: string } |
  { profile: string } | { entry: string };
type FindingEntry = {
  id: string; cursor: number; kind: FindingKind;
  author: { role: ExpertRole; invocationId: string; runId: string };
  title: string; text: string; refs: FindingRef[]; datasetSha256: string;
  to?: ExpertRole; answers?: string;
};
type FindingResolution = { cursor: number; id: string;
  status: "answered" | "superseded"; answerId?: string; supersededBy?: string };
type FindingsStatus = { cursor: number; counts: Partial<Record<FindingKind, number>>;
  openQuestions: { id: string; to: ExpertRole; title: string }[];
  newEntries: { id: string; title: string }[]; staleRefs: string[] };
```

Titles ≤100 characters, text ≤800; questions require `to`, answers `answers`;
results require an experiment ID and receive metric/spread/cost from the
harness record, never agent text. Superseding one's own entry or answering a
question appends a resolution. Reads page from a cursor, at most 12 new titles
in status. An active addressee receives a question through invocation feedback;
route at most eight messages per invocation. Others wait for the orchestrator.
Every completed expert returns a `findings_snapshot` artifact for paged inspect.

Entries retain evidence links: experiment IDs, hashed check files, profile
records, source URLs. Report missing or changed references as stale; keep the
original entry. A passing check supports its stated observation, not arbitrary
prose. No automatic authority field or upgrades, and no repeated check reruns
to grant authority. Stage completion may execute checks once as specified above.

**“Established on this dataset” means only: has a resolvable harness experiment
record for the same dataset fingerprint.** It applies to measured results,
not every claim in an entry. Later runs show those measurements with IDs;
other entries remain attributed observations/ideas, with stale references
visible. This definition is the memory contract; prompts must not call all
established prose facts. Reuse the champion, index and shared modules; P4
measures fewer data/literature requests on repeated tasks.

## 5. Orchestrator and hand-over

`stage_start` accepts an expert role, refit or submit, objective, guidance and
up to 16 finding IDs. `pipeline_status` includes findings status; inspect
accepts `findings_snapshot`; `pipeline_wait` sleeps until a completion. The
orchestrator decides sequencing from findings and reports, not model recipes.
Persistent state supports the allowed pair and interrupted-round recovery.

The three old stages, brief validation/budget/tools and research-copy
requirement are retired by P7a. Keep profiling and extract the searched-URL
check. Keep research context helpers needed for task resolution, moving their
startup summary dependencies before deleting startup context. Stage sessions
and CLI setup remain instrumented. Confirmation and terminal refit retain
authoritative records; configured chains stop before submit. Only explicit
controller submission policy authorizes uploads.

Labelled hand-over selects the harness champion, freezes and refits it,
including sealed rows, terminally; no post-refit sealed score. P3 refits an
unhanded champion at budget end. Validation readiness is advice. P6/P7a/P7b
reach binary and family-clustering hand-over; the latter says sealed check
`skipped`, with reason. Label-free tasks have diagnostics and trials but no
champion/refit until P7c.

## 6. Shared contracts and independent builds

**Build P6 first and alone. Merge it before starting P7a and P7b in parallel.**
There are no missing-function stubs. P6 adds `agent/team/contracts.ts` as the
single source of `StageName`, `ExpertRole`, `TaskData`, `TreeState`,
`WorkspaceCheck`, `FindingsStatus`, entries, resolutions and findings interface.
`pipeline/types.ts` re-exports `StageName`. For independent builds, its union
includes the four roles, refit/submit and deprecated research/solve/evaluate
for legacy execution/history; P7a removes legacy registry entries, P7b handles
legacy persisted-state migration. The type union's legacy values do not enable
stages. P6 preserves functioning legacy APIs as adapters to foundations; P7a
retires old callers. No second implementation of sealing or sandbox policy.

`TaskData` is controller-only and includes: task/root, solutionsRoot,
configuration, taskPath, development archive and manifest, profilePath,
testArchive, datasetSha256, original training/targets paths, sealedPath,
holdoutSeedPlan, measurement, fold recommendation, rowCount, targets summary,
and `split: {sealedIds, fraction, seed, sha256, scheme, sealedGroups?,
confirmation?: HoldoutMetadata}`. These preserve the confirmation metadata
currently supplied by `SolveWorkspace` (`agent/solve/workspace.ts:28-56`).
Preparation remains synchronous so the legacy synchronous workspace adapter
can call it without a missing async dependency. Both use the same locked,
persistent split implementation.

`TreeState = {commit: string; uncommittedFiles: string[];
moved: {from: string; to: string}[]; changedPaths: string[]}`.
`WorkspaceCheck = {valid: boolean; errors: string[]; warnings: string[];
measurements: Record<string, number>; changedPaths: string[]}`.

All new cross-package exports are specified here. Async means Promise-returning;
errors reject. Other listed functions are synchronous. Filesystem errors keep
a bounded actionable reason, never raw credentials.

| Export and file | Timing / failure contract |
| --- | --- |
| `prepareTaskData(taskId: string, configuration: TaskConfiguration, options?: {seed?: number; signal?: AbortSignal}): TaskData` — `workspace/task_data.ts` | sync; locks task state before materialization; throws declaration conflict, invalid/corrupt inputs, disk/setup, materialization or abort error; interrupted work resumes stored split |
| `readTaskData(taskId: string): TaskData \| undefined` — same | sync; undefined only when absent; throws corrupt/incomplete state (with resume instruction) or I/O error |
| `expertSandbox(data: TaskData, role: ExpertRole, python: PythonEnvironment, trial?: TrialSnapshot): SolveSandbox` — `run/sandbox.ts` | sync; throws unsafe/missing mounts or invalid role/snapshot; validation requires snapshot for trial checks |
| `resolveTrialSnapshot(root: string, experimentId: string): Promise<TrialSnapshot>` — `workspace/trial_source.ts` | async; returns `{experimentId, commit, tree, sourceRoot}`; restores absent snapshot; throws missing record/commit, hash mismatch or git/I/O error |
| `beginCodeWork(root: string, label: string): Promise<TreeState>`; `endCodeWork(root: string, label: string): Promise<TreeState>` — `workspace/tree.ts` | async; throws unresolved round, merge conflict, failed checkpoint/move or dirty final tree; no expert starts after begin failure |
| `checkWorkspace(root: string, taskId: string, changedPaths?: string[]): Promise<WorkspaceCheck>` — `workspace/check.ts` | async; findings return invalid/warnings; execution/2 s bound or I/O failures throw |
| `workspaceCheckTool(root: string, taskId: string, prompts: PromptSnapshot): ToolDefinition` — same | sync factory; throws invalid path/prompt; tool awaits check and reports its error |
| `prepareModellingWorkspace(data: TaskData, configuration: TaskConfiguration): SolveWorkspace` — `solve/workspace.ts` | sync; no split draw; throws mismatched configuration, missing retained inputs or I/O error |
| `webSearchExtension(options: {maxCalls: number; maxResults: number; logPath: string}): ExtensionFactory` — `tools/web_search.ts` | sync factory; throws invalid options; async tool returns sanitized search failure; limits/log are session-local |
| `FindingsReader.status(taskId: string, cursor?: number): Promise<FindingsStatus>` — interface in `team/contracts.ts` | P7a implements; P7b injects it, uses a fake only in tests; rejects malformed cursor, corrupt journal or I/O, absent journal returns empty status |
| `findingsStatus(taskId: string, cursor?: number): Promise<FindingsStatus>` — `team/findings.ts` | P7a async implementation of that interface; same errors |
| `findingsAdd(taskId: string, entry: Omit<FindingEntry, "id" \| "cursor">, signal?: AbortSignal): Promise<FindingEntry>`; `findingsResolve(taskId: string, event: Omit<FindingResolution, "cursor">, actor: ExpertRole, signal?: AbortSignal): Promise<FindingResolution>` — same | async serialized durable writes; reject malformed/unauthorized entries, corrupt log, I/O or abort; contention waits/retries |
| `findingsRead(taskId: string, options?: {since?: number; kinds?: FindingKind[]; to?: ExpertRole; limit?: number}): Promise<{entries: FindingEntry[]; resolutions: FindingResolution[]; cursor: number; staleRefs: string[]}>` — same | async derived view; reject invalid filters, complete-record corruption or I/O; report torn tail/stale refs |

`TrialSnapshot`, `FindingsReader`, `FindingKind` and the existing `TrainingLabelRow`
type moved from startup context also live in the contract file. P7a's check
runner export is `runTrialChecks(snapshot: TrialSnapshot, checkPaths: string[],
sandbox: SolveSandbox, signal?: AbortSignal): Promise<{passed: boolean;
checks: {path: string; exitCode: number; outputPath: string}[]}>` in
`agent/evaluation/checks.ts`: async, returns failed checks normally; throws
unsafe path/import origin, source mismatch, launch/I/O or abort errors.

P6 supplies session-local `RunSessionOptions.env` to tool factories/spawn
hooks, never mutating `process.env`. Legacy web-search registration remains a
working adapter with frozen options. P7b uses the contract via an injected
reader; its production composition in `orchestrator/run.ts` uses a real
read-only journal projection supplied by P6 (`workspace/findings_reader.ts`,
export `createFindingsReader(root: string): FindingsReader`; sync, throws
invalid root/I/O; returned async status has the contract errors), so P6+P7b
runs without P7a. P7a owns
the writer and may delegate reads to that projection. Absent journals are empty,
not fabricated findings. The projection uses the contract format, no imports
from P7a's implementation.

## 7. Package table and merge gates

Ownership below includes tests adjacent to each implementation unless assigned
explicitly. No concurrently built packages edit the same file. Sequential
handoffs to P7c are explicit. Every intermediate state must build and pass:
**P6 alone; P6+P7a; P6+P7b; P6+P7a+P7b**. P6 keeps old entrypoints functioning;
P7b must tolerate absent expert registrations and report “not implemented”,
while its fake-expert tests exercise scheduling. P7a alone registers experts
and runs them through the executor/CLI, without depending on controller edits.
P7a's setup tests for the new expert chain use new `stages/experts.test.ts`;
P6's legacy setup fixtures remain until the final integration gate. Its type
expansion also narrows the legacy stage list in
`agent/orchestrator/coordinator.test.ts:120-122` to literal legacy values so
new role names do not index a legacy-only artifact map; P7b later owns that test.

| Package / order | File ownership and deliverable |
| --- | --- |
| **P6 Foundations — first, alone** | New `agent/team/contracts.ts`; `agent/pipeline/types.ts` (re-export); `agent/workspace/{task_data,tree,check,trial_source,findings_reader}.ts`, `workspace/python/workspace_check.py`; `agent/solve/{workspace,folds}.ts`, `solutions-README.md`, solve workspace/folds tests (retain legacy research-copy adapter/test until P7a); `agent/run/sandbox.ts`, `solve_sandbox.ts` compatibility adapter and sandbox tests; `agent/training/branches.ts`; `agent/pipeline/setup.ts` and setup tests; `agent/run/session_runner.ts` and tests; `agent/tools/web_search.ts` and tests; `agent/confirmation/{fixture-live.ts,service.test.ts}` sandbox consumers; `experiment/minimal.ts` import-only sandbox migration and `experiment/minimal.test.ts` boundary fixtures (no coaching); `agent/orchestrator/coordinator.test.ts` legacy-stage fixture typing (then handed to P7b); foundation API adapters in `agent/run/harness_solve_session.ts` including fail-closed recovery. P6 hands that session file, `solve/workspace.ts` and `run/research_session.ts` to P7a after merge; the research session only needs sandbox adapter wiring in P6. |
| **P7a Experts, journal, prompts — parallel after P6** | `agent/team/{findings,sources}.ts`; `agent/pipeline/stages/{data,literature,modelling,validation}.ts` and tests, deletion of `{research,solve,evaluate}.ts` and old stage tests; `agent/pipeline/{registry,guidance,feedback,config}.ts` and tests (guidance/feedback role allowlists and config default become experts); `pipeline.config.json`; replace `agent/pipeline/run_{research,solve,evaluate}.ts` and `agent/{research,solve,evaluate}_cli.ts` with `run_expert.ts`/`expert_cli.ts`; root `package.json` research/solve-stage/evaluate-stage scripts become expert CLI calls. `agent/run/expert_session.ts`, `harness_solve_session.ts`, delete `research_session.ts` and `run/research_sandbox.test.ts`; remove the deprecated `copyResearch` and brief fields in `solve/workspace.ts`, delete `solve/research_copy.test.ts`; `agent/research/{validate,tools,budget,startup_context}.ts` and tests deleted after extracting URL checks and still-used summaries into `research/context.ts`; `research/profile.ts` and tests (development input); `agent/evaluation/{evidence,code,reviewer}.ts` and tests plus new `agent/evaluation/checks.ts` snapshot check runner; `agent/knowledge/lessons.ts` and tests. `agent/prompts/{registry,research,solve}.ts` (delete old prompt preparers), `loader.test.ts`, `experts/`, `lessons/`, `review/{system,start}.md`, `solve/{system,start,follow-up}.md`; delete `research/`, `subagents/`, `context/subagent-probe*.md`. Delete `agent/subagents/`; update its callers in `agent/{context,knowledge}/session.test.ts`, `agent/harness/config.ts`, `harness.config.json`, `harness/config.test.ts`; stage fixtures in `pipeline/{executor,run_pipeline,config}.test.ts`, `refit/pipeline.test.ts`, `research/context.test.ts`, `training/evidence_selection.test.ts`. |
| **P7b Orchestrator — parallel after P6** | `agent/orchestrator/{coordinator,state,tools,run,session,parallel}.ts`, their tests and README; `agent/prompts/orchestrator/{system,start,tool}.md` content, keeping existing IDs/variable schema (registry belongs to P7a). Parallel rule, state migration, contract reader injection, findings inspect allowlist, configuration persistence calls, and controller prompt. No session runner/web-search ownership. |
| **P7c Verification beyond binary classification — after all three** | `agent/confirmation/{service,receipt}.ts` and tests, confirmation worker `agent/training/python/confirm.py`, `agent/training/python/smartlab_trial/metrics.py` and tests: withheld-family clustering metric/worker and evidence confirmation. New `agent/team/evidence_labels.ts`; `agent/training/development_selection.ts`, `agent/refit/service.ts` and tests for offline declared unscored tags; label-free fragments and orchestrator label-free content, registry additions and evidence tools in expert stages (ownership handed over from P7a/P7b). Step 1 unscored hand-over, then step 2 evidence labels. |

P6's working adapter for `prepareSolveWorkspace` supplies its data fields from
retained task data and keeps legacy brief copying until P7a migrates the old
callers and removes `copyResearch`. These sequential file handoffs do not
create shared ownership between the parallel packages. P6 moves the
`TrainingLabelRow` type to the shared contract and changes folds imports; P7a
moves summary helpers into context before deleting startup context. P6 setup
fixtures use supported adapters, not imports of stages scheduled for deletion.

### Import/deletion audit

Repository search of every proposed deletion/rename found these consumers;
owners above must migrate them in the same package as the breaking change.
Search again before deleting, including prompt registry paths and script
strings. This is a consumer list, not permission to change the minimal agent.

| Removed/renamed API or file | Consumers / owner |
| --- | --- |
| `run/solve_sandbox.ts` implementation → `run/sandbox.ts` | P6: `pipeline/setup.ts:2`, `run/harness_solve_session.ts:27,219` (including hashed source path), `run/research_session.ts:32`, `run/{solve_sandbox,research_sandbox}.test.ts`, `confirmation/{fixture-live.ts:4,service.test.ts:15}`, `experiment/minimal.ts:16`. Keep old import path as a functioning adapter until callers retire; P7a deletes research session/test only after migration. P6 owns initial import updates; P7a owns later deletion, never concurrently. |
| `research/startup_context.ts` | P6: `solve/{folds.ts:14,folds.test.ts:4}` type imports; P7a: `research/context.ts:13`, `prompts/{research.ts:2,loader.test.ts:12}` plus its own test. |
| `research/{validate,tools,budget}.ts` | P7a: `run/research_session.ts:23-25`, `research/tools.ts:7`, own tests, `knowledge/lessons.test.ts:7`. Move URL validation before deleting. |
| `run/research_session.ts` | P7a: `pipeline/stages/research.ts:14`. |
| `pipeline/stages/{research,solve,evaluate}.ts` | P7a: `pipeline/registry.ts:11-13`, old stage tests, `evaluation/reviewer.test.ts:8`, `harness/config.test.ts:4`, `refit/pipeline.test.ts:9`, `research/{context.test.ts:5,profile.test.ts:10}`, `training/evidence_selection.test.ts:1`. P6 owns `pipeline/setup.test.ts:99,118,160`: remove direct stage imports in favor of setup fixtures before P7a deletes them. |
| `pipeline/run_{research,solve,evaluate}.ts` and three CLIs | P7a: `research_cli.ts:44`, `solve_cli.ts:9`, `evaluate_cli.ts:2`, root `package.json:9,15-16` script entries (script names are authoritative if lines move). |
| `prompts/{research,solve}.ts` | P7a: `research_cli.ts:5`, `run/{research_session.ts:28,harness_solve_session.ts:13}`, `pipeline/guidance.test.ts:11-12`, `context/session.test.ts:230-231`, `prompts/loader.test.ts:10-11`. |
| prompt research/subagents folders and context probes; replacement review/solve text | P7a: `prompts/registry.ts:29-30,38-49,73-78` and remaining research IDs; `prompts/loader.test.ts`; P6/P7a migrate sandbox/boundary prompt-path fixtures (`run/research_sandbox.test.ts:32`, `experiment/minimal.test.ts:31,76`). |
| `agent/subagents/` | P7a: internal imports removed with folder; `context/session.test.ts:8-9`, `knowledge/session.test.ts:7`, `harness/config.test.ts:8`; config sections and registry prompt IDs retired together. |
| `copyResearch` | P7a after P6 handoff: `solve/workspace.ts:147,213`, `solve/research_copy.test.ts:6,19,35`; retire together with brief consumers/validator. |

### Required gates and measurable tests

After **each** package: `./dev bun run typecheck`, prompt snapshot loading
(`./dev bun test harness/finetuned/agent/prompts/loader.test.ts`), affected TS
and Python tests, boundary tests, and CLI `--check-setup` on the pipeline and
available standalone entrypoints. Use fixtures for absent credentials; prove
missing/invalid prerequisites prevent sessions and aggregate local failures.
Live probes must remain bounded; no model pipeline run is part of a package.
New source/check executors declare Python/executable and sandbox prerequisites;
all requested later stages are checked before any session starts.

- **P6:** first split matches current spam1; fresh run and interrupted configure
  reuse it; holdout/targets/seed/archive changes rejected before mounts; retain
  another task's refittable data; disk failure; all role mounts hide sealed
  inputs; literature code read-only. Concurrent sessions preserve IDs/search
  limits and leave `process.env` unchanged. Recovery failure prevents legacy
  solve and any code writer starting. Oversized-file move yields clean tree;
  round champion merges, tag unchanged, conflict aborts, crash replay safe.
  Snapshot reconstruction verifies commit/tree. Workspace fixture errors under
  2 s; outside-check changes reported. Journal projection replays contract
  fixtures without a P7a import.
- **P7a:** concurrent journal writes survive contention; replay after crash
  including torn append; stale check/experiment ref reported without upgrading
  prose; measured result values come from harness records. Role tools and URL
  provenance; feedback question/answer; snapshot code reader and executable
  check fail for broken champion even with passing live code. Stage results use
  measured entrypoint; no confirmation in validation tools. Every assembled
  expert prompt excludes fixture `AGENTS.md`, includes selected instructions,
  rejects missing/unknown variables; family-clustering and label-free batch
  image prompts allow declared batch fits and compare outputs correctly.
- **P7b:** allowed pairs start, all other pairs/refit overlap refused; persisted
  pairs resume; fake `FindingsReader` proves no P7a import. Production reader
  handles no journal. Confirmation inputs rejected, validation upstream allowed;
  fresh-run reconfiguration uses task split. Equal controller model requests
  for fake 1 s/30 s stages. P6+P7b with old registry builds and fails unavailable
  expert starts clearly; full integration exercises real experts and journal.

Wave-2 measured runs: spam1 has reused reader, complete index, no stray Python,
first trial ≤10 minutes, hand-over ≤45 minutes and ≤8 trials, completed binary
confirmation and recorded validation. A repeated run reuses measurements and
needs fewer data/literature calls. Family clustering reaches hand-over with
confirmation explicitly **skipped**, bounded pool usage and passed disk check.
These are the prerequisite runs for P7c, not evidence of clustering verification.

## 8. P7c: verification beyond binary classification

**Clustering:** implement sealed confirmation on withheld families, using the
declared clustering metric (adjusted Rand index for family clustering),
execution mode and partition semantics; scoring labels never enter fit.
Extend the confirmation worker, metric packet, receipt and service dispatch,
including reuse identity and a reason when truly unavailable. Gate: a completed
(not skipped) clustering confirmation from a frozen champion with withheld
families, with score visible only to the orchestrator.

**Label-free step 1, offline unscored hand-over:** name a completed valid trial
and a reason; harness writes a `declared` tag, refit accepts it only for
`metric: none` offline, result says unscored. Refuse online and labelled tasks.
Before this step label-free runs stop with diagnostics, without refit.

**Step 2, evidence labels:** data proposes clear positive/negative labels via
`evidence_label({ids,label,reason,method})`; validation independently accepts or
rejects positives. Keep label provenance and decision records harness-owned.
Accepted negatives need the data expert's explicit label; accepted positives
need both experts. A task-persisted seeded ID hash assigns about one third to
held-back evidence independently of acceptance order. Store labels harness-only;
only development evidence enters trials, never scoring labels in fit.
`holdout: none`, anomaly targets/metric `none`, evidence selection on known
development IDs by evidence AP or ROC AUC. The evidence split seed/membership
obeys the same task-state reset rule. Expert tools expose only the caller's
proposals/counts; journal gives counts/methods, never held-back IDs or outcomes.

The confirmation worker scores the frozen champion on held-back evidence for
the orchestrator. Default minimum accepted positives: 12 development, 6 held
back. Record label-free diagnostics and flagged share against the task's stated
rate. Verdict names ascertainment bias: hand-found clear positives need not
represent official attacks. With insufficient evidence, use step 1. Refit
retains the task's batch/inductive contract and prediction domain.

Tests: acceptance order leaves membership unchanged; unaccepted positive enters
neither evidence file; fresh runs reuse evidence split; sealed evidence never
reaches experts; offline declared tag restrictions. Run label-free batch images
to hand-over with exact input-ID coverage, evidence-selected or explicitly
unscored; the FTP-session task uses the same path.

## 9. Current code obstacles and remaining scope

These are implementation work, not reopened decisions:

- Stage names are hardcoded in guidance (`agent/pipeline/guidance.ts:33`),
  feedback (`agent/pipeline/feedback.ts:40`) and defaults
  (`agent/pipeline/config.ts:46-48`). P7a owns all three.
- Session environment is process-global (`agent/run/session_runner.ts:131-146`);
  search reads the log/limits globally (`agent/tools/web_search.ts:26,87,117`).
  P6 must fix this before parallel sessions.
- Review reads live files (`agent/evaluation/code.ts:14-21`); snapshots are
  removed on training close (`agent/training/service.ts:922,929-940`). P6's
  resolver and P7a's check runner must bind execution, not just displayed code.
- Confirmation skips non-binary tasks (`agent/confirmation/service.ts:74-77`),
  so P7c needs worker/metric work, not just a prompt change. The worker also
  requires 0/1 targets (`agent/training/python/confirm.py:30-35`) and binary
  observations/bootstrap (`agent/training/python/confirm.py:49-74`).
- Refit hashes retained inputs (`agent/refit/service.ts:149-154`); task-level
  split persistence must keep paths and bytes stable.
- Current split preparation writes holdout files each invocation
  (`agent/solve/workspace.ts:121-158`); deterministic redraw alone does not
  reject changed declarations or survive partial configuration safely.
- Lock contention throws (`agent/experiments/ownership.ts:11-19`); journal
  serialization must wait without weakening training ownership.
- Round checkpoint/recovery and missing merge are the changes in section 1.

Document malware uses the binary path and shared parsers. Multi-class Tor
classification remains an extension: class targets, sealing, metrics and
prediction domain must be designed together; it is not silently mapped to
binary classification. P7c's evidence validation thresholds and batch numerical
tolerances must be typed configuration with defaults recorded in receipts.
Remaining implementation choices requiring an explicit configuration decision:
the minimum evidence-negative count, scalar tolerances and cluster noise-label
convention for each task; this design does not infer them from absent task
instructions. These do not reopen the nine decisions above.
No decided open questions remain. The current worktree's redesign plan has a
“Decisions” section but no separate “Decision log”; its decisions remain fixed.
