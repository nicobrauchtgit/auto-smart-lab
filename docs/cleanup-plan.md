# Cleanup plan and handover

This is the entry point for any agent or developer picking up work on this
repository. It records the current state, the decisions taken with the user,
what is still open, and the prioritized work queue. Started 2026-10-07 from a
code-only review; last updated 2026-10-08.

Older documents (`HANDOVER.md`, `WIP.md` and the design notes in `docs/`)
describe earlier generations and are historical records. When they disagree
with this file, this file wins.

## Picking this up

1. **Read** this file, then `AGENTS.md` (development rules: stage contract,
   observability, setup checks, prompt management, Python dependencies). The
   module READMEs under `agent/` describe each module.
2. **Set up**, on any Linux machine (x86_64/arm64) with `git`, `zip`, `unzip`
   and `curl` or `wget`:

   ```bash
   cp .env.example .env     # then fill in the keys, see "Environment and access"
   ./dev setup              # pinned mise, bun, uv, Python 3.13 and all dependencies
   ./dev mise run test      # bun test + Python suites
   ```

   Run every project command through `./dev` (e.g. `./dev bun run pipeline --
   spam1 --dry-run`). Never install tools into the user's home, shell
   configuration or Nix profile; everything lives in `.tools/` (D12).
3. **Expected test result:** all green, including without downloaded unit data.
   Four course-data integration tests skip with a fetch instruction when spam1
   data is absent (`./dev bun run fetch-unit -- 01-spam`).
4. **Work conventions:** one work item per commit, tests with every change,
   tick the item off here in the same commit. Do not act on an open decision
   without the user. Ask before anything outward-facing: submissions (3 attempts
   per task, they count), pushes, writes on the SmartLab VM.

## Current state (2026-10-08)

- **Branch** `solve-stage-hardening`, ahead of
  `origin/solve-stage-hardening` (not pushed). Remote:
  `git@github.com:nicobrauchtgit/auto-smart-lab.git`.
- **Tests (2026-10-08):** locally 439 TypeScript tests pass (4 skipped), all
  Python suites pass. Without downloaded spam1 data, four additional integration
  tests skip explicitly. The VM has not received the quick-fix commits yet.
- **Toolchain:** `./dev` + `mise.toml` (bun 1.3.13, uv 0.12.5, ripgrep, fd) and
  uv-managed Python 3.13.15. Devbox is gone (D12).
- **The live pipeline** (`agent/pipeline/registry.ts`): research -> solve ->
  evaluate -> refit, plus a deterministic submit stage that only an explicit
  orchestrator policy may run. Two entry points share one executor:
  `./dev bun run pipeline` (configured chain, never submits) and
  `./dev bun run orchestrate` (decision agent, may submit under policy).
  Solve is harness-owned training: the agent writes `solutions/tasks/<id>.py`
  (`build_pipeline()` returning an unfitted sklearn estimator over an
  `id`/`text` frame) and starts trials through `experiment_*` tools; Python
  workers own folds, seeds, fits, predictions and metrics.
- **Biggest structural limit:** the harness assumes a zip of text files,
  binary `0`/`1` labels and balanced accuracy in the registered task adapters.
  Only unit 1 fits end to end. The training API now supports opaque sample
  manifests and clustering/anomaly measurements; H1/H2 must still connect the
  lab task declarations, research/workspace preparation, evaluation and refit.
- **Official lab attempts:** every task 0 of 3 used, except task 4.1 (1 of 3,
  score 0.0, 2026-08-13). spam1 has two uncounted submissions (2026-08-18,
  scored 0.9645, marked FAILURE).

## Decisions

