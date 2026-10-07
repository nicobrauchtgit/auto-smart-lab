# Pipeline versioning and hyperparameter search

Status: implemented with deterministic local acceptance coverage, 2026-10-05.
The five delivery phases below are wired into the registered solve path. It extends the [harness-owned training contract](harness-owned-training.md).

The solve agent already builds pipelines, starts harness-owned trials, and
watches them. The harness now preserves the code behind measured results and tests
hyperparameters within one experiment, reporting parameter effects and measured
cost. The implementation keeps
the division of work: the agent designs, the harness executes and
explains.

## Decisions

| Topic | Decision |
| --- | --- |
| Code versioning | `solutions/` is its own git repository. The agent commits, branches, and writes messages. |
| Harness check | `experiment_start` requires a clean `solutions/` tree and records the commit it runs. |
| Trial isolation | Each trial runs from a `git worktree` of its commit, not from the live folder. |
| History protection | Commands that rewrite or delete history are blocked with an explanation. No mirror. |
| Search | One `experiment_start` may carry a search space. The harness runs it as an Optuna study. |
| Budget | A search counts as one experiment, regardless of how many configurations it tries. |
| Transparency | Live per-configuration events and a final report that explains which parameters mattered. |
| Promotion | A search winner is never promoted directly. It needs a confirmation trial on fresh folds. |
| Runtime | The harness projects cost from measured fit times and stops for an explicit acknowledgement above a threshold. |
| Confirmation | The solve agent acknowledges expensive searches. The orchestrator takes this over once it exists. |
| Validation | Every request is validated before any fit, and every rejection states exactly what is wrong and how to fix it. |

## Pipeline versioning with git

### Repository

`solutions/` becomes an independent git repository. The project repository
already ignores `/solutions/*`, so the two never mix, and the solutions
repository keeps working if the project's own git is later removed for
production runs. Solve setup initializes the repository if it is missing and
commits any existing files as the starting point.

The agent owns the history. It commits each pipeline change with a message
describing the idea, and it may use branches for competing approaches, such as
`char-ngrams` or `random-forest`. The solve prompts tell it to commit before
starting an experiment and explain that commit messages appear in the
leaderboard.

### Check at experiment start

`experiment_start` accepts an optional `commit` (default: `HEAD`). Before
anything else runs, the harness checks that:

1. `solutions/` is a git repository;
2. there are no staged, unstaged, or untracked non-ignored files; and
3. the requested commit exists.

The check is "everything is committed", not "there is a new commit". Rerunning
the same code with different parameters needs no new commit. A rejection lists
the uncommitted files and says to commit them first.

The trial record stores the commit hash, tree hash, branch (if any), and commit
subject. Results, reports, and the leaderboard show these, so a score always
traces back to the exact code and its stated intent.

### Worktree per trial

The worker does not run from the live `solutions/` folder, because:

- a search can run for a long time while the agent keeps working, including
  switching branches;
- scikit-learn's parallel workers (`n_jobs > 1`) re-import the agent's modules
  from disk, so they would load whatever is checked out at that moment; and
- two trials on different branches cannot share one folder.

The harness instead runs `git worktree add --detach` for the trial's commit at
`<trial>/source/solutions`, and the worker puts `<trial>/source` on its import
path. Module paths and imports such as `solutions.tasks.spam1` therefore behave
exactly as in the live tree. The worktree is removed when the trial ends; the
commit stays in the repository.

The harness tags every completed promotion trial `trial/<experimentId>` and
maintains a `champion` tag. Recovering a champion is a checkout. Comparing
champion and challenger is a `git diff`. A future terminal refit must use a
worktree of the champion's commit; terminal refit is not implemented by this delivery.

### Blocking history rewriting

A Pi `tool_call` hook in the solve session blocks shell commands that rewrite
or destroy history:

- rewriting commits: `reset --hard` or `--keep`, `commit --amend`, `rebase`,
  `filter-branch`, `filter-repo`, `push --force`;
- deleting references: `branch -D`, `tag -d`, `update-ref -d`; and
- destroying recovery data: `reflog expire`, `gc --prune`, removing `.git`.

