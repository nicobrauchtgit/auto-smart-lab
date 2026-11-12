# Spam1 live tool-choice diagnostic

One fresh offline finetuned run, observed on 2026-11-12. The question was how
the runtime lead chooses between harness execution and local fitting, not how
to optimize this classifier. The user subsequently allowed two 30-minute runs;
only the first was needed to obtain two live explanations of early decisions.
No old solution, feature advice or previous winning parameters were supplied.

## Conditions and identity

- Base checkout: `v2-clean-slate`, `b8a4ac6`, initially clean.
- Runtime model: configured `mythllm/qwen3.8-flash-next-a5b`, offline.
- Production launch: **16:33:27.154 UTC**. Hard deadline: **17:03:27.154 UTC**.
  Typed immutable guidance reserved the final ten minutes for validation/refit
  and requested terminal hand-over by 16:53:27.154. This is a bound including
  setup and finalization, not thirty minutes of modeling followed by extra time.
- Pipeline: `ffc00f9b-bc9a-4c34-9867-a04e0bd65cdd`.
- Lead/training invocation: `b07c818e-636f-408f-a700-a1b5e92dcf56`.
- Lead agentRunId: `d19a1a31-87ac-4cce-bf63-54cda15674be`.
- [Langfuse trace](https://cloud.langfuse.com/project/cmumh75f5014jad0dx0f2gn0w/traces/cbe792fee9790a829bbf1e53f3992b74).
- Controller, supervisor receipts, logs, health samples, typed guidance and
  observation snapshots: `runs/launches/2026-11-12T16-29-00Z-spam1-tool-choice-diagnostic/`.

The inherited exec session 77591 was unavailable and no prior preflight process
remained. Read-only telemetry inspection recovered no completion for that
invocation. One recorded production preflight then passed, including the tiny
model request and observability access (pipeline
`cb2fc968-42e0-42cd-acb6-4781a57b36ae`, trace
`e7b26ddaa2f0afc426a53039e3d9da89`). No retrospective model session was retried.

The only authored runtime instruction change replaced the generic statement
that wall time was unlimited with an instruction to follow deadlines/reserves
in invocation guidance. The captured lead prompt contains both actual UTC
times and no unlimited-time claim. Lead system template SHA-256:
`dede994a3d4d2978914f55135fc7829b101c0ad38ce371348d978f8c9f7d7155`;
rendered SHA-256:
`e2548874b41fccf949a36f2c2c6a7299cb584b3b61d2fd67e26c074e19858afd`.
Modeling instructions and the local-comparison prohibition were preserved.

## What actually used the harness

- **16:34:45.967:** asynchronous data/ideas consultation started. This is
  advisory work, not measured model comparison.
- **16:45:39.489:** first `trial_smoke` rejected for invalid `cv.kind`.
- **16:46:00.769:** second smoke request rejected for invalid CV field names.
  These request checks did not execute a model fit.
- **16:46:24.720:** a smoke worker reached the build step but could not resolve
  `tasks/spam1.py`. Its response included a traceback. No estimator fit succeeded.
- **16:47:16.963:** smoke request using `solutions/tasks/spam1.py` passed on
  256 development rows. This was a harness-owned fit/predict check, not a trial
  unit or promotion measurement.
- **16:47:53.432**, **16:48:19.127:** `experiment_start` rejected first for
  using `commit` with schema version 1, then for supplying a commit description
  instead of a revision. Neither started a fit or charged a trial unit. These
  and the smoke requests still consumed lead tool calls.
- **16:48:44.770:** corrected start request accepted; trial start persisted at
  **16:48:47.316**, about 15m20s after launch. Trial
  `33694f7e-0f8c-4ac0-930a-51ad64905bc0` used five stratified folds, one repeat,
  one fixed pipeline/configuration, source commit
  `ef7f9ba561eeb866ee7f5337ee7e3b8f224a35d6`.
- **16:49:11.904:** premature readiness `hand_over` refused while the trial was
  running. This was an attempted checkpoint, not completed validation.
- **16:50:53.940:** trial completed, became champion and recorded development
  CV balanced accuracy **0.9957029292744981**. Worker execution took about
  127 seconds. No search or paired challenger comparison was needed for this
  first champion.
- **16:51:47.660:** the lead requested `hand_over(finalize: true)`, before the
  typed finalization-reserve boundary. Validation completed at
  **16:58:16.813**, recording a validated baseline; deterministic terminal
  refit then completed. No improvement trial or harness search was launched.

The initial configuration used word/character/subject TF-IDF and one linear SVM.
Optional threshold tuning and alternative classifiers were present in source;
`threshold_cv` was zero for this measurement. Merely defining inner fitting
or calibration routines does not establish their execution. No internal
threshold-calibration fit is attributed to this trial.

## What actually ran locally

The supervised lead shell inspected directories, the development manifest,
archive members, sample text and sizes, and unlabelled test samples. These were
data exploration, not model fits. A wrong solutions-directory command failed;
later attempts to read harness implementation files also failed because those
files were absent from the sandbox view. No arm boundary was broadened.

At **16:41:46.262**, `bash-b0c2b90d` fitted **one** pipeline on the first 1,500
development rows, predicted those same rows and printed training scores and
the positive prediction fraction. It exited successfully at 16:41:52.850.
Reported fit and prediction times were 3.67 and 1.46 seconds. There were no
candidate loop, CV folds, held-out ranking or parameter-selection loop in that
command. It was a construction/execution check, not the five-candidate sweep
observed in run 3. Training accuracy is not generalization or promotion evidence.

The command followed recorded edits removing an invalid import, consolidating
text loading and simplifying a sparse import. It preceded baseline commit
`ef7f9ba` at 16:42:37.457. It did not reproduce a prior observed crash: it checked
the freshly edited implementation for anticipated execution/shape problems.
That distinction limits any claim that it demonstrated diagnosis of a specific
already-observed failure.

All twelve authoritative lead-shell receipts were inspected. This was the only
local fitting command; the final lead-shell call was the failed harness-source
inspection at 16:46:47.517. No local candidate comparison occurred during the
rest of the run.

The captured scout shell actions were data-summary scripts and validation
source/workspace inspection. They provide no evidence of a separate local
estimator comparison. Scout transcripts are not reproduced here.

## Live explanations and interventions

Exactly two focused questions were delivered through `ask_lead.ts` to the
original live lead. Answers are retained under
`runs/finetuned/spam1/lead/operator/answers/`. Subsequent behavior is observed
after intervention, not an untouched control.

1. **16:42:29.020**, question `2026-11-12T16-42-29-020Z-3addb2`: what the
   1,500-row command tested, diagnosis versus comparison, why local, and whether
   tool feedback/cost/latency mattered. The lead described checking imports,
   reading, features and prediction shape after edits. It classified the fit
   as diagnosis, said training scores were not selection evidence, and cited
   debugging convenience and latency. It said no prior harness cost feedback
   or interface limitation caused the choice, acknowledged `trial_smoke` was
   available, and called the local check partly redundant.
2. **16:49:23.799**, question `2026-11-12T16-49-23-799Z-ef1cae`: how subsequent
   request feedback affected its next action and choice of execution path.
   The lead said request problems did not challenge its model, so it corrected
   fields while retaining the same candidate. It placed candidate ranking in
   the harness, and said round trips shortened its plan from baseline plus
   one improvement to baseline then finalization. It explicitly distinguished
   a running trial from pending validation and refit in this answer.

## Corroboration, contradictions and uncertainty

The shell source/output support a single construction check after edits, not
local candidate comparison. The subsequent successful smoke and fixed harness
trial support the stated division between local execution checking and harness
measurement. The first local fit predates every rejected smoke/trial request,
so those later errors cannot be its cause. There was no preceding trial cost
guard or interrupted search in this run.

Interface friction was concrete: two CV-schema errors, a module-path build
failure, and two commit/request-version errors. The interval from first smoke
attempt to accepted trial request was about 3m05s; smoke failure and response
delays also consumed calls. The lead's account of roughly five minutes lost is
an estimate, not a controlled latency measurement. Its claim that a harness
failure would supply only an opaque status was contradicted by the later
smoke response's traceback; its claimed thousandfold time advantage was not
measured. In its first answer it spoke as if smoke and trial execution had
already happened, although the recorded successful executions came later.

These self-reports do not prove internal causation. Tool records establish what
ran and the order of feedback; they support an explanation based on anticipated
debugging convenience for the local check, followed by request repair within
the harness. They do not demonstrate that interface friction caused local
comparison, because no such comparison occurred. Time pressure and the two
operator interventions limit generalization to the earlier unlimited-time run
or to other tasks. No speculative remedy was implemented from this observation.

## Terminal outcome and safety

The pipeline finished successfully at **17:00:22.018 UTC**, approximately
**26m55s after launch**, about three minutes before its hard deadline. PROGRESS
records `handed_over`, phase `improvement`, one validated baseline and 30/80
charged lead calls. Validation and deterministic refit completed; the controller
records exit code 0 and no deadline stop. Finalization was requested in time,
and completed inside the communicated bound. This single run establishes that
outcome, not a general deadline-planning capability or the multi-task gate.

Delivery: `runs/finetuned/deliveries/spam1/c2f3fc664b7a/`, containing
`output.csv`, `source.zip` and `manifest.json`. Refit result identity:
`c2f3fc664b7a56c178cd4214acacf1c362a26e5f0c70b4d043fdb9374dd8c00e`.
The completed refit and final pipeline artifact gate are corroborated by
15,051 prediction rows, matching the delivery manifest, and an independently
recomputed SHA-256 matching that manifest. Nothing was uploaded or submitted.

The existing supervisor recorded peak aggregate descendant RSS of about
2,645 MiB. Five-second controller samples stayed above 10,650,034,176 disk
bytes free (9.92 GiB) and 12,726,132 KiB available RAM (12.14 GiB). These are
sampled minima, not proof of every intervening instant. No machine-protection
stop was recorded. A fresh process check after exit found no remaining
controller, pipeline, launcher or refit worker from this invocation.

The controller reused `ExperimentSupervisor` and its birth-identified,
subreaper-based bounded descendant cleanup rather than adding a new process
manager. It held controller/status/health records and temporary scratch on
disk outside agent-writable mounts. Previous archives, deliveries, diagnostic
attempts and setup journals were preserved; fresh task state was neither
reset nor resumed. There were no minimal-arm changes, code2 runs or pushes.

Verification before launch: `./dev bun run test:fast` passed **572 tests**, with
2 skips and no failures (129.08 s); focused prompt/guidance checks passed
14 tests with no failures; `git diff --check` passed. No merge was performed;
the full suite remains required before merging. Run data and setup journals
are excluded from the documentation/instruction commit.
