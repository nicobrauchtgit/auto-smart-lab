# Expert team contracts (appendix to v2)

Contract appendix to [expert-team-v2.md](expert-team-v2.md), trimmed on
2026-11-11. The first design's topology and orchestration (four executor
stages, the LLM orchestrator, overlap rules, stage reports, question routing
and the P6/P7a/P7b file-ownership table) are superseded by v2. The full
original is in git history (commit 452e1e5).

This file keeps only the contracts v2 section 10 retains. "Agent" means the
lead or a scout (v2 section 3). Paths are relative to `harness/finetuned/`
unless prefixed by `runs/`, `experiment/` or "root". Package names (P6, P7a,
P7b, P7c) follow v2 section 11. None of this is implemented yet; the current
code still runs the old stage chain.

## 1. Task data and sealing

P6 prepares task data at configuration, before any agent starts. Store it
under `runs/finetuned/<task>/data/`: development archive, sample/target
manifest, profile, identity and harness-only `sealed/` containing IDs, holdout
metadata, original input identity and seed plan. The development archive plus
manifest hash is the one dataset fingerprint for trials, findings and memory.

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
for refit and recovery. Stream archives.

| Contract | Sealing | Agent-visible targets |
| --- | --- | --- |
| binary classification | stratified rows | development labels |
| clustering with families | whole withheld families | development family IDs for scoring only, never fit |
| label-free anomaly (images/sessions) | no row split initially; P7c can hold back evidence labels | none |
| label-free capture | whole capture is development input | none |

One sandbox policy (`expertSandbox`, parameterised by role) replaces the two
preparation policies: explicit read-only mounts for development data, profile,
task text, test inputs, findings view, Python and binaries. Write access to
`solutions/` follows the tool table in v2 section 3 (the ideas scout is
read-only). Never mount the original training archive, sealed directory or a
parent exposing either. P6's bubblewrap preflight covers every role.
Harness-only confirmation metadata stays in `TaskData`, not in agent inputs.
Today research mounts the task directory (`agent/run/solve_sandbox.ts:110`),
before solve draws the split (`agent/solve/workspace.ts:121-146`).

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

**Holdout feedback (planned, v2 section 4).** Labels of the withheld rows and
raw per-trial holdout scores never reach an agent, its findings or lessons.
When a trial becomes champion, the lead hears only the Ladder verdict (Blum &
Hardt, ICML 2015): "holdout confirms the improvement" with a rounded score, or
"no significant improvement". Every query is counted and recorded.
Confirmation artifacts are not scout inputs. Confirmation is advisory, never
upload permission. **Until P7c, clustering hand-over reports confirmation
`skipped` with its reason**: the service skips every non-binary kind
(`agent/confirmation/service.ts:74-77`). Withheld families alone do not
establish a completed sealed check.

## 2. Shared solutions tree

All agents share one working tree, `runs/finetuned/solutions/`:

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
from the shared README; task text supplies such facts (v2 section 9).

`beginCodeWork` closes any interrupted follow-up before an agent starts writing
code; a failure stops with its reason, without starting that agent. Checkpoint
leftovers on their original branch. Move oversized untracked files (above the
existing 1 MB threshold) to collision-safe paths in `scratch/` and report
old/new paths; commit other leftovers. `endCodeWork` must leave
`uncommittedFiles` empty. Temporary output belongs in scratch from the start.
The current checkpoint leaves large files behind
(`agent/training/branches.ts:43-55`); the solve runner catches a failed round
recovery and continues (`agent/run/harness_solve_session.ts:319-334`). P6 fixes
both, including the legacy solve execution path.

**Follow-up branch merge.** Follow-up rounds start from the champion on a
branch in this same tree. After switching back, the harness merges a round
that produced the new champion into the base branch; the champion tag stays on
the measured commit. A conflict aborts the merge and is reported, with the
round retained and no agent started on a conflicted tree. Persist switch/merge
progress so recovery is idempotent. Rounds without a new champion remain
branches. Today switching back performs no merge
(`agent/training/branches.ts:104-115`).

**`workspace_check`** is a static pass, without importing agent code, bounded
to 2 s: missing docstrings/index entries, nonexistent indexed paths and stray
Python are errors; duplicate function bodies and files over 400 lines are
warnings. Record shared imports and archive loaders for the scorecard. Record
every changed path of an agent (including files it commits); do not claim a
filesystem write boundary.

## 3. Trial snapshots and executable checks

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
trial snapshots, not separate agent working trees. The validation scout runs
its checks through this path. Regression: live pipeline passes, champion
snapshot fails; validation must fail, also after switch-back and a later live
commit.

