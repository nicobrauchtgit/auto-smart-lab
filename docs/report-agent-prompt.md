# Prompt: material for the experiment report

You help write the report on the auto-smart-lab experiment. Your job is to find,
read and summarise material. You do not run experiments. Everything below is a
map: open the files, check what they say, and cite them by path. If something on
this map is missing or contradicts another source, say so; do not guess.

## Rules

- **Read only.** Do not edit, move or delete anything in the repository, `runs/`,
  `units/` or Drive. All experiments are finished and submitted; do not start runs.
- **Paths.** Paths are relative to the repository root. Both observer reports and
  the design docs are committed on `main`. Run records under `runs/` are gitignored:
  read them from the copies of the two checkouts, i.e. the main checkout (Qwen) and the
  Google checkout (`auto-smart-lab-google`), wherever they were copied. If a path is
  missing, say so.
- **Never open or print `.env`, credentials, webhook URLs (`completion-webhook.url`)
  or `units/_truth/`.**
- **Evidence rules (from `AGENTS.md`):** design decisions cite research papers
  only, marked *peer-reviewed* or *preprint*. Blog posts, vendor docs and opinion
  pieces are not evidence. Our own measured runs are evidence for this
  repository, not general findings.
- **Score rules:**
  - Official test scores do not exist yet (Lukas scores the deliveries).
  - The minimal arm's "local score" is the agent's own measurement on its own split.
  - The finetuned arm's CV and sealed (held-back) scores are harness measurements.
  - Do not compare the three as if they were the same quantity.
- **Mark every claim** with its source path (and section heading).

## What the experiment is

Two arms on the same course tasks, each run with two models:

- **Minimal agent** (`harness/minimal/`) vs **task-adapted harness**
  (`harness/finetuned/`: one lead agent, asynchronous scouts, harness-owned
  trials, sealed confirmation, terminal refit).
- **Models:**
  - Google: `google-vertex/gemini-3.8-flash`, thinking high;
  - Qwen: `mythllm/qwen3.8-flash-next-a5b`, offline.
- **Units and tasks:** spam1-3; documents1-4 (maldoc); code1-3 (clustering
  of malicious code); attacks1 (detection of unknown attacks, anomaly
  detection); tor1 (closed world, 30 sites) and tor2 (open world, binary).
- **Where the two models ran** (one 6-core machine, split by CPU):
  - Google: a separate clone `auto-smart-lab-google` (CPUs 4-7), with the model
    selection and thinking level in `experiment.config.json`;
  - Qwen: the main checkout (CPUs 0-3).
  The generic code for model selection (thinking level, builtin provider models with
  cost) is on `main`; `experiment.config.json` names no model by default.

## Method and design (why the arms look the way they do)

On `main`:

| Path | Use |
|---|---|
| `docs/experiment.md` | The experiment protocol: arms, what is compared, what must stay the same, differences from Leo's earlier runs, reasoning settings measured on MythLLM, and the model selection. |
| `AGENTS.md` | Project rules, including the evidence rules and the boundary between arms. |
| `harness/finetuned/docs/expert-team-v2.md` | The finetuned design (accepted 2026-11-11). Has "Evidence from our own runs", "Evidence from research papers" and a "Sources" list. **Main research citations live here.** |
| `harness/finetuned/docs/expert-team.md` | Contract appendix to v2. |
| `docs/adr/001…007` + `docs/adr/README.md` | Architecture decision records: independent arms, model freedom with harness-owned evidence, RAM observation, durable controller, isolation/confirmation/provenance, shared workspace, lead and scouts (007 cites papers). |
| `docs/architecture.md` | Architecture and flow diagrams. |
| `harness/finetuned/docs/harness-owned-training.md` | Harness-owned training contract, champion rule (paired 2-SE). |
| `harness/finetuned/docs/harness-measurements.md`, `held-back-confirmation.md`, `training-search-and-versioning.md`, `telemetry.md`, `solve-filesystem-isolation.md`, `pipeline-integration.md`, `multiclass-implementation.md` | Mechanisms of the finetuned arm. |
| `harness/minimal/README.md`, `harness/minimal/docs/AGENT.md`, `harness/minimal/docs/EXPERIMENT_LOG.md` | Minimal arm and its history (Sept/Oct VM runs). |
| `docs/clustering-mode-plan-2026-11-17.md` | Clustering mode; section "Research basis (peer-reviewed)". |
| `docs/code-attacks-harness-plan-2026-11-17.md` | Harness patch for code/attacks. |
| `docs/experiments/tool-call-budget-policy-2026-11-13.md` | Tool-call budget policy; section "What research actually budgets". |
| `docs/paper-notes.md` | **Points already earmarked for the write-up**, each with its evidence (hardware limits on parallel exploration, pinned pi 0.84.1, …). Start here. |
| `docs/questions-for-leo.md` | Open questions about the minimal arm. |
| `docs/cleanup-plan.md`, `docs/v2-kickoff.md`, `docs/v2-integration-2026-11-12.md`, `docs/completion-reliability-plan.md` | Development history and open decisions. |

