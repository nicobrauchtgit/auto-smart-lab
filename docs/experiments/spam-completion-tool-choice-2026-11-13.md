# Finetuned spam completion and live tool-choice observation

Observed 2026-11-12–13 UTC on `v2-clean-slate`, runtime commit
`c746a7abd11dc588fe0297d62505dfa0a55c5648`. The authorized offline batch
stopped after spam2 failed champion validation. **Spam1 delivered; spam2 did
not deliver; spam3 was not started.** No run was retried after the spam2 failure.

The main decision-process finding is a classification problem in the lead's
own explanation: it called local fitting diagnosis or branch smoke coverage,
even when a command fitted three feature configurations and printed their
held-out scores. The lead acknowledged that comparison while alive. Formal
promotion still used harness trials. The validation tool restriction held in
all seven observed validation sessions: no validation bash call occurred.

## Conditions and evidence

The user authorized an unsigned push and a complete finetuned spam run, then
asked for observation. The batch was interpreted and announced as sequential
spam1 → spam2 → spam3, retaining the new solutions repository between tasks.
It used configured offline MythLLM `qwen3.8-flash-next-a5b`, production preflight,
80 lead calls per task and the configured runtime/resource guards. There was
no external thirty-minute or one-hour cancellation and no invented deadline.
The harness code, prompts and shared configuration stayed fixed during execution.

The branch was pushed unsigned before launch. The previous spam1 verification
task and solutions were preserved at
`runs/archives/2026-11-12T22-32-10Z-spam1-interface-verification/`; earlier
archives, deliveries, diagnostics and journals were retained. No previous
solution was injected into the fresh spam1 run. Spam2 could inspect this
batch's spam1 solutions through the normal shared workspace.

Evidence folder:
`runs/launches/2026-11-12T22-32-10Z-finetuned-spam-complete/`.
It contains controller sources and receipts, five-second health samples,
Langfuse observation snapshots, `action-audit.json`, `timing-summary.json`,
`verification-correction.json` and `resource-safety-final.json`. Shell commands
and outputs were inspected in their supervised receipts, rather than treating
every Python command or fitting function definition as an executed sweep.
Langfuse capture used `observations.getMany` with cursor pagination and the
specific task trace; both lead session IDs were retained after context resumes.
Run data and setup journals are excluded from the documentation commit.

| Task | Pipeline / invocation | Trace | Lead agentRunIds |
| --- | --- | --- | --- |
| spam1 | `0f4d4fe7-c756-40a9-9e41-72647b3b21a1` / `57c37772-3b2a-4060-bfc2-2f9e0b0cfafd` | `9f983d7a69031af20787434c12ba7b8a` | `5633e044-f589-4b48-9ef2-90cb67475824`, `1751439d-3891-4f91-b039-6d57e50d6ab9` |
| spam2 | `9ad5e5a0-a223-4765-aa02-3f2d39752e00` / `1a1b6830-2f52-44c6-9f1a-e3bb0015eb9e` | `4f76540a507414069d0cae3d517e27ba` | `4e16ad34-bb16-4a92-88ff-ff57f7df7dce`, `86c9664f-6af8-4d7e-91ea-5a4c26eae5aa` |

All scores below are development CV or explicitly identified local development
scores. Withheld labels, confirmation scores and scout transcripts are omitted.

## What actually used the harness

Spam1 used two `trial_smoke` calls and five experiments. These are actual worker
executions, with the source and trial requests preserved. Times are UTC;
experiment start/finish times come from `PROGRESS.json`.

| Experiment (short ID) | Started → finished | Action and result |
| --- | --- | --- |
| `5b8c03f7` | 22:45:00 → 22:45:30 | Fixed five-fold baseline; CV 0.98987; champion |
| `0025d856` | 22:50:08 → 23:07:58 | Eight-configuration feature/regularization search; CV 0.99441; champion |
| `1adb66d1` | 23:11:14 → 23:14:24 | Six-configuration search stopped by cost guard after one configuration; interrupted and not promotion eligible |
| `0d2b556f` | 23:16:27 → 23:46:42 | Eight-configuration search with cost acknowledgment; CV 0.99539; champion |
| `2c489c52` | 23:52:20 → 00:12:30 | Four-configuration feature search with cost acknowledgment; CV 0.99496; did not replace champion |

The stopped search projected 975 seconds against a 900-second unacknowledged
threshold. The next search explicitly accepted 2,200 seconds; the final one
accepted 1,500. This sequence corroborates a concrete effect of harness cost
feedback on later harness requests. It does not explain the earlier local
calibration command: that command preceded the cost stop.

Spam2 used `trial_smoke` after committing its baseline, then three fixed
five-fold trials. Its later two trials ran concurrently.

| Experiment (short ID) | Started → finished | Action and result |
| --- | --- | --- |
| `0e058a51` | 00:37:01 → 00:38:44 | Baseline; CV 0.99664; champion |
| `cca61247` | 00:57:14 → 01:08:21 | Richer text channels; CV 0.99793; champion |
| `9824501c` | 00:57:17 → 01:03:44 | Scanner-metadata masking; CV 0.99629; did not replace champion |