The check runner export is `runTrialChecks(snapshot: TrialSnapshot,
checkPaths: string[], sandbox: SolveSandbox, signal?: AbortSignal):
Promise<{passed: boolean; checks: {path: string; exitCode: number; outputPath:
string}[]}>` in `agent/evaluation/checks.ts`: async, returns failed checks
normally; throws unsafe path/import origin, source mismatch, launch/I/O or
abort errors.

## 4. Findings journal

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

Scout bullets (v2 section 3) and harness trial results are appended here. The
shared contract defines entries and append-only resolution events:

```ts
type TeamRole = "lead" | "data" | "ideas" | "validation";
type FindingKind = "fact" | "idea" | "result" | "defect" | "decision";
type FindingRef = { experiment: string } | { file: string; line: number; commit?: string } |
  { check: string; experiment?: string; sha256: string } | { url: string } |
  { profile: string } | { entry: string };
type FindingEntry = {
  id: string; cursor: number; kind: FindingKind;
  author: { role: TeamRole; invocationId: string; runId: string };
  title: string; text: string; refs: FindingRef[]; datasetSha256: string;
};
type FindingResolution = { cursor: number; id: string;
  status: "superseded"; supersededBy?: string };
type FindingsStatus = { cursor: number; counts: Partial<Record<FindingKind, number>>;
  newEntries: { id: string; title: string }[]; staleRefs: string[] };
```

Titles ≤100 characters, text ≤800. Results require an experiment ID and
receive metric/spread/cost from the harness record, never agent text. Defects
come from the validation scout and cite the snapshot, check or trial.
Superseding one's own entry appends a resolution. Reads page from a cursor, at
most 12 new titles in status. A repeat scout call sees earlier entries and is
told not to repeat them (v2 section 3).

Entries retain evidence links: experiment IDs, hashed check files, profile
records, source URLs. Report missing or changed references as stale; keep the
original entry. A passing check supports its stated observation, not arbitrary
prose. No automatic authority field or upgrades, and no repeated check reruns
to grant authority.

**"Established on this dataset" means only: has a resolvable harness experiment
record for the same dataset fingerprint.** It applies to measured results,
not every claim in an entry. Later runs show those measurements with IDs;
other entries remain attributed observations/ideas, with stale references
visible. This definition is the memory contract; prompts must not call all
established prose facts. Reuse the champion, index and shared modules; the
scorecard measures fewer scout calls on repeated tasks.

## 5. Shared types and exports

P6 adds `agent/team/contracts.ts` as the single source of `TeamRole`,
`TaskData`, `TreeState`, `WorkspaceCheck`, `FindingsStatus`, entries,
resolutions, `TrialSnapshot`, `FindingsReader`, `FindingKind` and the existing
`TrainingLabelRow` type moved from startup context. No second implementation of
sealing or sandbox policy. P6 preserves functioning legacy APIs as adapters to
these foundations until the old stage chain is retired (v2 P7b).

`TaskData` is controller-only and includes: task/root, solutionsRoot,
configuration, taskPath, development archive and manifest, profilePath,
testArchive, datasetSha256, original training/targets paths, sealedPath,
holdoutSeedPlan, measurement, fold recommendation, rowCount, targets summary,
and `split: {sealedIds, fraction, seed, sha256, scheme, sealedGroups?,
confirmation?: HoldoutMetadata}`. These preserve the confirmation metadata
currently supplied by `SolveWorkspace` (`agent/solve/workspace.ts:28-56`).
Preparation remains synchronous so the legacy synchronous workspace adapter
can call it. Both use the same locked, persistent split implementation.

`TreeState = {commit: string; uncommittedFiles: string[];
moved: {from: string; to: string}[]; changedPaths: string[]}`.
`WorkspaceCheck = {valid: boolean; errors: string[]; warnings: string[];
measurements: Record<string, number>; changedPaths: string[]}`.

Async means Promise-returning; errors reject. Other listed functions are
synchronous. Filesystem errors keep a bounded actionable reason, never raw
credentials.