## Tasks, data and course material

| Path | Use |
|---|---|
| `docs/tasks.md` | Course dataset inventory (2026-11-10). |
| `docs/cloud-dataset-task-map-2026-11-16.md` | Course share → repository tasks. |
| `docs/course-materials-mapping-2026-11-16.md` | Installed course materials (Moodle ZIP). |
| `docs/resource-delivery.md` | How course resources reach agents. |
| `docs/experiments/dataset-backed-scope-2026-11-16.md` | Which tasks ran and why (Tor deferral, later lifted). |
| `units/<unit>/unit-intro.md`, `units/<unit>/<task>/prompt.md`, `meta.json` | Task texts as the agents saw them. Tor: `units/04-tor/` (instructor text verbatim plus a marked "Local offline protocol" section; no metric is given, so balanced accuracy is an observer assumption). Never open `units/_truth/`. |
| Google `runs/diagnostics/course-share-inventory-20261116.json` | Share inventory with sizes and ETags. |

## Results and run records (the core of the report)

**Google observer report:** `docs/experiments/google-sequential-2026-11-16.md`
(about 3,000 lines, chronological). Key sections, in order:

1. spam1-3 and documents1-4 runs (2026-11-16).
2. The original code/attacks runs, then the clustering-mode rerun table (search
   "| code2 |"), the metric-bound fix, the anomaly output-contract fix and attacks1 attempt 3.
3. "Google Tor summary (2026-11-18)" and "Qwen Tor result".
4. Corrections:
   - "Correction: why finetuned tor1 failed";
   - "Correction: the minimal label fix never reached the minimal runs";
   - "Second harness gap … foreign validation-check paths".
5. Manual completions:
   - "Google finetuned tor1: manual output";
   - "Qwen manual completions done";
   - "Minimal tor1 site-name conversion" (with the index → site map).
6. "Harness fixes for the code hand-over" and "Third instance of gap B".
7. Submission: "Submission sources for units 3-5", "Submitted to Lukas".
8. "Completion webhooks and schedules removed".

Google per-step records (Google checkout, gitignored): `runs/diagnostics/tor-20261118/completed-*.json`,
`*-delivery-validation.json`, `*-langfuse-observations.jsonl(.receipt.json)`,
`manual-tor1-promotion-receipt.json`; also `runs/diagnostics/google-rerun-20261117/` and
`google-sequential-20261116/`.

**Qwen observer reports** (committed on `main`):

- `docs/experiments/qwen-unit2-continuation-2026-11-16.md`: documents1-4, plus the old-base "Code/attacks campaign summary" and the reset;
- `docs/experiments/qwen-code-rerun-2026-11-17.md`: the code/attacks finetuned rerun, fixes, failures, the manual code1/code3/attacks1 completions and the final summary;
- `docs/experiments/qwen-tor-2026-11-18.md`: Tor.
- Launch records (main checkout, gitignored): `runs/launches/2026-11-17-qwen-code-rerun/`, `runs/launches/2026-11-18-qwen-tor/`,
  `runs/launches/2026-11-16-qwen-unit2-continuation/` (mostly data; skip `data/`). Never open
  `runs/launches/2026-11-12-*`: one file there holds an old Langfuse key pair.
- Branch `qwen-campaign-records-2026-11-17` holds committed copies of earlier Qwen records.