Committing, branching, checking out, merging, reverting, creating tags, and
reading history remain allowed. A blocked call returns why it was blocked and
the allowed alternative, for example: "History is evidence for measured trials.
Use `git revert <commit>` to undo a change." The block guards against mistakes;
it is not a security boundary. The block reasons live in `agent/prompts/` like
other runtime instructions.

## Hyperparameter search

### Request

`experiment_start` keeps its current fields and gains an optional `search`
block:

```json
{
  "schemaVersion": 2,
  "hypothesis": "Deeper trees and more estimators help the minority class",
  "commit": "HEAD",
  "pipeline": {
    "module": "solutions/tasks/spam1.py",
    "factory": "build_pipeline",
    "parameters": {}
  },
  "search": {
    "space": {
      "model__n_estimators": { "type": "int", "low": 100, "high": 800, "step": 100 },
      "model__max_depth": { "type": "int", "low": 4, "high": 40, "log": true },
      "model__max_features": { "type": "categorical", "choices": ["sqrt", "log2", 0.3] },
      "factory.features": { "type": "categorical", "choices": ["word", "word+char"] }
    },
    "sampler": "tpe",
    "maxConfigs": 40,
    "pruning": true
  },
  "cv": { "kind": "builtin", "scheme": "stratified_kfold", "folds": 5, "repeats": 1 },
  "scope": { "kind": "pilot", "maxRows": 4000 }
}
```

- Plain names target pipeline parameters through `set_params`, for example
  `model__max_depth`.
- Names prefixed `factory.` are merged into `context["parameters"]` for the
  factory, so features and other structural choices can be searched too.
- Search types are `int` (`low`, `high`, optional `step` or `log`), `float`
  (`low`, `high`, optional `log`), and `categorical` (`choices` of JSON
  scalars).
- Samplers are `tpe`, `random`, and `grid`. `grid` requires a finite space and
  ignores `maxConfigs` if the grid is smaller.
- `pipeline.parameters` holds fixed factory values. A request without `search`
  behaves exactly like today's single-configuration trial.

### Execution

The harness owns the study; Optuna proposes configurations through
`ask()`/`tell()` and never owns folds, fits, metrics, or cancellation.

- The fold manifest is materialized once. Every configuration is evaluated on
  the same folds, so all comparisons inside a search are paired.
- The sampler seed and each configuration's estimator seeds come from the seed
  plan. Search uses a canonical search-v1 coordinate containing the resolved
  commit, pipeline, CV, scope and search settings, combined with root seed, task
  and dataset. Hypothesis prose and runtime acknowledgement do not change it.
  Unique experiment IDs remain in every artifact. Identical searches reproduce
  configurations and folds; single trials retain experiment-specific entropy.
- Fold scores are reported to the study as intermediate values. With `pruning`
  enabled, a median pruner stops configurations that are clearly behind after
  enough folds. Pruned configurations are recorded with their completed folds
  and the reason.
- The study is stored with Optuna's journal file storage in the trial
  directory, so it can be inspected and continued by the worker after interruption.
  A JSON checkpoint retains fold measurements and the top two OOF sets.
  Seeded ask/tell replay restores sampler state; abandoned uncheckpointed
  configurations remain failed evidence rather than being silently refitted.
- Pilot scope applies to the whole search: fewer rows or folds make every
  configuration cheaper.

### Budget

A search is one experiment against the solve budget (`maxIterations`). Its
cost is governed by `maxConfigs` and the runtime guard below, not by the
experiment count.

### Artifacts

Each search trial writes, alongside the existing artifacts:

| File | Contents |
| --- | --- |
| `configs.jsonl` | One line per configuration: ID, parameters, status, fold scores, mean, standard deviation, fit time, convergence information |
| `search-report.json` | The explanation described below |
| `study.journal` | Optuna's study storage |
| `oof_predictions.csv` | Out-of-fold predictions for the best configuration |
| `oof_runner_up.csv` | Out-of-fold predictions for the runner-up, for error comparison |

Fold-level metrics are kept for every configuration. Row-level predictions are
kept only for the top two to bound storage.

## Transparency

The agent should understand what happened without guessing, while the harness
does the work.