| Export and file | Timing / failure contract |
| --- | --- |
| `prepareTaskData(taskId: string, configuration: TaskConfiguration, options?: {seed?: number; signal?: AbortSignal}): TaskData` — `workspace/task_data.ts` | sync; locks task state before materialization; throws declaration conflict, invalid/corrupt inputs, disk/setup, materialization or abort error; interrupted work resumes stored split |
| `readTaskData(taskId: string): TaskData \| undefined` — same | sync; undefined only when absent; throws corrupt/incomplete state (with resume instruction) or I/O error |
| `expertSandbox(data: TaskData, role: TeamRole, python: PythonEnvironment, trial?: TrialSnapshot): SolveSandbox` — `run/sandbox.ts` | sync; throws unsafe/missing mounts or invalid role/snapshot; validation requires snapshot for trial checks |
| `resolveTrialSnapshot(root: string, experimentId: string): Promise<TrialSnapshot>` — `workspace/trial_source.ts` | async; returns `{experimentId, commit, tree, sourceRoot}`; restores absent snapshot; throws missing record/commit, hash mismatch or git/I/O error |
| `beginCodeWork(root: string, label: string): Promise<TreeState>`; `endCodeWork(root: string, label: string): Promise<TreeState>` — `workspace/tree.ts` | async; throws unresolved round, merge conflict, failed checkpoint/move or dirty final tree; no agent starts after begin failure |
| `checkWorkspace(root: string, taskId: string, changedPaths?: string[]): Promise<WorkspaceCheck>` — `workspace/check.ts` | async; findings return invalid/warnings; execution/2 s bound or I/O failures throw |
| `workspaceCheckTool(root: string, taskId: string, prompts: PromptSnapshot): ToolDefinition` — same | sync factory; throws invalid path/prompt; tool awaits check and reports its error |
| `prepareModellingWorkspace(data: TaskData, configuration: TaskConfiguration): SolveWorkspace` — `solve/workspace.ts` | sync; no split draw; throws mismatched configuration, missing retained inputs or I/O error |
| `webSearchExtension(options: {maxCalls: number; maxResults: number; logPath: string}): ExtensionFactory` — `tools/web_search.ts` | sync factory; throws invalid options; async tool returns sanitized search failure; limits/log are session-local |
| `FindingsReader.status(taskId: string, cursor?: number): Promise<FindingsStatus>` — interface in `team/contracts.ts` | rejects malformed cursor, corrupt journal or I/O; absent journal returns empty status; tests may use a fake |
| `createFindingsReader(root: string): FindingsReader` — `workspace/findings_reader.ts` | sync; read-only journal projection in the contract format; throws invalid root/I/O |
| `findingsStatus(taskId: string, cursor?: number): Promise<FindingsStatus>` — `team/findings.ts` | async implementation of that interface; same errors |
| `findingsAdd(taskId: string, entry: Omit<FindingEntry, "id" \| "cursor">, signal?: AbortSignal): Promise<FindingEntry>`; `findingsResolve(taskId: string, event: Omit<FindingResolution, "cursor">, actor: TeamRole, signal?: AbortSignal): Promise<FindingResolution>` — same | async serialized durable writes; reject malformed/unauthorized entries, corrupt log, I/O or abort; contention waits/retries |
| `findingsRead(taskId: string, options?: {since?: number; kinds?: FindingKind[]; limit?: number}): Promise<{entries: FindingEntry[]; resolutions: FindingResolution[]; cursor: number; staleRefs: string[]}>` — same | async derived view; reject invalid filters, complete-record corruption or I/O; report torn tail/stale refs |

P6 supplies session-local `RunSessionOptions.env` to tool factories/spawn
hooks, never mutating `process.env`. Legacy web-search registration remains a
working adapter with frozen options.

## 6. Import and deletion audit

A repository search on 2026-11-10 of every deletion/rename planned in the
first design found these consumers. Whoever makes the breaking change migrates
them in the same package. Search again before deleting, including prompt
registry paths and script strings; line numbers drift. This is a consumer list,
not permission to change the minimal agent.

| Removed/renamed API or file | Consumers |
| --- | --- |
| `run/solve_sandbox.ts` implementation → `run/sandbox.ts` | `pipeline/setup.ts:2`, `run/harness_solve_session.ts:27,219` (including hashed source path), `run/research_session.ts:32`, `run/{solve_sandbox,research_sandbox}.test.ts`, `confirmation/{fixture-live.ts:4,service.test.ts:15}`, `experiment/minimal.ts:16`. Keep the old import path as a functioning adapter until callers retire. |
| `research/startup_context.ts` | `solve/{folds.ts:14,folds.test.ts:4}` type imports; `research/context.ts:13`, `prompts/{research.ts:2,loader.test.ts:12}` plus its own test. |
| `research/{validate,tools,budget}.ts` | `run/research_session.ts:23-25`, `research/tools.ts:7`, own tests, `knowledge/lessons.test.ts:7`. Move URL validation before deleting. |
| `run/research_session.ts` | `pipeline/stages/research.ts:14`. |
| `pipeline/stages/{research,solve,evaluate}.ts` | `pipeline/registry.ts:11-13`, old stage tests, `evaluation/reviewer.test.ts:8`, `harness/config.test.ts:4`, `refit/pipeline.test.ts:9`, `research/{context.test.ts:5,profile.test.ts:10}`, `training/evidence_selection.test.ts:1`, `pipeline/setup.test.ts:99,118,160` (replace direct stage imports with setup fixtures first). |
| `pipeline/run_{research,solve,evaluate}.ts` and three CLIs | `research_cli.ts:44`, `solve_cli.ts:9`, `evaluate_cli.ts:2`, root `package.json:9,15-16` script entries (script names are authoritative if lines move). |
| `prompts/{research,solve}.ts` | `research_cli.ts:5`, `run/{research_session.ts:28,harness_solve_session.ts:13}`, `pipeline/guidance.test.ts:11-12`, `context/session.test.ts:230-231`, `prompts/loader.test.ts:10-11`. |
| prompt research/subagents folders and context probes | `prompts/registry.ts:29-30,38-49,73-78` and remaining research IDs; `prompts/loader.test.ts`; sandbox/boundary prompt-path fixtures (`run/research_sandbox.test.ts:32`, `experiment/minimal.test.ts:31,76`). |
| `agent/subagents/` | **Not deleted** (decision of 2026-11-11): it is the base for the blocking scouts (v2 P7a). Its consumers `context/session.test.ts:8-9`, `knowledge/session.test.ts:7`, `harness/config.test.ts:8` and its config section and prompt IDs change only as the scout work requires. |
| `copyResearch` | `solve/workspace.ts:147,213`, `solve/research_copy.test.ts:6,19,35`; retire together with brief consumers/validator. |

