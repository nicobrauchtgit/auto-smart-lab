# Spam1: live verification of the corrected training interface

One fresh offline finetuned spam1 run on `c8aaa29`, authorized for up to thirty
minutes after the module-path/source-eligibility correction. The lead received
no prior solution, previous explanation, feature suggestion or operator-supplied
interface correction. The question was whether it could use the corrected
interface and how it chose local diagnosis versus harness measurement.

## Conditions and identity

- Initially clean branch: `v2-clean-slate`, commit `c8aaa29`.
- Configured runtime model: `mythllm/qwen3.8-flash-next-a5b`, offline.
- Launch: **19:27:39.301 UTC**. Hard deadline: **19:57:39.301 UTC**, including
  setup, validation and refit. The same typed guidance reserved the final ten
  minutes and requested terminal finalization by **19:47:39.301 UTC**.
- Lead/training invocation: `6832952a-1daf-420f-8db9-30f17ce17bcd`.
- Pipeline: `ae662597-0e8d-447d-a84e-3282c76a5f11`.
- Lead agentRunId: `0a37cedc-ce39-4ff0-8280-87c21f56b8bb`.
- [Langfuse trace](https://cloud.langfuse.com/project/cmumh75f5014jad0dx0f2gn0w/traces/bf1623bae7f1fde7081018c31adb5e83).
- Controller, status, health, authoritative outer supervisor records, typed
  guidance and observer snapshots:
  `runs/launches/2026-11-12T19-27-17Z-spam1-interface-verification/`.

Production whole-chain setup passed, including the configured tiny model probe,
before the lead started. The captured prompt contains the new
`training.request-contract` and both UTC times. The controller reused the same
supervisor and disk-backed scratch as the prior observations; no new execution
or monitoring infrastructure was introduced.

The previous diagnostic's task state and solutions were renamed into
`runs/archives/2026-11-12T19-27-17Z-spam1-tool-choice-diagnostic-2/`; its source
repository had no registered secondary worktrees. All archives, deliveries,
earlier observation records and setup journals were retained. No reset or old
run resume was performed.

## What actually used the harness

All recorded smoke/trial requests named **`tasks/spam1.py`**, the canonical
solutions-relative spelling. The initial CV object used valid `kind`, `scheme`,
`folds` and `repeats` fields. No request was rejected for CV schema or module
location in the sequence below.

- **19:30:59.483:** smoke found and loaded the module, then failed in the
  agent's import code: `ModuleNotFoundError: No module named 'archive_members'`.
  The lead repaired its library import and committed `3f6a364` at 19:31:20.611.
- **19:31:28.064** and **19:32:41.312:** subsequent smoke workers reached their
  60-second execution limit. Each returned `validation did not finish within
  60 s`; these were harness execution attempts, not module-path rejections.
- **19:36:47.169:** after local diagnosis/repair, smoke failed in the fit step
  with `float() argument must be a string or a real number, not 'dict'`.
  The factory treated the harness context dictionary as scalar C. Local probes
  calling the factory without that context had not checked this contract.
- **19:37:15.827:** the lead committed a context-aware factory (`b6a4202`).
  Smoke at **19:37:24.935** passed, returning at 19:37:28.837.
- **19:37:34.254:** a fixed promotion trial was accepted, persisted as started
  at **19:37:36.920**, about **9m58s** after launch. Trial
  `4ab2affd-d78a-4a66-b160-581097242542` used five stratified folds, one repeat,
  and word/character TF-IDF with class-balanced logistic regression.
- **19:39:58.774:** the trial completed and became champion. Development CV
  balanced accuracy was **0.9919604146894228**. This was the authoritative
  measurement; the local training scores below were not promotion evidence.
- Validation scout activity began at **19:41:14.795**.

This verifies that the corrected API resolved canonical module paths in this
live run. It does not imply that smoke always succeeds: it exposed import,
execution-cost and factory-contract problems in the agent-authored pipeline.

## What actually ran locally

Early shell commands inspected development and unlabelled test archive formats,
sample text and corpus statistics. A statistics script failed because it called
`ord()` on byte integers; the lead corrected it. These were data exploration,
not fits or model comparisons.

Three later supervised commands performed bounded local fitting:

1. **19:33:48.422**, `bash-21132377`: loaded the pipeline, fitted 256 development
   rows and attempted prediction on the same rows. Prediction failed with
   `NotFittedError`: the implementation tried transforming with newly created
   vectorizers instead of retaining its fitted ones. The command exited 1 after
   about 14 seconds. It tested one pipeline, not a candidate set.
2. **19:34:48.593**, `bash-5c361f6b`: timed reading/joining, word features,
   character features and one logistic fit on 1,000 development rows. Output
   attributed **41.42 of 44.56 seconds** to read/join, versus 0.61 for word
   features, 1.73 for character features and 0.15 for the classifier fit. The
   command printed training accuracy but performed no CV or candidate ranking.
3. **19:36:30.244**, `bash-bbcf2bc8`: verified fit, prediction and repeated
   prediction after repair on 1,000 rows. Fit took 2.49 seconds; prediction 1.04,
   repeated prediction 1.17; total was 5.35 seconds. The second prediction did
   not refit or compare an alternative model.

At **19:36:20.692**, the lead committed archive-handle reuse and fitted-vectorizer
reuse (`edfb0e6`). Commands, source edits and timing output support diagnosis of
concrete observed failures and verification of their repair. This is distinct
from the prohibited local multi-candidate ranking observed in run 3. A printed
training score alone does not turn a single execution check into a comparison.
These local results are not evidence of predictive benefit or promotion.

There was also **separate local fitting by the validation scout**, not by the
lead. At **19:45:22.006**, its shell call `bash-083702c9` wrote `check_cv.py`
and ran it directly through bash, followed by `check_contract.py`. The former
fitted the same snapshot pipeline across all five folds of a new stratified
split over the 16,261 development rows, with hard-coded seed 0, then computed
duplicate-text statistics. The latter performed fit/predict contract probes.
The combined command ended successfully at **19:49:30.193**; its actual output
contains all five fold results and successful contract assertions. This was
executed work, not merely a script definition or rejected attempt.

That was not a multi-candidate ranking sweep, and none of its measurements
promoted a model. It was nevertheless a local CV reproduction outside the
harness trial path. Its independently chosen folds did not replay the
harness's persisted fold manifest, so it was not an exact reproduction of
the authoritative score. Its execution method also violated the validation
prompt: checks must execute through `run_checks`, and bash is for reading
files. No `run_checks` call was recorded for these checks. The snapshot source
and tool receipts were inspected; scout transcripts are not reproduced.

## What the original live lead said, and what is corroborated

One operator question was queued at **19:35:41.432** through `ask_lead.ts`:
`2026-11-12T19-35-41-432Z-ef570d`. It asked what the first two commands tested,
diagnosis versus comparison, why local, and whether errors/interface/cost/latency
influenced that choice. The answer is preserved under
`runs/finetuned/spam1/lead/operator/answers/`. Behavior after this intervention
is not an untouched observation.

The lead described reproducing the prediction traceback and attributing the
smoke timeout to reading, vectorization or fitting. It cited two smoke timeouts,
their generic feedback and retry latency as its reason for going local. It said
the probes were one-pipeline failure diagnosis, not configuration ranking, and
that training accuracy was incidental. It then returned to harness smoke and
measurement, as it had said it would.

The recorded two timeouts precede the local fits. The prediction traceback and
component timing output corroborate the diagnostic questions; successful local
rechecks and later harness smoke corroborate repair. This run therefore supplies
a concrete feedback-to-local-diagnosis sequence and a live explanation, rather
than inferring a motive from ordering alone. The explanation remains a
self-report, not proof of internal causation.

Its claim of reproducing identical committed code needs qualification: local
commands loaded the live solutions tree, and repairs were made before the
19:36:20 commit. They were not immutable harness snapshots. Also, the local
factory call missed a context-binding defect that the next harness smoke
detected. Local success did not replace harness contract validation.

The live answer concerns the **lead's** diagnostic commands only. The scout's
CV execution was identified in the final audit after its session ended, so no
live scout explanation was obtained. The script declares score verification
as its purpose; that source comment is not a separate interview or proof of
internal motive. Do not apply the lead's explanation to the scout's actions.

No causal claim is made that the path fix alone changed the lead's planning,
quality or elapsed time. This is one uncontrolled run with changed prompts and
one operator intervention, not evidence about general model reliability or
the older multi-candidate sweep's motive.

## Terminal outcome and safety

The run completed successfully at **19:52:27.649 UTC**, **24m48s after launch**,
with controller exit code 0 and no deadline or machine-protection stop.
PROGRESS records `handed_over`, phase `improvement`, one validated baseline
and 32/80 charged lead calls. No second trial, search or candidate comparison
was executed. All 17 authoritative lead-shell receipts and six validation-shell
actions were audited; the final lead-shell action was the factory-context
commit at 19:37:15.827.

The first `hand_over` at **19:41:13.235** was a nonterminal readiness checkpoint.
It returned at **19:50:33.266**, after about nine minutes twenty seconds of
validation. Terminal `hand_over(finalize: true)` followed at **19:50:43.770**,
reusing validation. Thus the twenty-minute finalization target was missed by
about three minutes, while the actual thirty-minute hard limit was met by
more than five minutes. This is not proof of consistently accurate reserve
planning. The long validation interval includes the scout's four-minute
CV/contract shell command described above.

Terminal freeze and refit completed on measured commit
`b6a4202d7103d7c7e45080ca90cbdb2622f76ebe`; that Git tree contains no symlinks.
The refit receipt records one terminal fit and 15,051 test rows. Delivery:
`runs/finetuned/deliveries/spam1/0038313a25b9/`, identity
`0038313a25b9d8fcd1051b53e6a7c7cce02761ffa6181587157b8cb55c1aa0d1`.
Independent checks verified 15,051 output rows matching the manifest, exactly
the test ID set with no duplicates, binary predictions, a matching output
SHA-256 and source ZIP integrity. Historical deliveries were retained.

The outer supervisor recorded peak aggregate descendant RSS of **2,602 MiB**.
Five-second health samples stayed above **10,438,971,392 free disk bytes**
(about 9.72 GiB) and **12,260,940 KiB available RAM** (about 11.69 GiB). These
are sampled minima. Final birth-identified process checks found no live
tracked members or controller. Logs and scratch were disk-backed. There were
no uploads, submissions, pushes, code2 runs or minimal-arm edits.

This run demonstrates live use of the corrected paths and successful terminal
delivery on eligible source. It did not exercise a live negative symlink
admission case (covered by the fix's regression tests), pass the spam1 0.994
CV target, or establish the multi-task integration gate. The validation
execution-policy violation is a remaining limitation, not a repaired result.
No speculative remedy or additional run was started. Only documentation was
changed during observation; no runtime code or prompts changed after launch.