### While running

The existing live updates carry, for every fold result, the configuration ID
and its parameters, fold score, fit time, and convergence information from
`agent/solve/convergence.py`. Configuration start, completion, and pruning are
separate events. The running best and the projected remaining time are
included in coalesced updates.

### Final report

`search-report.json` and its summary in the tool result contain:

- **Leaderboard:** each configuration's parameters, mean score, spread across
  folds, fit time, and status, with its commit and branch.
- **Parameter importance:** which parameters explain the most score variation,
  using Optuna's importance evaluator.
- **Parameter effects:** mean score and fit time per value or range of each
  parameter, for example "max_depth above 20: no score gain, 3x fit time".
- **Best versus runner-up and champion:** per-fold score differences, how many
  folds favor each, and whether the lead exceeds the fold-to-fold noise.
- **Progress:** best score by configuration count, showing whether more
  configurations are likely to help.
- **Cost:** total time, time per fit, and which parameters drive fit time.
- **Caveats, stated in the report itself:** importance estimates from few
  configurations are unreliable; the best of many configurations is
  optimistically biased; and the score is not a test-set estimate.
- **Next step:** the exact fixed-parameter request for a confirmation trial of
  the winner.

## Selection and confirmation

The winner of a search is selected on the same folds that scored it, so its
score is biased upward. A search trial is therefore never promotion-eligible.
To promote the winner, the agent starts a confirmation trial with the winning
configuration as fixed parameters and promotion scope. The harness runs it on
a fresh fold manifest, and that trial is what can become eligible.

Comparing a confirmed challenger with the champion follows the existing plan:
the harness reruns the champion's commit on the challenger's manifest and
reports paired differences.

## Runtime guard

- **Projection:** configurations × folds × measured time per fit. The
  measurement comes from the most recent pilot of the same commit and pipeline,
  or else from the first configuration of the search itself.
- **Threshold:** `harness.config.json` gains `search.confirmAboveSeconds`. If the
  projection exceeds it and the request does not carry
  `acceptEstimatedSeconds` covering the projection, the search stops
  gracefully after the first configuration. It then returns the projection,
  what drives it, and how to reduce it (fewer configurations, a pilot scope, or
  a narrower range for cost-driving parameters). Completed work is kept.
- **Drift:** fit time varies with parameters such as `n_estimators`. The
  projection is updated as configurations finish. If it exceeds the accepted
  amount by more than `search.overrunFactor` (default 1.5), the search stops
  gracefully with the same explanation.
- **Hard cap:** `search.maxSeconds` ends any search gracefully, regardless of
  acknowledgement.

The solve agent sets `acceptEstimatedSeconds`. Once the orchestrator exists,
this acknowledgement moves to it.

## Validation

Every request is validated before any fit and before it counts against the
budget. Validation reports all problems at once, never only the first.

### Layer 1: request structure

- Known keys only, at every level.
- `int` and `float`: finite numbers, `low < high`, `log` only when `low > 0`,
  `step > 0` and dividing the range for `int`.
- `categorical`: a non-empty list of distinct JSON scalars.
- Caps: number of searched parameters, choices per parameter, `maxConfigs`,
  nesting depth and size of fixed parameters, and the size of a `grid`.

### Layer 2: against the real pipeline

A short validation run in Python, bounded in time, builds the pipeline from the
requested commit's worktree and checks:

- every plain name exists in `get_params(deep=True)`;
- `factory.` names are accepted by the factory, which receives them through the
  context; and
- scikit-learn's own parameter constraints accept boundary and sampled values
  (`low`, `high`, every choice), using `set_params` and the estimator's
  parameter validation, without fitting.

### Error format

Each error names the field, the problem, what was received, what is expected,
and a concrete fix:

```json
{
  "path": "search.space.model__max_depht",
  "problem": "not a parameter of the pipeline",
  "received": "model__max_depht",
  "expected": "a name from the pipeline's get_params()",
  "hint": "Did you mean model__max_depth? Parameters of step 'model': max_depth, max_features, min_samples_leaf, n_estimators, ..."
}
```