**Earlier development and spam experiments** (2026-11-11 to 11-15; check which model each used):

- `docs/experiments/spam-2026-11-11.md`, `spam1-*-2026-11-12.md`, `spam-completion-tool-choice-2026-11-13.md`;
- `spam2-completion-repeat-2026-11-14.md`, `spam3-completion-2026-11-14.md`;
- `v2-unit1-2026-11-12.md`, `documents1-*-2026-11-15.md`, `unit2-*.md`, `prompt-first-spam1-just10min.md`.

**Harness state per task (finetuned):** `runs/finetuned/<task>/lead/PROGRESS.json` in each
checkout (trials, scores, validation, holdout, budget, hand-over). Confirmation receipts are under
`runs/finetuned/<task>/confirmation/*/holdout-confirmation.json`, and deliveries under
`runs/finetuned/deliveries/<task>/`. The minimal chain is `runs/minimal/<chain>/logs/deliveries/`
(Google chain `2026-11-15T23-44-56`, Qwen chain `2026-11-11T08-29-56`).

**Traces:** Langfuse Cloud (project in the reports). Trace and session IDs are recorded
per step in the reports and in the `*-langfuse-observations.jsonl` exports. Use the
exports; do not call the API.

**Backups and submissions** (Google Drive, private):

- Backup root folder id `1GO9xr3PSPhiyCe5mLJz-z7lQD5GGm_jq`: one folder per arm, model and task. Manual completions and failed runs have their own folders.
- Submitted to Lukas (official scores come from him):
  - spam1-3 and documents1-4, from `submission-csvs-for-lukas-2026-11-17`, sent on Monday;
  - units 3-5 as the single archive `submission-csvs-units3-5-2026-11-18.zip` (24 `output.csv` files, sha256 `36bc3d6c…`), sent on 2026-11-18.

  Build records: Google `runs/exports/submission-csvs-20261117/`, `submission-sources-google-20261118/`, `submission-all-20261118/`; main `runs/exports/submission-csvs-20261118/`.
- Local backup status: `runs/exports/*/status.json` and `backup-manifest.json`.

## Facts the report must state correctly (verify each in the sources above)

1. **Four deliveries are manual completions after harness gaps; no agent ran for them:**
   - Google finetuned tor1 and Qwen finetuned code3: the lead's own fix of a
     validation-blocked champion could not replace it, because an equal score fails the
     paired 2-SE rule;
   - Qwen finetuned code1: a validation check from another task's folder stayed
     "incomplete" for good;
   - Qwen finetuned attacks1: a misspelled check path stayed "incomplete" for good, and the
     scout's own (mis-specified) check also failed. attacks1 has no withheld rows, so there
     is no sealed score. Observer-only check against the true training labels: OOF balanced
     accuracy 0.542, so the evidence AP of 0.922 is self-referential.

   Caveats: no validation approval for the promoted trial, and a second sealed read
   (tor1, code3). The fix is branch `fix/handover` (reviewed); check `git log main` for
   whether it was merged. No experiment ran on it.
2. **Both minimal tor1 runs delivered class indices.** The label fix updated only the
   chain's fingerprint, not the chain's own agent code, so names would have been
   refused. The site-name conversions recover the agents' intended answers (each
   agent wrote its own map); the map is in the reports.
3. **Harness changes during the campaign:**
   - clustering mode (anchored batches, trial digest);
   - metric-bound tolerance;
   - anomaly output contract (attacks1 label 1);
   - multiclass kind (tor1);
   - minimal single-token labels.

   Committed on `main` 251346c; see the commit messages (`git log 4c983d2..251346c`).
4. **Asymmetries between the models** (order of code/attacks tasks, memory state,
   attacks1 attempts): recorded in both observers' reports. Look for "Recorded asymmetry".
5. **Infrastructure limits:** a 6-core machine, disk pressure, and MythLLM throughput (see `docs/paper-notes.md`).

## Deliverable

Return a structured digest:

- the method, with sources;
- a results table per task × arm × model, with the score type named and the source;
- the incidents and fixes, with dates;
- the research papers cited by the design, each marked peer-reviewed or preprint, with the decision it supports;
- the open points.

List anything you could not verify.