## 7. P7c: verification beyond binary classification

**Clustering:** implement sealed confirmation on withheld families, using the
declared clustering metric (adjusted Rand index for family clustering),
execution mode and partition semantics; scoring labels never enter fit.
Extend the confirmation worker, metric packet, receipt and service dispatch,
including reuse identity and a reason when truly unavailable. Gate: a completed
(not skipped) clustering confirmation from a frozen champion with withheld
families; the lead sees only the Ladder verdict (section 1).

**Label-free step 1, offline unscored hand-over:** name a completed valid trial
and a reason; harness writes a `declared` tag, refit accepts it only for
`metric: none` offline, result says unscored. Refuse online and labelled tasks.
Before this step label-free runs stop with diagnostics, without refit.

**Step 2, evidence labels:** the data scout proposes clear positive/negative
labels via `evidence_label({ids,label,reason,method})`; the validation scout
independently accepts or rejects positives. Keep label provenance and decision
records harness-owned. Accepted negatives need the data scout's explicit
label; accepted positives need both. A task-persisted seeded ID hash assigns
about one third to held-back evidence independently of acceptance order. Store
labels harness-only; only development evidence enters trials, never scoring
labels in fit. `holdout: none`, anomaly targets/metric `none`, evidence
selection on known development IDs by evidence AP or ROC AUC. The evidence
split seed/membership obeys the same task-state reset rule. Agent tools expose
only the caller's proposals/counts; the journal gives counts/methods, never
held-back IDs or outcomes.

The confirmation worker scores the frozen champion on held-back evidence for
the hand-over record. Default minimum accepted positives: 12 development, 6
held back. Record label-free diagnostics and flagged share against the task's
stated rate. Verdict names ascertainment bias: hand-found clear positives need
not represent official attacks. With insufficient evidence, use step 1. Refit
retains the task's batch/inductive contract and prediction domain.

Tests: acceptance order leaves membership unchanged; unaccepted positive enters
neither evidence file; fresh runs reuse evidence split; sealed evidence never
reaches agents; offline declared tag restrictions. Run label-free batch images
to hand-over with exact input-ID coverage, evidence-selected or explicitly
unscored; the FTP-session task uses the same path.

## 8. Current code obstacles

These are implementation work, not reopened decisions:

- Stage names are hardcoded in guidance (`agent/pipeline/guidance.ts:33`),
  feedback (`agent/pipeline/feedback.ts:40`) and defaults
  (`agent/pipeline/config.ts:46-48`); they go with the stage chain (v2 P7b).
- Session environment is process-global (`agent/run/session_runner.ts:131-146`);
  search reads the log/limits globally (`agent/tools/web_search.ts:26,87,117`).
  P6 must fix this before parallel scout sessions.
- Review reads live files (`agent/evaluation/code.ts:14-21`); snapshots are
  removed on training close (`agent/training/service.ts:922,929-940`). P6's
  resolver and the check runner must bind execution, not just displayed code.
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
- Round checkpoint/recovery and the missing merge are the changes in section 2.

Document malware uses the binary path and shared parsers. Multi-class Tor
classification remains an extension: class targets, sealing, metrics and
prediction domain must be designed together; it is not silently mapped to
binary classification. P7c's evidence validation thresholds and batch numerical
tolerances must be typed configuration with defaults recorded in receipts.
Remaining choices that need an explicit configuration decision: the minimum
evidence-negative count, scalar tolerances and cluster noise-label convention
for each task; this design does not infer them from absent task instructions.