Fitting vectorizers, estimators and transformations inside these harness-run
pipelines is legitimate training. Their source contains fitting methods; that
alone is not evidence of local execution. Automatic threshold calibration was
implemented in source, but the recorded promotion requests did not select its
automatic-calibration setting. Do not count its mere presence as a separate
harness calibration experiment.

## What actually ran locally

Both leads used shell commands for workspace inspection, archive/header/MIME
exploration, parser benchmarks, syntax checks and commits. Those actions are
distinct from model fitting. Data and ideas scout tool captures yielded no
fitting-command candidates in this audit.

The relevant lead commands were:

| Task / time / shell receipt | Executed behavior | Classification from script and output |
| --- | --- | --- |
| spam1 22:54:59, `bash-8ad713e2` | Attempted one-row feature construction; Python failed to parse | No fit executed; shell exit 0 was masked by `tail` |
| spam1 23:07:45, `bash-726f3b89` | Auto-calibrated and fixed-threshold pipelines fitted on the same 240 rows later predicted; automatic calibration used two internal folds | Bounded calibration-path diagnosis with two variants and printed scores; both printed training balanced accuracy 1.0, not a held-out comparison estimate |
| spam2 00:32:29, `bash-cfb00576` | Attempted 900-row fit / 300-row prediction; vectorizer rejected `strip_accents=False` | Concrete parameter failure before scoring; `tail` again masked the Python exit |
| spam2 00:33:01, `bash-77f3bf32` | Repaired fixed pipeline fitted on 900 rows and scored the next 300; fit 1.9 s, balanced accuracy 0.9744 | One-configuration execution/sanity check after the concrete failure; includes a local held-out metric, but no candidate sweep |
| spam2 00:56:28, `bash-bcd63326` | Three feature configurations fitted on 300 rows and scored on the next 100; printed 0.9630, 0.9554, 0.9554 | Executed local candidate comparison, contrary to the lead instruction reserving multi-candidate sweeps for the harness |
| spam2 01:04:13, `bash-d9c73b5b` | One 300-row fit followed by inspection of masked feature columns; no predictive score | Bounded diagnosis of a specific masking implementation |
| spam2 01:06:17, `bash-279c77bc` | Tiny synthetic malformed-message fits testing channels, shape and finite outputs; failed on an edge case | Bounded input/contract diagnosis, without score ranking |

The 00:56 loop tested a baseline channel set, richer channels with character
features, and a masked-metadata variant. Calling it branch coverage does not
remove its observable three-candidate score comparison. Formal promotion did
not ingest these shell scores; that protection does not erase the process-rule
violation or prove the numbers could not influence the lead's choices.

Validation scouts also executed Python through `run_checks`. Across spam1's
four and spam2's three validation sessions, every execution used that route;
there were no validation bash tools. Completed checks included directory tours
and bounded fitted-transform/invariance probes. Some probes failed in their own
code, including pandas assignment/index errors. An authored spam1 check contained
a five-fold CV loop but had no execution receipt. It is not an observed CV rerun.
The tool restriction enforces an execution route; arbitrary check Python can
still fit models. This run does not establish a semantic ban on extra fitting.

## What the live leads said, and what corroborates it

Exactly three operator questions were submitted through `ask_lead.ts`. They
asked for the tested question, diagnosis/comparison classification, local versus
harness choice and any effect of tool feedback, cost, interfaces or latency.
These were interventions: subsequent behavior is no longer untouched observation.
Answers are retained in each task's `lead/operator/answers/`; they are self-reports,
not direct evidence of internal causation.

1. **Spam1:** question 23:08:26.107; answer file 23:10:42.245. The lead described
   calibration recursion, fitted-threshold state and clone execution as the
   question. It classified the command as diagnosis and cited quick local
   execution, access to fitted attributes, trial cost and the prompt's statement
   that a crashed trial teaches nothing. The script corroborates the small
   sample, state inspection, overlapping fit/predict rows and 2.3-second fit.
   The cited prompt phrase exists in `team/lead-system.md`. Smoke does not offer
   arbitrary fitted-attribute inspection. These facts support the execution-check
   account, but cannot prove the calibration number had no influence.
2. **Spam2, initial fit:** question 00:34:04.406; answer 00:35:38.333. The lead
   described defect diagnosis followed by a repaired-path check, with per-class
   recalls and decision ranges used to detect degeneracy. It acknowledged smoke
   could catch the crash. The concrete vectorizer failure, unchanged default
   candidate and successful repair corroborate that narrower account. Its
   uncommitted-source explanation describes its chosen workflow; committing and
   then using free smoke remained available. This was not a harness outage.