```json
{
  "path": "search.space.model__max_features.choices[2]",
  "problem": "rejected by RandomForestClassifier",
  "received": 1.5,
  "expected": "'sqrt', 'log2', None, an int >= 1, or a float in (0.0, 1.0]",
  "hint": "Use a fraction such as 0.5, or an integer feature count."
}
```

Scikit-learn's own message is included verbatim alongside the explanation. The
agent should never have to guess why a request was rejected.

## Setup, prompts, and observability

- **Dependencies:** add Optuna through
  `agent/setup/python_environment.py add optuna --reason <reason>`. The solve
  stage's setup requirements check that Optuna imports and that `git` is
  available, before any agent session starts.
- **Prompts:** update `training.start-tool` with the search fields, commit
  rule, and confirmation flow. Add the git workflow to the solve prompts and
  the block reasons as separate prompt files. Nothing is hardcoded in runners.
- **Observability:** the commit and tree hashes are recorded as supplied
  inputs. Search events and the report artifact carry the shared pipeline and
  invocation IDs.

## Delivery order and acceptance

1. **Git versioning.** Repository setup, clean-tree check, commit recording,
   worktree execution, tags, and the history block. Tests: an uncommitted file
   is rejected and named; a branch switch during a run does not change the code
   it executes; each blocked command returns its reason and alternative;
   allowed commands still work.
2. **Validation.** Both layers, also applied to fixed parameters. Tests: each
   structural rule and each pipeline check produce the documented error shape,
   with a hint; several errors are reported together; rejected requests consume
   no budget.
3. **Search execution and report.** Tests: all configurations share one
   manifest; the same request proposes the same configurations; pruned
   configurations are recorded; a search counts as one experiment; the report
   contains every section above; a search trial is never eligible.
4. **Runtime guard.** Tests: projection above the threshold stops after the
   first configuration with an explanation; an acknowledged projection runs;
   overrun and the hard cap stop gracefully and keep completed work.
5. **Confirmation and champion comparison.** Tests: the report's suggested
   confirmation request runs on a fresh manifest and can become eligible; the
   champion is rerun from its tagged commit on the challenger's manifest.

A live check on spam1 then confirms that the agent commits its work, runs a
bounded search, reads the report, and confirms the winner before promoting it.

## Open questions

- Running several configurations in parallel. The first version evaluates them
  one at a time and leaves parallelism to the estimator's own `n_jobs`.
- Retention of worktrees and per-configuration predictions for very large
  searches.


## Delivered implementation and verification

| Phase | Delivered behavior | Deterministic acceptance coverage |
| --- | --- | --- |
| 1: git | Independent repository setup; clean-tree and revision checks; detached worktrees; commit/tree/branch/subject inputs; promotion/champion tags; prompt-backed Pi history guard. | `git.test.ts`, `git_guard.test.ts`, `versioned_harness.test.ts`: dirty paths, tags, allowed/blocked commands, branch switch during joblib fits. |
| 2: validation | Aggregated structural findings; bounded no-fit construction from frozen worktrees; fixed and searched parameters, boundary/interior/choice checks; sklearn messages and hints; rejected requests consume no budget. | `contract.test.ts`, `validation.test.ts`, `test_validation.py`: rules/caps, multiple errors, fixed factory settings, timeout, typo suggestions and no budget charge. |
| 3: search | Sequential deterministic TPE/random/finite grid ask/tell; one persisted manifest; median pruning; journal/checkpoint recovery; full report; top-two OOF; collected/hashed search artifacts; search never eligible. | `search_harness.test.ts`, `test_search.py`: repeated requests beyond TPE startup, shared folds/seeds, journal continuation, pruning records, report sections, single budget unit and concurrent budget protection. |
| 4: runtime | Pilot or first-config measured projection; acknowledgement; drift/overrun and hard cap; retained measurements and prompt-backed reduction guidance. | Supervised acknowledgement fixture plus fake-clock measured-fit adapter tests for threshold, overrun and hard-cap fold boundaries. |
| 5: confirmation | Exact fixed factory/set_params request at the winning commit; fresh single-trial entropy; isolated interpreter for tagged champion; identical persisted challenger manifest; paired fold and row error differences. An existing champion tag moves only on completed positive paired evidence. | `search_harness.test.ts`: suggested request runs and is eligible; different folds; weaker challenger proves frozen champion imports and paired score; champion tag retained. |

