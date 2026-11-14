# Fresh offline spam2 completion, 2026-11-14

The fresh finetuned run delivered successfully on `222781f`, using configured
MythLLM `qwen3.8-flash-next-a5b`. Pipeline exit was zero, final state
`handed_over`, and independent artifact verification passed. Development CV
balanced accuracy was **0.9979384077**. This is not an official test score.

The run took **75 min 27 s (1 h 15 min 27 s)** from controller launch to process
completion, using **93/100** lead calls. Both new budget warnings appeared in
captured feedback. There was no additional wall deadline, hidden allowance,
upload, submission, push, or second experimental run.

## Identity and preservation

- Pipeline: `4cb1fd4f-e2b4-45e4-a266-0c8dd2eb0316`.
- Lead/training invocation: `4e9e7db0-ca53-4b33-bc2f-da012b390531`.
- Lead sessions: `763518db-65c4-4ee0-a816-3bf4f9a3780b`, then
  `6b88dc2d-058c-459b-b1cc-99783be823d9` after context handoff.
- [Langfuse trace](https://cloud.langfuse.com/project/cmumh75f5014jad0dx0f2gn0w/traces/2819c830f575e36da721dca1e79aa107).
- Disk-backed controller, health, preflight, observation snapshots, interventions
  and receipts: `runs/launches/2026-11-14T10-53-16Z-spam2-completion/`.
- Previous spam1/spam2 state and the entire solutions repository were moved to
  `runs/archives/2026-11-14T10-53-16Z-before-fresh-spam2/`. Existing deliveries,
  diagnostics, journals and Python dependency-change records were preserved.

Preflight passed before archiving/launch, including provider and Cloud access.
The fresh solutions tree contained no previous winning implementation. Runtime
prompts and production isolation were used without modeling guidance.

## Harness actions and handovers

Times below are UTC; elapsed time starts at 10:53:49 controller launch. The lead
itself started at 10:54:18. There were **four experiment-start requests, three
executed trials**, three smoke requests, and three hand-over requests.

| Time | Elapsed | Action and outcome | Calls left at nearby observation |
| --- | --- | --- | --- |
| 10:56:55 | 3:07 | Lead requests data and ideas scouts asynchronously | 83 |
| 11:14:00 | 20:11 | Smoke rejects missing `lib` import, with full traceback, no trial charged | about 62 |
| 11:14:23 | 20:34 | Smoke passes after source-relative import repair | about 59 |
| 11:14:44 | 20:55 | Trial 1 starts five-fold stratified CV | about 57 |
| 11:15:24 | 21:36 | Another ideas scout requested while trial runs | about 55 |
| 11:18:21 | 24:32 | Midpoint warning appears in lead feedback | 50 |
| 11:23:17 | 29:28 | Lead stops trial 1 after near-0.50 folds; identifies inverted threshold logic | 37 |
| 11:25:22 | 31:33 | Trial 2 starts on repaired source | about 32 |
| 11:26:01 | 32:13 | Early readiness request returns before trial eligibility | 31 |
| 11:36–37 | about 43 min | Trial 2 completes and promotes: CV 0.9979384077 | 31 |
| 11:37:59–11:41:55 | 44:10–48:06 | Readiness review of trial 2 succeeds; working baseline saved | 30 |
| 11:41:55–11:43:04 | 48:06–49:15 | Context handoff; replacement lead retains budget and baseline | 30 |
| 11:43–11:49 | about 49–56 min | Replacement lead locates workspace, inspects code, edits optional feature; final warning becomes active | 29 down to 13 |
| 11:49:00 | 55:11 | Smoke rejects untracked validation check; lead documents and commits it | about 12 |
| 11:50:10 | 56:22 | Search request rejected: categorical space supplied as array, no fit/process/trial charge | about 9 |
| 11:50:17 | 56:28 | Corrected two-configuration search starts, five-fold plain KFold | 7 |
| 11:58:54 | 65:05 | Search interrupted after one configuration; no promotion | 7 |
| 11:59:15–12:04:23 | 65:27–70:34 | Explicit final handover reviews original champion again, then accepts | 7 |
| 12:04:23–12:09:16 | 70:34–75:27 | Deterministic terminal refit, prediction and verified delivery | 7 |

Trial IDs: first `49bda859-e32d-45bc-8af1-4256962c1966`; delivered second
`6331b9c4-2e39-47bc-9f48-f32a26d18d51`; search
`81d611df-397d-481a-ac35-0f8e7b2fa2c8`.

The search measured its default-off configuration at development CV
0.9979780462. Its cost guard projected **967 s**, exceeding the **900 s**
unacknowledged threshold, and stopped with `acknowledgement_required` after
five fits/one configuration. The optional-on setting was never measured.
These folds also differ from trial 2's stratified folds. This is not evidence
that the new feature helped. Interrupted search evidence was not promoted.

The harness ran five scout sessions: data, two ideas, and two validation.
Validation used `run_checks`; no validation bash route was observed. The final
review explicitly reported that its executed synthetic probe did not complete.
It accepted source-inspection findings with advice, rather than claiming those
unexecuted properties were empirically verified. The delivery gates subsequently
checked the actual refit and prediction artifacts. Review success is not proof
of every claimed model property.

## Local work and live explanations

Shell receipts and scripts distinguish parsing/exploration from actual fitting:

- Initial corpus/header inspection and parser timing probes did not fit models.
- `bash-9b325df4`, 11:08:45: `test1.py` fitted one configuration on 2,500
  development rows, scored those same rows and timed prediction. This actually
  executed (fit 22.8 s); it was not just a rejected command. Its high training
  score was not validation evidence and did not reveal the calibration defect.
- Later `t4.py` calls debugged a revised pipeline on 600 rows, including failed
  attempts followed by a successful single-configuration fit. They were not a
  loop ranking multiple candidates. Regex and diagnostic-script failures were
  visible in retained outputs; piping through `tail` could mask shell exit status.
- `bash-b1690df0`, 11:24:15: `t5.py` fitted calibrated and uncalibrated variants
  on the same 1,000 training rows and compared another 1,000 rows. Development
  balanced accuracy was 0.9820 versus 0.9845. This is a local candidate
  comparison, albeit immediately tied to a specific observed threshold failure.
- The later corpus-wide parsing summary did not fit a model. Internal estimator
  fitting/calibration inside harness trial 1 was part of that legitimate
  pipeline execution, distinct from these local commands.

Two operator questions were sent to the live original lead, at **11:09:59** and
**11:25:09**, using `ask_lead.ts`. Questions, delivery and answers remain in
`runs/finetuned/spam2/lead/operator/`; intervention timestamps are also retained
in the launch directory. Subsequent behavior is therefore an intervened
observation. No third question or retrospective session was used.

The lead described the first fit as plumbing/cost diagnosis: import resolution,
parsing, sparse feature assembly, output shape/domain, vocabulary size and
runtime. It explicitly rejected interpreting resubstitution accuracy as
generalization. It cited informational convenience and mildly lower latency.
For `t5.py`, it acknowledged mixing diagnosis with a genuine two-configuration
comparison, and said the comparison influenced the uncalibrated default while
also describing theoretical reasons and the small score difference as noise.

## Corroboration, causes and uncertainty

The scripts corroborate the first fit's single-configuration timing/diagnosis
purpose, but cannot prove its psychological motivation. No preceding harness
error forced that first local fit: its first smoke request came later.
Successful smoke feedback lacks per-stage timing/internal estimator values;
that supports the claimed convenience difference. Its claim that smoke would
give opaque bug feedback is contradicted by the detailed import traceback it
actually received. Its local probe's custom `sys.path` also failed to test the
exact module-loading boundary that smoke subsequently caught.

The comparison really ran locally. However, the default was already changed to
`calibrate=False` in `bash-d515249a` **before** `t5.py` executed. Its self-report
that the measured difference caused the default change therefore overstates
what the timing establishes. The comparison could have confirmed an existing
choice; it cannot have caused the earlier edit. The calibrated variant's printed
threshold was -0.289496; the uncalibrated variant used zero. Do not summarize
this as both variants empirically selecting a zero threshold.

Concrete failure-and-repair sequence: harness folds exposed near-all-ham output;
the lead found reversed threshold optimization, stopped the faulty trial,
repaired its own implementation and measured the corrected candidate through
the harness. The completed second trial and terminal delivery substantiate
recovery. Local timing convenience and latency are self-reports, not proven
internal causes. No systematic causal conclusion about budget warnings follows
from this single run.

Both warnings reached feedback, but the final warning did not prevent starting
a search with seven calls left. The lead eventually finalized with those seven
unused. The post-readiness replacement session spent calls locating paths and
re-reading source; the receipts establish that overhead, without establishing
why it forgot or assumed the wrong root.

## Outcome, verification and limits

Delivered source is exact commit `f225abe81fd81eabbe48b629b55168e002b433f8`
from trial 2, rather than the newer optional-feature source. Delivery:
`runs/finetuned/deliveries/spam2/ba1225ae0108/` (`output.csv`, `source.zip`,
`manifest.json`). Independent checks verified **12,469** rows, binary values,
unique IDs exactly matching the test archive, manifest/output SHA-256, selected
experiment identity, and a nonempty source ZIP passing CRC inspection.

This run exercises explicit terminal delivery of the retained champion despite
newer live source and an interrupted challenger. It **does not** exercise the
specific repaired branch where a newer promoted champion fails readiness and
the older validated baseline is selected instead: no newer champion promoted.
That branch retains its prior synthetic regression evidence.

First executed trial took about 21 min, and readiness took 48 min, so this run
missed the ten-minute first-trial and 45-minute handover targets. It is a
successful single-task delivery, not a passed spam1–3 integration gate.

Peak supervised process-tree RSS was about **6.63 GiB**. Sampled available RAM
never fell below **8.29 GiB**; disk never below **8.39 GiB**. No machine-protection
or disk stop occurred. Final process inspection found no remaining pipeline,
trial or refit process. No archive or run data was removed.

The copied observer initially falsely rejected delivery because it expected
manifest `arm: finetuned`; production writes `arm: harness`. Pipeline exit was
zero with a success outcome. A separate verifier corrected that observer
assumption and checked all artifacts above. Original `exit.json`, failed receipt
and initial status are preserved alongside `verification-correction.json` and
`spam2-verified-receipt.json`; corrected status reports success. This was an
observer error, not a production-pipeline failure or experimental retry.

No runtime changes or speculative remedies were made during or after this run.