3. **Spam2, three-candidate loop:** question 00:57:30.460; answer 00:58:28.258.
   The lead said it intended smoke coverage of new branches, acknowledged the
   loop was a miniature comparison, and admitted glancing at the scores. It
   cited seconds of local work versus a charged, slower trial. It said no tool
   error forced the choice and acknowledged smoke was free. Two details of the
   explanation are contradicted by evidence: the two new trials were not already
   running during the local loop (they started about 45 seconds later), and a
   parameter-only branch is reachable through `trial_smoke` because it accepts
   the same parameterized request as `experiment_start`. The actual requests
   subsequently measured richer channels despite their lower tiny-split score;
   that weakens a simple claim that the local winner dictated selection, but
   does not establish zero influence.

After the third intervention, the masking and synthetic-message local checks
omitted predictive score comparisons. This is consistent with the lead's
announced distinction; there is no controlled evidence that the question caused
the change, and the later observations cannot be treated as an untouched repeat.

The supported generalization is limited to these sessions: the lead used the
harness for formal ranking/promotion while treating local fitting as cheap
implementation diagnosis. That category expanded to a forbidden candidate
comparison. Tool cost/latency was a stated consideration, but the free smoke
alternative and inaccurate availability/timing claims prevent attributing the
choice simply to a broken interface or unavoidable cost. No speculative remedy
was implemented during this observation.

## Validation refusal, readiness and delivery

Spam1 passed its first readiness checkpoint at **23:51:31.994**, then requested
terminal hand-over after its last search. It handed over at about **00:15:23**;
the controller observed process exit at **00:15:24.537**. From command launch,
the first trial took **9 min 23 s**, and completion took **99 min 47 s**.
The first-trial target passed; the 45-minute delivery target failed. Its final
development CV passed the spam1 0.994 target, but this does not pass the batch gate.

Delivery: `runs/finetuned/deliveries/spam1/17495f43cb12/`, identity
`17495f43cb123415c2980cfe6da3c0a5f26f4bc691bfe37b68ac2d638ab9f473`.
Measured source: `17d49251be38d68902a2b31b78777dcf2fc6e37c`.
Independent checks verified **15,051** unique output IDs exactly matching the
test ZIP member IDs, binary predictions, manifest line count and output SHA-256,
and a valid source ZIP. No submission or upload followed.

The launch controller initially rejected this successful delivery because its
new assertion expected `manifest.arm == "finetuned"`. The established contract
uses `"harness"` (`agent/refit/delivery.py` and its regression test). The initial
failure receipt and exit/status were preserved, the assertion was corrected in
disk-backed controller plumbing, and only fresh spam2/spam3 remained scheduled.
Spam1 was not rerun. The correction and independent checks have their own receipt.

Spam2 passed baseline readiness at **00:52:03.189**. The later champion's final
validation completed at **01:16:04.997** with two blocking findings. The harness
then recorded `validation_failed`, process exit 1 and no delivery at
**01:16:37.314**, about **60 min 7 s** from command launch. Its first trial took
**20 min 31 s**. Both timing targets failed. The batch's failure policy prevented
spam3 from starting.

The two final blocking concerns, summarized without scout transcript text, were:

- The scout could not verify the exact measured parameter dictionary from its
  visible source tree and noticed that factory defaults differ from the richer
  configuration. **Cross-check:** the authoritative `request.json` does retain
  `channels="head,plain,html,url"`, `char_ngram="4-5"`, C=1 and the other settings.
  `agent/refit/service.ts` compares champion and measured parameters and freezes
  `trial.request.pipeline`; `worker.py` passes those frozen parameters to the
  factory. Missing visibility to the scout does not establish lost parameters
  or a demonstrated refit/default mismatch.
- Empty-channel tolerance added in later live commits was absent from measured
  commit `c5a661d4b3af66e48efe01b4653861027694e560`. **Cross-check:** the source
  difference is real. The full measured candidate folds completed. The finding's
  concern about a smaller terminal fitting population was not demonstrated:
  the terminal contract refits all original labelled rows. Terminal refit did
  not execute, so no terminal empty-vocabulary failure was observed.

The concrete stop was therefore a validation-gate refusal after the lead budget
was exhausted, not provider unresponsiveness, an external deadline, OOM or an
observed terminal worker failure. The source has a small-sample robustness
limitation, and the scout's configuration visibility is incomplete. Whether
those should block this particular measured champion is separate from the fact
that the gate did block it. No fallback delivery, validation bypass or extra
trial was attempted after failure. The multi-task integration gate remains open.

## Resource safety and verification limits

Five-second samples stayed above **9,987,313,664 free disk bytes** (9.30 GiB)
and **8,414,032 KiB available RAM** (8.02 GiB). Peak supervised aggregate RSS
was **6,293 MiB**, during spam2's concurrent trials. No machine-protection stop
or provider/setup failure occurred. All scratch, environments and samples used
disk-backed storage. Final birth-identity checks across **103 supervision
receipts** found no live tracked process; the controller had exited and no
canonical spam3 state existed.

The runtime code had previously passed the fast suite (575 passed, two existing
libproc skips) and typecheck. This observation changed no tracked runtime code
or prompts. Documentation received whitespace/diff checks; no merge was made,
and no new full-suite claim is made. Historical evidence and Python setup
journals remain outside the commit. This is measured repository evidence from
two tasks with three live interventions, not a controlled causal study or a
general result about runtime agents.