Solve preflight declares `training-optuna` (including journal backend import)
and `training-git`. Missing or invalid prerequisites stop the stage before its
agent starts, with setup events under the shared run/invocation identity.
`setup.test.ts` covers prerequisite checks and executor blocking. Optuna was
added through `agent/setup/python_environment.py`; its declaration, lock and
recorded reason are retained. Tests use the existing `.venv`/`VENV_DIR`.

Runtime instructions are in `agent/prompts/solve` and `agent/prompts/training`,
with git block reasons in `agent/prompts/git`. Existing prompt snapshots and
`noContextFiles` session construction remain in use; legacy
`agent/instructions/` files are unchanged. Worker actions and search events carry
pipeline and invocation IDs. Result artifact schemas remain version 1, and the
existing version 1 manifest/checksum tests continue to pass.

### Precise limitations and deferred work

- Durable service/supervisor recovery is now implemented as described below.
  Pre-recovery experiments without `recovery.json` and checksummed checkpoints
  cannot be automatically upgraded or safely resumed.
- A hard cap is checked at fold/configuration boundaries. An opaque fit can
  finish beyond the cap; process-group stop remains available. Partial configs
  keep measurements in configs/checkpoints; final row predictions are retained
  for completed top-two configurations only.
- Validation does not fit. Custom components without sklearn constraints get
  construction/name/set_params checks only. Factories may ignore unknown context
  keys; the harness cannot infer arbitrary factory semantics. Factory variants
  are checked individually, not as an exhaustive Cartesian product.
- Fresh confirmation means fresh harness entropy. Custom splitters can ignore
  entropy and intentionally return the same partition; the harness preserves
  agent-designed CV semantics.
- CPU/RSS resource sampling currently uses Darwin libproc. Linux still measures
  fit and elapsed seconds for runtime projection. Darwin-only sampling tests
  are skipped on Linux.
- The paid spam1 agent check has not been run. Verification uses deterministic
  local fixtures and harness-owned fits. Terminal all-label refit is delivered separately below; submission
  remains unimplemented. These five phases did not use sealed labels. Configuration
  parallelism remains deferred.


### Verified results (2026-10-05, Linux)

- Full `bun test`: **358 passed, 4 skipped, 0 failed** across 46 files
  (362 tests; 1,085 assertions). All four skips are Darwin-only resource tests.
- Relevant training/pipeline/session/prompt/harness suite: **197 passed,
  0 failed** across 24 files before the additional concurrent-budget test;
  the final full run includes that test and the final validation fixes.
- `bun run test:py`: **123 passed**, comprising solve 79, setup 11,
  training 27, evaluation 6. The final training rerun also passed all 27 tests
  after boundary/interior validation changes.
- Final structural/real-pipeline validation rerun: **64 passed, 0 failed**.
- `git diff --check`: passed. No project commits, resets, stashes or discarded
  changes; fixture repositories live in temporary directories.

Verification used Bun from `.devbox/nix/profile/default/bin` and the project
Python environment with the host's 64-bit GCC/zlib runtime library paths. No
additional Python environment or raw pip installation was used. No paid/provider
agent sessions were run.

## Durable interrupted experiment recovery

The registered solve stage and its standalone executor path call the same
`createHarnessTraining().ready()` before starting an agent. In the task's
`training/` workspace, solve adopts the one interrupted originating run root,
preserving its history and experiment budget. Multiple interrupted roots fail
with their paths instead of choosing silently. If only intentional pauses
remain, the latest unfinished root is opened for observation and explicit
resume, without automatically starting its workers. Finished, deliberately
closed runs with no unfinished work allow a new run root. Direct users of
`TrainingService` call `ready()` (also awaited by `start()` and `resume()`);
optional `recoveryRoots` discover explicitly supplied additional roots.

