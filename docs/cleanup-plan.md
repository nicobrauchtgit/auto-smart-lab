# Cleanup plan and decisions

Started 2026-10-07 from a code review that read only code, not docs. This file
records the decisions and tracks the work. Tick items off as they land.

## Decisions

| # | Decision | Date |
|---|---|---|
| D1 | The `id` rule stays a prompt rule. The harness also gets a canary that is silent unless a pipeline actually reads the ID; only then does the agent get a message (see [Canary](#id-leakage-canary)). | 2026-10-07 |
| D2 | Keep a held-back set, size it by data size instead of a fixed 10%, and score the frozen champion on it exactly once (see [Held-back confirmation](#held-back-confirmation)). | 2026-10-07 |
| D3 | Remove dead code from earlier generations only after the uncommitted current work is committed, so the cleanup is one separate, revertible commit. | 2026-10-07 |
| D4 | The harness takes work off the agent by measuring and offering primitives, never by restricting what the agent may build. Restrictions are only allowed where they protect evidence integrity (who fits, which rows are held back, what counts for promotion). Anything that would lock the agent out of solving a task is a bug. | 2026-10-07 |
| D5 | Test inputs stay easy to reach for the agent: comparing test against training data is explicitly allowed. Isolation hides labels and held-back rows, not test inputs. | 2026-10-07 |
| D6 | Drop the hand-written Naive Bayes (`agent/smartlab/tasks/spam1.py`) with the rest of `agent/smartlab/`. | 2026-10-07 |
| D7 | No promotion on chance: a challenger replaces the champion only when its paired lead over the champion exceeds noise (section 4b). | 2026-10-07 |
| D8 | Drop the memory-file submission counter (`agent/run/memory_utils.ts`, the `agent/tools/memory.ts` tool and the `agent/memory/memory.json` gitignore entry) and the scaffold generator (`agent/run/scaffold.ts`). The submission ledger and the agent-written entrypoint replace them. | 2026-10-07 |
| D9 | No harness data loader. The agent's code reads samples; the harness owns sample identity, folds, fits and scoring. | 2026-10-07 |
| D10 | Keep the generic `experiment_*` tools as the escape hatch for work that fits no harness kind. | 2026-10-07 |
| D11 | Order: cleanup (sections 0-2) first, then the modular harness (section 6). Experiments will run on the SmartLab VM. | 2026-10-07 |

## Open decisions

- [ ] `agent/subagents/` (~770 lines, used only by its own smoke test): wire into the orchestrator, or delete?
- [ ] `agent/tools/{smartlab,challenge_context}.ts` pi extensions (loaded by `.pi/settings.json` for interactive `pi` and by the legacy sessions): keep or delete? (`memory.ts` is decided: drop, D8.) The `smartlab_submit` tool there uploads without the new submission accounting. `agent/tools/web_search.ts` is live (the research stage loads it by path) and stays.
- [ ] `agent/instructions/`: no code references it any more. Delete now, or wait as AGENTS.md says?
- [ ] Doc sprawl in `docs/` (WIP, HANDOVER, several plans) describes earlier generations. Consolidate after the code cleanup?

## Todo

### 0. Prerequisites (done 2026-10-07)
- [x] Commit the uncommitted current work (`6496825`).
- [x] Make Python runnable inside Devbox (`21a3e8e`): `stdenv.cc.cc.lib` and `zlib` in `devbox.json`, their store directories exported by the Devbox shell; `resolveCppRuntimeLibraryPath` checks that `libstdc++.so.6` and `libz.so.1` are actually reachable; the health check imports the declared compiled packages (numpy, scipy, sklearn, pandas).
- [x] Native libraries listed once in `agent/runtime/python/native-libraries.json`, read by the Devbox hook (`python_environment.py library-path`) and the training environment. `add`/`update` import every new or changed distribution and report a missing system library (`installed_import_failure` in `changes.jsonl`, non-zero exit, package stays installed). Background: the Devbox Python is Nix-built, so the host's nix-ld libraries do not apply to it.
- [x] Tests green: `bun test` and all four `test:py` suites. (`test:py` chains the suites with `&&`, so the first failing suite had hidden the rest; it did not only collect `agent/solve/tests`.)

### 1. Remove dead code (generations 0-2) (done 2026-10-07)
- [x] `npm run solve` and `agent/run/orchestrate.ts`, `solver_session.ts`, `eval_session.ts`, `submit_session.ts`, `scaffold.ts`, `memory_utils.ts`.
- [x] `agent/smartlab_agent.py`, `agent/smartlab/`.
- [x] `agent/tools/memory.ts`, its prompts in `tools.json`, its entries in `.pi/settings.json` and `EXTENSION_PATHS`, and the `.gitignore` line (D8).
- [x] `agent/run/solve_session.ts` (+ test).
- [x] `agent/solve/{iteration,canary,champion,corpus,entrypoint}.py`, `agent/solve/results.ts`, their tests, `iterationSeed`.
- [x] `libs/smartlab-eval`: `metrics.py`, `results.py` (`corpus.py` kept). `threshold_sweep` is recoverable from `6496825` for item 4b.
- [x] `agent/setup/`: `fetch_units.py`, `submit.py`, `smartlab_submit.py`, `load_challenge.py`; the `environment/` folder and its `.gitignore` lines.
- [ ] Deferred: `agent/setup/inspect_lab_data.py` and its dependency `fetch_lab.py` stay until their service/endpoint detection moves into `fetch_unit.ts` (4b).
- [x] Prompts: `solver.*`, `evaluation.*`, `solve.iteration`, `submission.system`.
- [ ] Deferred: the `context.*probe*` prompts belong with the open `agent/subagents/` decision.
- [x] Stale `devbox.json` scripts removed; `devbox run test` runs `bun test` and `bun run test:py`.
- [x] `test:py` no longer runs the removed `agent/solve/tests`.
- [x] READMEs updated: `agent/solve`, `agent/setup`, `agent/prompts`.

### 2. Merge duplicates (done 2026-10-07)
- [x] `agent/solve/convergence.py` moved into `smartlab_trial/convergence.py` (no more loading by file path); its tests are `agent/training/python/test_convergence.py`.
- [x] ~~Remove the unused generic `experiment_*` tools~~ Keep them (D10): they are the escape hatch for work that fits no harness kind. Wiring them into the agents belongs to item 6.
- [x] `RUN_OUTPUTS` / `archivePreviousRun` removed from `agent/solve/workspace.ts`.
- [x] `createStratifiedFolds` moved into `agent/solve/folds.ts`; `agent/pipeline/feature_audit.ts` deleted.

### 3. ID leakage canary
- [ ] Implement as described [below](#id-leakage-canary).

### 4. Held-back confirmation
- [ ] Implement as described [below](#held-back-confirmation).

### 4b. Recovered from the dead code (proposed, not yet decided)
- [ ] **Champion promotion ignores noise.** The old loop replaced the champion only
  when the paired bootstrap interval of the difference cleared zero. The live rule
  in `agent/training/service.ts` (champion tagging) promotes on any
  `meanDifference > 0`; `leadExceedsNoise` is computed in
  `smartlab_trial/search.py` but never used. Require it (or a bootstrap interval)
  for promotion.
- [ ] **Two selection rules can disagree.** `developmentSelection` and
  `collectTrainingResults` pick the highest raw CV mean; the champion tag uses the
  paired rule. Solve can return a `training_selected_result` that is not the
  champion, and refit then rejects it ("Chosen champion differs from
  controller-supplied reviewed evidence"). Make selection read the champion tag.
- [ ] **Threshold diagnostic.** `smartlab_eval.metrics.threshold_sweep` (removed in the cleanup; recover from `6496825`) reported
  balanced accuracy at the best threshold vs. the default. Add this to
  `agent/evaluation/diagnostics.py` as a report-only number (it matters for
  imbalanced tasks such as webspam, ~16% positive); the agent can then build
  threshold tuning into its pipeline. Per D4 this is a measurement only; the
  harness never applies a threshold itself.
- [ ] **Local services and API endpoints.** `agent/setup/inspect_lab_data.py`
  detected `http://127.0.0.1:<port>` services, `/api/...` endpoints and non-zip
  downloads (pcap, csv, json) in task pages. The TS fetcher records none of these.
  Carry the detection into `fetch_unit.ts` / the task descriptor (item 6) before
  deleting the script.
- [ ] **No clashes with a task's localhost service.** At least one task needs the
  agent to talk to a service on localhost. Ports the project already uses: Postgres
  on 55433 (`AGENT_DATABASE_PORT`), the trace dashboard on 3001 (`npm run traces`).
  Needed: the task descriptor records the service's host and port; preflight
  checks the port is free or held by the expected service and fails with a clear
  message otherwise; project ports stay configurable; a per-port run lock stops two
  runs from starting the same service; the service runs outside the agent's and
  training workers' process groups so harness cleanup cannot kill it. Revisit with
  the actual task page before implementing.
- [ ] **Default extension list.** `EXTENSION_PATHS` in `agent/run/session_runner.ts`
  loads the submit, memory and challenge tools into any session that does not
  override it; only legacy callers rely on that. Make the default empty when the
  legacy sessions are removed.
- [ ] **One-task workspace.** Reuse the idea of Gen 0's `environment/` (only the
  current task visible) for the isolation item in section 5, but per D5 the test
  inputs are part of the workspace from the start, not "on request". Hidden:
  the full labels file, extracted full training files, the held-back IDs and
  other tasks. The old loader itself is not needed.

- [ ] **Pipeline-quality signals for the solve agent.** Today a finished trial
  reaches the agent as one `balancedAccuracy` number in the leaderboard
  (`TrainingService.leaderboard`). Reuse measurements from the removed
  `smartlab_eval.metrics` (recover from `6496825`) on the harness's own OOF
  predictions and show them in the trial result and leaderboard:
  - per-fold spread and the paired interval against the champion
    (`paired_bootstrap`): is the lead real (shares the rule with D7);
  - per-class recall and confusion: which class it fails on;
  - ROC AUC / average precision: ranking quality independent of the threshold;
  - `threshold_sweep`: balanced accuracy at the best threshold vs. the default
    (report only, per D4);
  - `calibration`: whether scores mean what they say;
  - corrected vs. introduced errors against the champion (already computed in
    `smartlab_trial/champion.py`, not shown to the agent);
  - convergence (`reachedLimit`, already collected) and fit time.
  Binary-only today; the modular harness (item 6) selects which apply per kind.

### 4c. Tracing: dashboard vs. Langfuse
- [ ] Langfuse is not wired into the pipeline yet: the only Langfuse code is a
  connectivity smoke test in `runs/langfuse-smoke/` (untracked). Pipeline traces
  go to Postgres (port 55433) plus local JSONL, and `agent/dashboard/` is the only
  viewer. Build a Langfuse exporter in `agent/observability.ts` first; then delete
  `agent/dashboard/`, `npm run traces` and the Next/React/Tailwind dependencies,
  and decide whether Postgres is still needed.

### 4d. Tool sets per agent
Current state (built-in pi tools, custom tools, file extensions):

| Agent | Built-in | Custom | Extensions |
|---|---|---|---|
| research | read, grep, find, ls, edit, write, bash | knowledge_search/read/capture | web_search |
| solve | read, grep, find, ls, edit, write, bash | experiment_start/status/output/stop/resume, knowledge_* | none (+ in-process git history guard) |
| evaluate | none | evaluation_detail/report/code, knowledge_* (only when a seed plan exists) | none |
| orchestrator | none | pipeline_status, pipeline_wait, pipeline_finish, stage_start/status/feedback/cancel, artifact_inspect | none |
| default (any caller that sets nothing; today only the legacy sessions) | pi defaults | none | smartlab_submit, memory_*, list/read_challenge, web_search |

- [ ] Decide the default: empty, with each agent declaring its tools explicitly.
- [ ] Review per agent what it is missing (per D4). Open questions: should solve
  get `web_search` (looking up a library or method mid-solve)? Should research or
  solve get a tool for a task's localhost service? Should the orchestrator get
  read-only knowledge search?
- [ ] Keep the per-agent tool sets in one registry, so adding a tool means one
  entry plus its prompt and its setup check.
- [ ] The eight orchestrator tools share a single description
  (`orchestrator.tool`); give each its own.

### 4e. Verify against the online tasks (done 2026-10-07; findings in section 6)
- [x] Read every unit's task pages and check: data formats (beyond zips of text
  files), label/target types, metrics, test-data availability, localhost services
  and their ports, submission formats. Feed the findings into item 6 and the
  localhost item in 4b.

### 5. Bugs and tooling from the review
- [ ] `agent/solve_cli.ts:32` passes `{unitNumber, taskNumber}` to `resolveTask`, which expects `{unit, task}`; `unit 1 task 1` fails as ambiguous.
- [ ] `solve_entrypoint` artifact (`agent/pipeline/stages/solve.ts`) has no sha256, so no provenance.
- [ ] Add `tsconfig.json` + `tsc --noEmit` and a formatter, run from `npm test`; fix the strict-mode errors.
- [ ] Solve agent runs from the project root with read/bash access, so it can read the full labels, extracted training files and `sealed_ids.txt`. Run it in a workspace that cannot see those.

### 6. Next task: a modular harness per task kind
Order: the cleanup (sections 0-2) first, then this.

- [ ] No harness data loader (D9). The harness knows which samples exist, their
  labels or groups if any, the folds and the scoring. Reading a sample (pdf,
  pcap, apk, png, ...) is the agent's code, the first step of its pipeline.
- [ ] Split the harness into swappable parts and let each task declare which it
  uses, choosing from the existing options (hot-swappable, no per-task code):
  - sample source (files in a zip, connections in a pcap, images, none)
  - targets (binary labels, groups/families, none, agent-provided evidence labels)
  - fold scheme (stratified, group-held-out, none)
  - metric (BACC, BACC with missing values, adjusted Rand index, external)
  - submission (CSV + source upload, token from the VM service)
  Reuse the current CV, seeds, supervision and scoring and make them modular
  rather than rewriting them, e.g. CV and scoring that also work for clustering
  and unsupervised detection.
- [ ] The orchestrator chooses the task kind and applies the matching harness
  parts.
- [ ] Kinds known from the lab (verified on the task pages, 2026-10-07):
  supervised file classification (units 1, 2), clustering with unseen test
  families (unit 3), unsupervised detection (unit 4), interactive attack or
  defence against the VM service (units 5, 6).
- [ ] Escape hatch: the generic `experiment_*` tools (D10) run any command
  under harness observation when nothing fits.
- [ ] PyTorch support (units 5, 6): an observed script with a `report()` helper
  writing to `events.jsonl`, harness-owned seeds, checkpoints and resume;
  harness-owned robustness measurement (clean, FGSM, PGD accuracy) for unit 6.
  Unit 6 requires a differentiable `torch.nn.Module`.
- [ ] Runs on the SmartLab VM (the lab service is `127.0.0.1:8000` there).
  Before designing: inventory the VM (CPU/RAM/GPU/disk, Python, Nix/Devbox,
  outbound access to the model API, Tavily and Langfuse, ports in use, the lab's
  Python template and its torch version), then choose between everything on the
  VM or agents here with training workers on the VM over SSH.
- [ ] Safety: units 2 and 3 contain real malware. Nothing may open or execute
  samples outside analysis code, and external detection services are forbidden
  by the lab rules.
- [ ] Task 4.1 already has one counted attempt (score 0.0, 2026-08-13) from the
  old pipeline; make sure the submission ledger accounts for it.

---

## ID leakage canary

**Problem.** Training member IDs end in `.0` / `.1`, which is the label; test IDs
end in `.x`. A pipeline that reads the ID scores ~1.0 in CV, wins selection
automatically, and is worthless on the test set. The prompt forbids it; the
canary catches the case where the agent ignores the prompt.

**Check (no extra fit).** In `_run_fold` (`agent/training/python/worker.py`),
after the normal validation predictions, predict again on the same fitted
estimator with the validation frame's IDs rewritten to the neutral test form
(`smartlab_eval.corpus.NEUTRAL_SUFFIX`) and compare. Cost: one extra `predict`
per fold. Search folds use the same path. Compare the scores
(`predict_proba` / `decision_function`) as well as the labels: where the text
alone already separates the classes, a leaky pipeline can predict the same labels
while only its scores move (lesson from the removed generation-2 canary).

**On a match:** nothing. No event to the agent, no change to the trial.

**On a mismatch:**
- The fold result records `idLeakage: {rows, mismatches}`; the trial is written
  with `promotionEligible: false` and reason `id_leakage`, so it can never become
  champion. `agent/training/results.ts` rejects any eligible trial that carries
  the flag.
- A trace event `training_id_leakage` with the experiment ID.
- One message to the agent through the supervisor, rendered from a new prompt
  `training.id-leakage`: the extension encodes the training label, test files do
  not have it, so the feature cannot help on the submission and the trial was
  excluded from promotion.

**Limits.** It does not catch a pipeline that uses the ID only while fitting,
but such a pipeline cannot carry the label into its predictions.

**Tests.** A fixture pipeline that reads `id` is flagged, made ineligible and
produces exactly one agent message; a text-only pipeline produces no message and
no event.

---

## Held-back confirmation

### Why

CV is used for selection: every trial and every search configuration is ranked
on the same CV rows, so the best CV score is optimistic. Nested CV is not
practical because the agent itself is the outer selection loop. The standard
answer is CV for selection plus one untouched set for the final estimate, used
once.

Today 10% is withheld (`solve.sealedFraction`), never scored, and added back at
refit. A fixed fraction is also wrong in both directions: what sets the
precision is the number of rows in the smallest class, because balanced accuracy
averages per-class recalls.

| Task | Rows | Smallest class | 10% gives smallest class | ± on balanced accuracy* |
|---|---|---|---|---|
| spam1 | 16,662 | 8,302 | ~830 | ±0.7% |
| spam2 | 18,756 | 5,682 | ~570 | ±0.8% |
| webspam | 3,561 | 554 | ~55 | ±2.5% |

\* about 90% recall per class; better models give smaller errors.

### Sizing rule

Configured in `harness.config.json`, replacing `solve.sealedFraction`:

```json
"holdout": {
  "targetSmallestClassRows": 200,
  "minSmallestClassRows": 50,
  "maxFraction": 0.2
}
```

1. `fraction = targetSmallestClassRows / smallestClassCount`.
2. If `fraction <= maxFraction`: hold back that fraction. Precision: `target`.
3. Otherwise hold back `maxFraction`. If that still gives at least
   `minSmallestClassRows` in the smallest class, precision is `reduced`.
4. If it gives fewer, hold back nothing. Precision is `none`: solve uses repeated
   CV only, and the run states that no independent estimate exists instead of
   reporting a noisy number.

The draw takes the same fraction from every class (stratified, exact per-class
counts rounded half up), seeded by `sealedSeed` from the seed plan
(`agent/training/seeds.ts`) so it is identical across runs of the same task and
dataset. This replaces `sealConfirmationSet` in `agent/solve/folds.ts`, which
approximates the fraction with `round(1 / fraction)` folds.

Resulting held-back sets:

| Task | Held back | Smallest class held back | Precision |
|---|---|---|---|
| spam1 | 2.4% (~400 rows) | 200 | target |
| spam2 | 3.5% (~660 rows) | 200 | target |
| webspam | 20% (~710 rows) | ~110 | reduced |

### Flow

1. **Solve setup** (`prepareSolveWorkspace`): apply the sizing rule; record
   `holdout: {rows, perClass, fraction, precision, sha256}` in the workspace,
   the `solve_workspace_prepared` event and the seed plan. The agent prompt keeps
   stating only the development row count and class balance.
2. **Agent session:** unchanged. The agent never sees held-back rows or scores.
3. **Confirmation (new, harness-owned, after the agent session closes):** take
   the selected champion (`developmentSelection`, the champion tag), check out
   its commit, build its fixed pipeline with a harness seed, fit on all
   development rows, predict the held-back rows. Reuse the refit worker's
   loaders and the supervisor's process ownership, as `agent/refit/` does. The
   ID canary runs here too.
4. **Result:** `holdout-confirmation.json` next to the training root, with
   experiment ID, commit, tree, holdout sha256, metrics (`_measure`:
   balanced accuracy, per-class recall, confusion matrix), a 95% stratified
   bootstrap interval, the champion's CV mean, the gap `cv - holdout`, the
   precision tier and `readCount`. Returned as solve artifact
   `holdout_confirmation`; solve summary adds `holdout_balanced_accuracy` and
   `holdout_gap`.
5. **Consumers:** evaluate adds it to its evidence and review prompt; the
   orchestrator status shows it next to the CV score. A gap larger than the
   interval is flagged as likely selection overfit. Advisory only; it does not
   block refit or submission by itself.
6. **Refit:** checks that the frozen champion matches the confirmed experiment
   ID and commit, then trains on all labelled rows including the held-back ones
   (unchanged).
7. **When precision is `none`:** step 3 is skipped and the artifact records
   `precision: "none"` with the reason.

### Keeping it single-use

The held-back set stays fixed per task and dataset, so a later solve run
re-reads the same rows. Every confirmation increments a per-task ledger
(`runs/<task>/holdout-ledger.json`), and `readCount` is shown wherever the
score is shown, so its reliability visibly decays. The score is never passed
into solve prompts or guidance.

### Code touched

- `harness.config.json`, `agent/harness/config.ts`: new `holdout` block; remove
  `solve.sealedFraction`.
- `agent/pipeline/stages/solve.ts`: drop the `sealedFraction` option; add the
  confirmation step and artifact.
- `agent/solve/folds.ts`, `agent/solve/workspace.ts`: sizing rule and exact
  stratified draw.
- `agent/run/harness_solve_session.ts`: run confirmation after the session;
  report inputs/events.
- New `agent/training/python/confirm.py` (or a `confirm` mode of
  `agent/refit/worker.py`) plus a TS runner beside `agent/refit/service.ts`.
- `agent/evaluation/evidence.ts`, review prompts, `agent/orchestrator/coordinator.ts`
  status: show the result.
- `agent/refit/service.ts`: check the confirmed identity.

### Tests

- Sizing rule produces the three tiers and the table above for the three
  current tasks' class counts.
- The draw is deterministic for a fixed seed and dataset and independent of
  labels-file order.
- Confirmation fits on development rows only and predicts exactly the held-back
  IDs; it refuses a champion whose commit differs from the tag.
- No held-back score appears in any solve prompt, guidance or agent message.
- Refit rejects a champion that differs from the confirmed one.
- `precision: "none"` skips confirmation and records the reason.