| # | Decision | Date |
|---|---|---|
| D1 | The `id` rule stays a prompt rule. The harness also gets a canary that is silent unless a pipeline actually reads the ID; only then does the agent get a message (see [ID leakage canary](#id-leakage-canary)). | 2026-10-07 |
| D2 | Keep a held-back set, size it by data size instead of a fixed 10%, and score the frozen champion on it exactly once (see [Held-back confirmation](#held-back-confirmation)). | 2026-10-07 |
| D3 | Remove dead code from earlier generations only after the uncommitted current work is committed, so the cleanup is one separate, revertible commit. | 2026-10-07 |
| D4 | The harness takes work off the agent by measuring and offering primitives, never by restricting what the agent may build. Restrictions are only allowed where they protect evidence integrity (who fits, which rows are held back, what counts for promotion). Anything that would lock the agent out of solving a task is a bug. | 2026-10-07 |
| D5 | Test inputs stay easy to reach for the agent: comparing test against training data is explicitly allowed. Isolation hides labels and held-back rows, not test inputs. | 2026-10-07 |
| D6 | Drop the hand-written Naive Bayes (`agent/smartlab/tasks/spam1.py`) with the rest of `agent/smartlab/`. | 2026-10-07 |
| D7 | No promotion on chance: a challenger replaces the champion only when its paired lead over the champion exceeds noise (work item Q1). | 2026-10-07 |
| D8 | Drop the memory-file submission counter and the scaffold generator. The submission ledger and the agent-written entrypoint replace them. | 2026-10-07 |
| D9 | No harness data loader. The agent's code reads samples; the harness owns sample identity, folds, fits and scoring. | 2026-10-07 |
| D10 | Keep the generic `experiment_*` tools (`agent/experiments/`, `argv`-based) as the escape hatch for work that fits no harness kind. | 2026-10-07 |
| D11 | Order: cleanup first (done), then the modular harness (H1). Experiments, and the agents, run on the SmartLab VM. | 2026-10-07 |
| D12 | Devbox is replaced by mise because the SmartLab VM has no Nix. `./dev` keeps mise (pinned, checksum-verified), its tools, uv's managed Python and all caches under `.tools/`: nothing goes into the user's home, shell configuration or Nix profile. uv owns Python (`.python-version`, `python-preference = "only-managed"`). | 2026-10-07 |
| D13 | The champion tag is the only definition of "best". A higher CV mean counts only after the paired check against the champion shows it exceeds noise; solve, evaluate and refit all follow the tag, also across solve runs. | 2026-10-07 |

## Open decisions (ask the user)

- [ ] `agent/subagents/` (~770 lines, used only by its own smoke test): wire into the orchestrator, or delete? The `context.*probe*` prompts go with it.
- [ ] `agent/tools/smartlab.ts` (an upload tool that bypasses the submission ledger) and `agent/tools/challenge_context.ts`: only loaded by `.pi/settings.json` for interactive `pi`. Keep or delete? (`web_search.ts` is live and stays.)
- [ ] `agent/instructions/`: nothing references it. Delete?
- [ ] Older docs in `docs/` (HANDOVER, WIP, design notes) describe earlier generations. Consolidate or archive?
- [ ] Tool sets (W1): should the orchestrator get read-only knowledge search? Who gets a tool for the lab service on the VM?
- [ ] Run the agents on the VM with a copy of `.env` there? (The VM checkout has no `.env` yet; see "Environment and access".)
- [ ] `~/.local/bin/herdr` on the VM: origin unknown, not from this project. Keep or remove?
- [ ] Recommended, not yet confirmed: build the canary (C1) and held-back
  confirmation (C2) inside the modular harness (H1). The user approved the first
  measurement packet; C3/C5 are implemented in the shared training path.

## Work queue

Priorities: **Q** quick fixes in the live pipeline, **T** tooling, **H** the
modular harness, **C** measurement features for the harness, **W** wiring and
tools, **L** later.

### Q. Quick fixes (small, independent)

- [x] **Q1 Promotion follows noise (D7).** Done: champion tagging in
  `agent/training/service.ts` now goes through `pairedPromotion`
  (`agent/training/promotion.ts`), which requires a completed paired comparison
  against the current champion with `meanDifference > 0` and
  `leadExceedsNoise` (mean > 2 standard errors, from `smartlab_trial/search.py`
  `_paired`); otherwise `training_champion_retained` records the reason. The
  training start-tool prompt states the rule. Tests:
  `agent/training/promotion.test.ts` (rule only; no live-worker test of a noisy
  lead, since the fixture corpus is perfectly separable).
- [x] **Q2 Two selection rules disagree (D13).** Done: `collectTrainingResults`
  no longer selects; `championSelection`
  (`agent/training/development_selection.ts`, replacing `developmentSelection`)
  reads the champion tag, including a champion from an earlier solve run (its
  evidence is read from the training root the tag records and its artifacts join
  solve's hand-off). Solve, evaluate (`evaluation/evidence.ts`, repository taken
  from the trial's recorded source) and `evaluate-stage` use it. Champion
  tagging in `training/service.ts` now compares only the finishing trial
  against an existing champion; before, it always picked the highest raw mean,
  so one unpromoted high-mean trial blocked every later challenger. Tests:
  `development_selection.test.ts` (earlier-run champion handed over, not an
  unpromoted trial with an equal mean), `evidence.test.ts` (evaluate rejects a
  non-champion), `results.test.ts`.
- [x] **Q3 `solve-stage` selector.** Done: `agent/solve_cli.ts` passed
  `{unitNumber, taskNumber}` to `resolveTask`, which expects `{unit, task}`, so
  `unit 1 task 1` failed as ambiguous. It now uses `positionalSelector`
  (`agent/pipeline/resolve_task.ts`), tested in `resolve_task.test.ts`.
- [x] **Q4 Missing checksum.** Done: `entrypointArtifact`
  (`agent/pipeline/stages/solve.ts`) gives `solve_entrypoint` a sha256 and byte
  size, so it gets provenance. The artifact points at the live file, so it is
  handed over only while that file matches the selected trial's commit; once
  edited, solve's summary records `entrypoint_mismatch` instead (the champion
  may come from an earlier run, D13). Test: `stages/solve.test.ts`.
- [x] **Q5 Empty default tool list.** Done: the session runner defaults to
  no file extensions, and `createPipelineResourceLoader` always disables ambient
  extension discovery (project/global settings were loading the upload and
  challenge tools even with `extensionPaths: []`). Only explicit paths and
  in-process guards load. User approved keeping `web_search` explicitly for
  solve as well as research; solve now declares its web-search preflight.
  Interactive `pi` settings stay unchanged. Tests: `session_resources.test.ts`
  covers settings exclusion, empty/omitted/explicit paths and retained guards;
  `harness_solve_session.test.ts` checks solve's path; `run_pipeline.test.ts`
  proves a missing prerequisite from solve's actual requirement list blocks
  the chain before execution.
- [x] **Q6 Ledger vs. lab attempt counting.** Done: read-only official page
  checks confirm production parsing/accounting already follows the lab's counter,
  not row count or presence of a score. Added sanitized seven-column fixtures:
  spam1's two 0.9645 FAILURE rows use 0/3; task 4.1 has one 0.0 SUCCESS and
  two unscored FAILURE rows, using 1/3. Corrected the mock server, which had
  counted failures as consumed attempts. Tests: `submission/transport.test.ts`
  covers both pages; `submission.test.ts` proves a scored failure resolves an
  unknown reservation without consuming a try across restarts, while external
  successes still exhaust the task-global budget. No production change needed.
- [x] **Q7 Tests that need downloaded course data.** Done: the four real
  spam1 integration tests in `research/context.test.ts` and
  `pipeline/stages/solve.test.ts` skip when local spam1 data is absent, with
  the fetch command in each test name. The shared research task/archive
  preflight declaration is now tested separately and always runs. Verified
  those suites both locally with data and in an isolated source copy without
  `units/` (four explicit skips, no failures).

### T. Tooling

- [ ] **T1 Type checking and formatting.** No `tsconfig.json` exists. A strict
  `tsc --noEmit` (with Bun types) reports real errors: `null` vs. `undefined`
  identity IDs, possibly-undefined accesses in `training/service.ts`. Newer
  modules (orchestrator, submission, knowledge, refit, setup) use a dense
  1-space style with lines over 200 characters. Add a typecheck and a formatter
  to `./dev mise run test`, then fix the errors.

### H. The modular harness (next big task, D11)

Lab facts are in [Lab tasks](#lab-tasks-verified-2026-10-07).

- [ ] **H1 Swappable harness parts, declared per task.** No data loader (D9):
  the harness knows which samples exist, their targets or groups if any, the
  folds and the scoring; reading a sample (pdf, pcap, apk, png, ...) is the
  agent's code. Each task picks from existing options, no per-task code:
  - sample source: files in a zip, connections in a pcap, images, none;
  - targets: binary labels, groups/families, none, agent-provided evidence labels;
  - fold scheme: stratified, group-held-out (unit 3: test families are unseen), none;
  - metric: BACC, BACC with missing values, adjusted Rand index, external;
  - submission: CSV + source upload, token from the VM service.
  Reuse the current CV, seeds, supervision and scoring and make them modular,
  e.g. CV and scoring that also work for clustering and unsupervised detection.
  Today's binary assumptions live in `research/startup_context.ts`
  (`TRAINING_LABEL_FILES`, label parser), `libs/smartlab-eval` (loader, labels),
  `smartlab_trial/metrics.py`, `search.py`, `champion.py`, the solve prompt
  (`agent/prompts/solve/start.md`), `solve/folds.ts`, `solve/workspace.ts` and
  `evaluation/diagnostics.py`.
  The training/measurement foundation is now available: controller-declared
  opaque sample metadata, inductive/batch execution, K-fold/group-held-out folds,
  ARI scoring/search/champion comparison and label-free diagnostics. See
  [the first measurement packet](harness-measurements.md). This does not complete
  task declaration, stage adapters, generic terminal refit or submission.
- [ ] **H2 The orchestrator chooses the task kind** and applies the matching
  harness parts.
- [ ] **H3 Escape hatch (D10):** expose the generic `experiment_*` tools to
  agents for work that fits no kind; the harness still observes it.
- [ ] **H4 PyTorch (units 5, 6).** An observed training script with a
  `smartlab_trial.report(epoch=..., loss=..., ...)` helper writing to
  `events.jsonl`; harness-owned seeds, checkpoints and resume; a harness-owned
  robustness measurement (clean, FGSM, PGD accuracy) for unit 6, which requires
  a differentiable `torch.nn.Module`. CPU only (the VM has no GPU); add the CPU
  build of torch through the environment manager when this starts.
- [ ] **H5 Task metadata from the lab.** `agent/setup/inspect_lab_data.py`
  detected `http://127.0.0.1:<port>` services, `/api/...` endpoints and non-zip
  downloads (pcap, csv, json) in task pages; `fetch_unit.ts` records none of
  these. Carry the detection into the fetcher / task declaration, then delete
  `inspect_lab_data.py` and `fetch_lab.py`.
- [ ] **H6 The VM's lab service** (`127.0.0.1:8000` on the VM, units 5 and 6):
  record its address in the task declaration; preflight checks it answers and
  that nothing else holds the port; it stays outside the process groups the
  harness kills during cleanup. The project's own ports (55433 Postgres, 3001
  dashboard) are free on the VM.
- [ ] **H7 Safety.** Units 2 and 3 contain real malware. Nothing may open or
  execute samples outside analysis code; external detection services
  (antivirus, VirusTotal, ...) mean disqualification under the lab rules, so no
  agent tool may call them.

### C. Measurements (specs below; recommended inside H1)

- [ ] **C1 ID leakage canary (D1).** Spec: [ID leakage canary](#id-leakage-canary).
- [ ] **C2 Held-back confirmation (D2).** Spec: [Held-back confirmation](#held-back-confirmation).
- [x] **C3 Pipeline-quality signals for the solve agent.** Done: shared worker
  diagnostics expose per-fold spread, class precision/recall/F1/confusion,
  fold-wise ROC AUC/AP, advisory threshold sweeps, probability provenance,
  calibration bins and Brier/log loss, convergence and fit time through trial
  status and leaderboard rows. Champion corrected/introduced errors and the
  existing rule's explicitly approximate paired interval are visible. Detailed
  diagnostics remain in hashed trial/fold artifacts and survive checkpoint
  recovery. No threshold or promotion rule changes automatically. Tests:
  `python/test_measurements.py`, `measurements.test.ts`, existing training suites.

- [x] **C5 First clustering/anomaly measurement packet.** User approved and
  implemented in the shared training service/worker: clustering ARI, split/merge
  diagnostics, contingency/pair counts and coverage; common-ID partition/ranking
  stability across repeats; anomaly score health and threshold sensitivity.
  Opaque metadata preflight precedes agent code imports; family targets never
  enter unsupervised fit calls; batch clusterers need no `predict`. Label-free
  evidence cannot promote. Clustering search and paired champion reruns use
  batch-scoped ARI, never pooled cluster IDs; cost projections use actual fit
  rows for batch and inductive execution. Scope/limits and deferred research
  options are recorded in [harness-measurements.md](harness-measurements.md).

- [x] **C6 Representation and proxy-search packet.** Added opt-in sampled
  silhouette distributions, Euclidean CH/DB and DBCV, embedding health, and
  inductive prediction strength through one observed additional harness fit.
  Label-free search accepts explicit named proxy objectives and directions;
  proxy scores stay separate from controller metrics and cannot promote.
  Measurement options survive fixed follow-up requests and fold checkpoints.
  Tests: `python/test_geometry.py` and the live measurement integration suite.

- [ ] **C4 Champion vs. unpromoted pipelines, across runs.** The goal is
  knowing what works pipeline-wise: the best pipeline (the champion) plus the
  delta of every other pipeline against it. Each promotion trial already stores
  its paired comparison against the champion (`championComparison`: mean and
  per-fold deltas, noise verdict, corrected/introduced errors), but
  `TrainingService.leaderboard` lists only the current solve run's trials, so
  a later run does not see earlier attempts that lost. Show the history, and add
  an agent that analyses the code and parameter differences between the
  champion and the unpromoted pipelines (from their commits and comparisons)
  and records what helped and what did not, e.g. as knowledge for later solve
  runs.

### W. Wiring and tools

- [ ] **W1 One registry of tools per agent.** Current sets:

  | Agent | Built-in | Custom | Extensions |
  |---|---|---|---|
  | research | read, grep, find, ls, edit, write, bash | knowledge_search/read/capture | web_search |
  | solve | read, grep, find, ls, edit, write, bash | experiment_start/status/output/stop/resume, knowledge_* | web_search (+ in-process git history guard) |
  | evaluate | none | evaluation_detail/report/code, knowledge_* (only with a seed plan) | none |
  | orchestrator | none | pipeline_status, pipeline_wait, pipeline_finish, stage_start/status/feedback/cancel, artifact_inspect | none |

  Adding a tool should mean one registry entry plus its prompt and setup check.
  Open questions are listed under "Open decisions".
- [ ] **W2 Orchestrator tool descriptions.** All eight share `orchestrator.tool`;
  give each its own prompt.
- [ ] **W3 Isolate the solve agent's workspace.** It runs from the project root
  with read/bash, so it can read the full labels file, the extracted full
  training files and `runs/<task>/solve/data/sealed_ids.txt`. Give it a
  workspace with only the current task (D5: test inputs included; hidden: full
  labels, extracted training files, held-back IDs, other tasks).

### L. Later

- [ ] **L1 Langfuse before removing the dashboard.** Langfuse is not wired in;
  the only Langfuse code is a connectivity smoke test in the untracked
  `runs/langfuse-smoke/`. Traces go to Postgres (optional, 55433) and local
  JSONL; `agent/dashboard/` is the only viewer. Build a Langfuse exporter in
  `agent/observability.ts`, then delete the dashboard, `npm run traces` and the
  Next/React/Tailwind dependencies, then decide on Postgres.

## Environment and access

- **`.env`** (gitignored, never print it): `SAIA_API_KEY` (agents),
  `TAVILY_API_KEY` (research web search), `LAB_USER`/`LAB_PASS` (lab website),
  `GOOGLE_CLOUD_*` (optional Vertex provider), `LANGFUSE_*`,
  `SMARTLAB_SSH_HOST`/`USER`/`PASSWORD` (the VM). `./dev` loads it.
- **Lab website:** `https://lab-test.smartlab.mlsec.tu-berlin.de/`, needs the
  OpenVPN tunnel (`lab-vpn.mlsec.tu-berlin.de`) and insecure TLS (self-signed).
  `agent/setup/lab_client.ts` handles login. Unit pages contain "Confidential
  Unit Information" (the SSH password, activation tokens): never commit unit
  intros or prompts (`/units/*` is gitignored for that reason).
- **The VM** (`stud02.smartlab.mlsec.tu-berlin.de`, user `stud02`): Debian 13,
  x86_64, glibc 2.41, 10 vCPUs, 23 GiB RAM, **no GPU** (only QEMU's emulated
  VGA), 21 GB free disk. Has `wget`, `git`, `zip`, `unzip`, `gcc`, `tmux`; no
  `curl`, no `sudo`, no Docker, no Nix. Outbound HTTPS to GitHub, PyPI, npm,
  the SAIA API, Tavily and Langfuse works. Ports in use: 22, 8000 (lab
  service), 8888 (Jupyter). The lab's own Python env `~/env` (9 GB, with
  Jupyter) is left alone.
- **The project on the VM:** `~/smartlab`, branch `solve-stage-hardening` at
  `e517d34` (transferred as a git bundle; origin points to GitHub), set up with
  `./dev setup`, tests pass except Q7. **No `.env` there yet.** Update it with
  `git pull` after pushing, or another bundle.
- **SSH helper (local, gitignored):** `.tools/ssh/vm` runs a command on the VM
  using the `.env` login through `.tools/ssh/askpass`, with known hosts in
  `.tools/ssh/known_hosts` (not `~/.ssh`): `./dev .tools/ssh/vm '<command>'`. A
  fresh clone has to recreate both small scripts (`SSH_ASKPASS` printing
  `$SMARTLAB_SSH_PASSWORD`, `SSH_ASKPASS_REQUIRE=force`,
  `PreferredAuthentications=password`).
- **Never** print `.env`, the VM's shell configuration or unit pages unmasked.
  A previous inventory command printed the lab password from the VM's old
  `~/.bash_profile` (since deleted); the user was advised to rotate it.

## Lab tasks (verified 2026-10-07)

| Unit / task | Data | Training targets | Metric | Submission |
|---|---|---|---|---|
| 1.1-1.3 Spam (spam1, spam2, webspam) | zip of text files | binary 0/1 (`path;label`) | BACC | `path;0/1` CSV + source archive |
| 2.1-2.3 Malicious DOCX / PDF / RTF | zip of binary documents, real malware | binary 0/1 | BACC | same |
| 2.4 Mixed documents (bonus) | mixed formats, detect the format | only the older training data | BACC | same |
| 3.1-3.3 Clustering (PHP/Perl, Android APK, Windows PE) | scripts, APKs, packed executables, real malware | known families; **test families are different** | adjusted Rand index | cluster assignment + source |
| 4.1 Network intrusion | one `pcap.gz`; rows are TCP connections `ip:port->ip:port` | **none** (attacks are in the training data) | BACC with missing values | connection;0/1 |
| 4.2 Adversarial image detection | 2,990 PNGs; the predicted class is in the file name | **none** | BACC | `path;0/1` |
| 5.1 Model stealing | no dataset; REST service on the VM, time-limited challenges | n/a | cross-entropy, computed by the lab | token from the service, entered on the lab website |
| 5.2 Evasion (optional) | same service | n/a | target class reached + small perturbation | same |
| 6.1 Adversarial robustness | FashionMNIST | image classes | computed by the lab (FGSM/PGD) | a `torch.nn.Module` posted to the service -> token |

Task kinds: supervised file classification (1, 2), clustering with unseen test
families (3), unsupervised detection (4), interactive attack or defence against
the VM service (5, 6). The task pages mention "a python template" for the
service in units 5 and 6; it was not found in the VM's home directory and has
not been located yet (it likely defines the expected torch version).

## Done (2026-10-07)

| Commit | What |
|---|---|
| `6496825` | Snapshot of the previously uncommitted work (orchestrator, evaluate/refit/submit, knowledge) |
| `21a3e8e`, `97c8252`, `a19ff94` | Compiled packages load; `add`/`update` import new and requested packages and report missing system libraries (`installed_import_failure`); the library workaround was later removed with D12 |
| `619aed8` | Removed generations 0-2: the old orchestrate loop and its sessions, `agent/smartlab/`, the measured solve loop (`solve_session`, `iteration`, `canary`, `champion`, `results`), unused `smartlab_eval` modules, replaced setup scripts, the memory tool, old prompts. Merged duplicates: convergence into `smartlab_trial/`, stratified folds into `solve/folds.ts`, removed the old output archiving and `feature_audit.ts` |
| `3cfca0a`, `e517d34` | Devbox replaced by `./dev` + mise (D12); `wget` fallback for the VM |
| `5e36fe4`, `1864d3e`, `e570e16` | VM inventory and cleanup (pip cache, old clone, old tools, old `~/.bash_profile`; 13 -> 21 GB free). The old clone's uncommitted solvers are in `docs/archive/vm-old-clone/`; its unit texts (with credentials) in the gitignored `units/_vm-archive/`, its submissions and memory file in `runs/vm-archive/` |

Lessons kept from the removed code: the generation-2 canary compared scores,
not just labels (C1); `threshold_sweep`, `paired_bootstrap` and `calibration`
are recoverable from `6496825` (C3).

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
per fold. Search folds and champion reruns use the same function. Compare the
scores (`predict_proba` / `decision_function`) as well as the labels: where the
text alone already separates the classes, a leaky pipeline can predict the same
labels while only its scores move.

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
   the selected champion (the champion tag, see Q2), check out its commit, build
   its fixed pipeline with a harness seed, fit on all development rows, predict
   the held-back rows. Reuse the refit worker's loaders and the supervisor's
   process ownership, as `agent/refit/` does. The ID canary runs here too.
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