Each originating training root has a lifetime kernel `flock` claim. Another
service cannot start or recover work there, even in the same process; a crash
releases the claim through the kernel. The per-trial runner holds a second
kernel lock. Atomic, fsynced `recovery.json` records the budget unit/limit,
origin run/invocation, request, source/champion commits, worktrees, dependency
and data fingerprints, worker-framework hash, invocation/seed-plan hashes,
lifecycle, launch token, cumulative runtime and attempt count. The immutable
invocation remains unchanged on resume; explicit cost acknowledgement is a
separate harness document. A launch gate prevents fitting before the controller
has recorded the process and released that specific token. The runner's birth
receipt covers a controller crash between spawning and recording its process.

Linux ownership uses boot ID plus `/proc` start ticks; Darwin uses libproc's
microsecond process birth timestamp. Liveness examines non-zombie processes
throughout the group. PID alone and log silence never authorize restart or a
signal. A verified live runner is reattached for status, resource observation,
log tailing and group control, with no new worker or budget unit. A dead leader
with surviving group members blocks restart. Those unverifiable descendants
are not killed automatically; inspect the recorded group and resolve it before
retrying. Signals require a currently matching leader birth identity.

Worker output goes directly to the append-only log descriptor, so it survives
loss of the supervisor's pipes. Persisted observation byte offsets resume
without truncating logs. Lifecycle/diagnosis/recovery events link the experiment,
origin run/invocation and current recovery run/invocation. Startup diagnostics
queue into the bound agent's opening turn; recovery does not itself start a
provider session. Existing result/report/lifecycle files move into numbered
`recovery-history/` folders before resumed launches; worker event logs and
configuration history remain available.

Unexpected worker death during an active service is detected through the same
identity/group polling and diagnosed to the agent. There are at most two recovery
launches per experiment, including explicit resumes. Normal error exits and
failed results are terminal, avoiding deterministic error loops. Completed
trials, intentional stop/cancellation, acknowledgement/overrun pauses, hard-cap
exhaustion, and service close never start automatically. `experiment_resume`
can reopen eligible intentional pauses or closed work; runtime guard pauses
require `acceptEstimatedSeconds` covering the reported projected total. A
completed/failed experiment, exhausted cap or retry limit cannot resume.

Completed search configurations reuse their checkpoint metrics/predictions and
journal sampler replay. A configuration lost inside an opaque fit becomes
failed and consumes its original configuration slot; remaining configurations
continue without extending `maxConfigs`. A completed journal entry without its
authoritative prediction checkpoint is refused: restore the original checkpoint
rather than fabricate predictions or silently refit it. The saved fold manifest
is loaded directly, including custom CV, instead of recalling the splitter.
Checksum, experiment, seed, row assignments, coverage, overlaps, request identity,
journal consistency and checkpoint structure are checked before any resumed fit.
Malformed, incompatible, legacy or unavailable records produce actionable
restore instructions and a recorded refusal.

Single trials now atomically checkpoint each completed fold together with all
its OOF rows. Recovery retains those folds exactly and fits only subsequent
folds with their original seeds. An incomplete opaque fit has no estimator
checkpoint and is fitted again. Legacy single-trial fold logs without the
prediction checkpoint cannot safely resume. Champion comparison may rerun from
its original commit after recovery; it uses the same persisted challenger folds.

Missing clean worktrees are restored at their recorded candidate and champion
commits. Missing commits, changed trees, unsafe paths, or modified existing
worktrees fail without resetting or discarding their contents. Cleanup likewise
retains altered or still-in-use worktrees. The agent's current branch and dirty
working tree do not change recovered code.

Recovery consumes no additional experiment budget unit and cannot increase the
originating run's recorded experiment limit. Runtime cap and overrun settings
must match the original. The runner persists elapsed worker time every 250 ms;
recovery accumulates that time with the checkpoint elapsed floor and charges one
250 ms uncertainty interval for a missing exit receipt. Downtime is not charged.
Opaque fits can exceed a hard cap until a fold boundary, as before. No resume
changes model parameters, search space, data, folds, seeds, committed source or
hard caps. Dataset/dependency/framework drift must be resolved to the originals,
or evaluated as a new experiment rather than relabelled as recovery.

Shared solve preflight checks process birth identity availability, readable
worker/recovery modules and Python's standard-library `fcntl` locking before
agent startup. No credentials or new Python dependencies are needed. Linux
acceptance is exercised with real local fits and abrupt service/process-group
termination; Darwin birth inspection is implemented but not exercised on Linux.

The Optuna journal also uses a kernel lock with a five-second acquisition bound,
so forced worker death cannot leave a stale symlink lease blocking recovery.
Synchronous rejected/closed-before-launch requests record an uncharged failed
start and cannot be resumed as accepted experiments.

A bounded, isolated Python standard-library metadata probe also checks the live
interpreter version and installed distribution versions on each recovery. This
catches dependency drift during an active session even when its startup
inventory object is unchanged. Unverified inventories cannot resume.

### Recovery verification (2026-10-05, Linux)

- Full Bun suite: **382 passed, 4 Darwin-only skips, 0 failed** (386 tests,
  47 files). Existing search/promotion/versioning, stage, prompt snapshot and
  `noContextFiles` regressions remain covered.
- Final focused recovery/service/preflight/session/prompt rerun: **47 passed,
  0 failed**, including 23 recovery tests. The abrupt-search tests park the
  fourth fit behind a fixture barrier, ensuring interruption occurs inside
  an opaque fit rather than racing a journal append. Real service restarts
  and local worker fits verify live reattachment, dead continuation, candidate
  and champion worktree restoration, single-fold retention, active death
  diagnosis, budget conservation and the agent resume tool.
- Full Python suites: **130 passed** (solve 79, setup 11, training 34,
  evaluation 6). Recovery refusal tests cover corrupted checkpoints,
  inconsistent manifests, partial journals, cumulative hard caps and stale
  legacy symlink locks without fitting.
- `git diff --check`: passed. Verification used the project's Devbox `.venv`
  and Bun, with the host's 64-bit GCC/zlib library paths and Devbox tools on
  PATH. No new environment, package install or paid/provider session was used.
  No project commit, stash, reset or discarded work was performed.

## Terminal selection and source versioning

Terminal all-label refit is now implemented as the registered `refit` stage; see
[the implementation contract](harness-owned-training.md#implemented-terminal-refit).
It uses the chosen champion's tagged commit/tree and fixed measured confirmation
parameters, not a search result, mutable solutions checkout or independently
score-sorted winner. The frozen worktree remains available with the fitted model.
An atomic terminal record in the repository's git common directory guards
training starts, recovery and later promotion. The shared selection lock makes
this boundary explicit across services and worktrees. Existing evidence is
preserved; the terminal identity cannot receive another development fit or
champion replay. Changed code/parameters need new measured validation.

### Terminal refit verification (2026-10-05, Linux)

- Full Bun suite: **392 passed, 4 Darwin-only skips, 0 failed** across 49 files
  (396 tests). Existing stage, session, prompt, search, versioning and durable
  recovery regressions pass.
- Final focused terminal/preflight/standalone suite: **10 passed, 0 failed**.
  Real local fixtures cover frozen source despite live branch changes, full rows
  only after freeze, fixed search confirmation parameters, explicit champion
  selection despite a higher-scoring trial, checked predictions, terminal
  development refusal, idempotent completion, cancellation/retry, live recovery,
  dead opaque-fit recovery, concurrent invocation exclusion, corrupt evidence,
  dependency/data drift and shared executor/preflight behavior.
- Full Python suites: **140 passed** (solve 79, setup 11, training 44,
  evaluation 6). Ten new terminal checks cover complete original coverage,
  duplicate labels/archive IDs, test domain/overlap, development label and content
  drift, freeze-before-fit, fixed parameters, exact prediction coverage/domain,
  model corruption, false completion and optional model serialization.
- A final freeze-event regression and standalone configured-options regression
  were run after the focused suite. `git diff --check` passed.

Verification used the project Devbox Bun and `.venv`/`VENV_DIR`, with 64-bit GCC
and zlib runtime library paths. Cloudpickle was declared through the shared
Python dependency manager; it was already installed transitively, so no installed
package version changed. No separate environment, raw pip, provider/model session,
submission, project commit, stash, reset or discarded unrelated work was used.
