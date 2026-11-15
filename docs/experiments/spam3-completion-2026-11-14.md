# Offline spam3 completion, 2026-11-14

The authorized finetuned spam3 run **delivered successfully in 41 min 11 s**,
using **54/100 lead calls** on `aae2876` (runtime unchanged from `222781f`).
Delivered development CV balanced accuracy: **0.9978322628**, not an official
test score. The pipeline exited zero and independent delivery verification passed.

## Conditions, identities and preservation

Configured offline MythLLM `qwen3.8-flash-next-a5b`, normal production prompts,
isolation, supervision, scouts, training, validation and refit. No extra wall
deadline or modeling guidance. No uploads, submissions, pushes or extra task runs.
Preflight, including provider and Langfuse access, passed before launch.

This was a fresh spam3 task with **shared solutions retained from the successful
spam2 run**, rather than a fresh empty solutions repository. A complete 7.4 MiB
copy was preserved under
`runs/archives/2026-11-14T13-04-43Z-before-spam3/solutions/`. One untracked
check from spam2's final scout was moved into that archive before launch to
retain it while starting with a clean shared tree. No earlier task state,
delivery, journal, diagnostic or Python change record was reset or removed.

- Launch evidence: `runs/launches/2026-11-14T13-04-43Z-spam3-completion/`.
- Pipeline: `a8f13e73-7594-48de-be93-3ea178084224`.
- Lead/training invocation: `f14f81f3-11b7-4c51-92a0-3bf100479a50`.
- Lead agentRunId: `3f7afa14-a4b2-448e-adfc-7dc3c22c2f0f`.
- [Langfuse trace](https://cloud.langfuse.com/project/cmumh75f5014jad0dx0f2gn0w/traces/6dc5ccdb9354e1aba11bc9c8f57d4cf4).

Only one lead session was observed, without a context handoff. It requested
data and ideas together asynchronously; both completed. One validation scout
completed through the intended `run_checks` route. The midpoint warning appeared
in feedback; the lead never reached the 15-remaining threshold.

## Harness execution and handovers

UTC timestamps; elapsed time begins at controller launch, 13:05:49.

| Time | Elapsed | Action and outcome | Calls remaining near observation |
| --- | --- | --- | --- |
| 13:07:41 | 1:52 | Data and ideas scout request | 87 |
| 13:11:08–13:20:50 | 5:19–15:01 | One model request takes 9 min 42 s, then attempts write at wrong solutions path; write rejected | 84→83 |
| 13:21–13:25 | about 16–20 min | Corrects paths, authors parser/pipeline, repairs copy and Git identity errors | about 81→71 |
| 13:25:36 | 19:47 | Smoke catches predict-time `KeyError: 'sk'`; detailed feedback, no trial charged | about 71 |
| 13:27:57 | 22:08 | Smoke passes after view-key repair and commit | about 63 |
| 13:28:07–13:28:23 | 22:18–22:34 | Three start requests rejected by tool argument schema | about 62→60 |
| 13:28:50 | 23:01 | Corrected request starts first ten-fold stratified trial | 58 |
| 13:30–13:32 | about 25–27 min | First trial completes and promotes, development CV 0.9978322628 | 56 |
| 13:33:11–13:38:32 | 27:22–32:43 | Readiness checkpoint and validation; working baseline saved | 55 |
| 13:39:58 | 34:09 | Local fixed-pipeline development fit and unlabelled-test runtime probe | 52 |
| 13:41:34 | 35:45 | Challenger request rejected for untracked validation checks; lead documents and commits them | about 50 |
| 13:41:54 | 36:05 | Challenger trial starts; midpoint warning active | 46 |
| 13:45 | about 40 min | Paired comparison completes: ten ties, no promotion | 46 |
| 13:45:43 | 39:54 | Explicit finalization rejected: reason exceeds 1,000 characters | 46 |
| 13:45:48–13:45:53 | 39:59–40:04 | Shorter finalization accepted; existing validation reused | 46 |
| 13:46:56–13:47:00 | about 41 min | Terminal refit/delivery completes; controller confirms success | 46 |

There were **six experiment-start requests and two executed trials**, two smoke
requests, and three hand-over requests (one readiness, two explicit finalization).
The three initial malformed starts wrapped a JSON string in `request` rather
than supplying the documented top-level typed object. These rejections executed
no fits and used no trial units, while ordinary tool admissions still counted.
The later dirty-tree rejection likewise started no worker. The rejected final
hand-over was a schema failure, not a failed model review.

First trial: `7e132db1-4707-4c1b-bc00-76ecb2ed6114`.
Challenger: `8139c4e0-7b96-4cc3-9ef9-51653ad11548`, enabling an additional
flat-HTML character feature block through fixed factory parameters. Challenger
development CV was **0.9984557042**. In the authoritative paired rerun, both
models had identical per-fold scores on all ten folds: mean difference zero,
zero corrected/introduced errors, no lead exceeding noise. The apparent increase
over the earlier trial's aggregate therefore did not justify promotion.

## What actually ran locally

The lead's initial scripts inspected development HTML, encodings, page sizes,
structure and feature distributions, without fitting classifiers.

After smoke exposed the view-key defect, `bash-c4982a6e` at **13:26:13** fitted
one configuration on 400 development rows. It checked fit/predict timing,
prediction domain, repeatability and finite decision values. Fit took 2.5 s,
prediction 1.1 s. A later single-configuration 700-row diagnostic examined score
quantiles and class separation. One intervening diagnostic command failed at
Python syntax parsing before fitting. These were distinct from a candidate sweep.

The 400-row diagnostic's printed `train BA` was incorrectly calculated as
half the sum of mean predicted values in the two classes, omitting the complement
for class zero. It printed 0.5 even though predictions included both 0 and 1.
That number cannot establish a degenerate classifier or generalization accuracy.

`bash-117760c7` at **13:30:27** executed `probe_leak.py`, piped through `tail`.
The script combined member-stem and template investigations with a genuine
feature-family comparison: text, tag stream, skeleton characters, metadata,
their combination, then a permuted-label control. **Six settings × three seeds
× five folds = 90 classifier fits.** The completed output contains each result;
this was not merely proposed code or a rejected request.

The comparison fitted TF-IDF/scaling on the complete development population
before its classifier folds. It therefore did not reproduce harness fold-local
preprocessing, and its high scores are not independent promotion evidence.
The permuted-label result near chance is a limited control, not proof of the
absence of all leakage. Its homemade template grouping is also exploratory,
not an established grouped-validation protocol.

`bash-cbc6f314` at **13:39:58** executed `delivery_probe.py`: one fixed pipeline
fit on all development rows, then prediction of unlabelled test inputs and
output-domain/runtime checks. No test labels were read and no test accuracy was
measured. This was another actual local fit, distinct from the harness's final
all-training-data refit. No local search after that probe was observed.

## Live explanations and corroboration

Two concise operator questions went to the original live lead at **13:27:16**
and **13:31:05**, through `ask_lead.ts`. Their questions, delivery records and
answers remain under `runs/finetuned/spam3/lead/operator/`; interventions are
timestamped in the launch directory. Later behavior is an intervened observation.
No third question, retrospective model session or behavioral coaching was used.

For the first local fit, the lead reported contract/cost diagnosis following
smoke's crash, with **latency** the main reason: a few seconds locally versus
its claimed one-to-two-minute smoke round trip. The crash and single-config
script corroborate a concrete diagnosis trigger. Actual first smoke took
18.7 s and the passing repeat 5.5 s, so the asserted smoke latency is overstated.
Its explanation called the 400-row output all-zero predictions; retained output
instead lists both classes and the incorrect metric formula above. Local file
writing restrictions and scratch-to-solutions copying do exist, but the evidence
also shows incorrect root/relative-path choices that the lead repaired itself.

For the ablation, the lead reported a leakage concern prompted by supposedly
perfect folds, **cost** as the dominant reason to work locally, and latency as
secondary. It acknowledged that the ablation was more than the control required
and should not be described as pure diagnosis. It said it did not use those
numbers to select the shipped configuration, which had already been committed.
The eventual delivery of that pre-probe source corroborates the narrow claim
that the table did not replace the shipped model. It does not erase the actual
local multi-candidate comparison, contrary to the runtime instruction.

Two additional discrepancies limit the explanation: the completed first harness
trial was not perfect (six OOF errors), and the local script had six settings,
not the explanation's eight. Its claim that every configuration necessarily
requires a separate charged trial is not the general harness contract: search
can measure multiple configurations under one experiment/budget unit. No actual
trial-budget exhaustion, search cost-guard rejection or unavailable training
service preceded this local comparison. Cost motivation remains a self-report;
the evidence supports an anticipated-cost decision, not a forced workaround.

## Delivery, reuse, safety and remaining limits

Final state `handed_over`; pipeline outcome success, exit zero. Delivered exact
champion commit **`bc85cbd8969abaa25fb7d39f64701ae6ed19ca89`** in
`runs/finetuned/deliveries/spam3/b30226d9fe4e/`. Independent checks verified
**2,757** binary predictions, unique IDs exactly matching the test archive,
manifest/output SHA-256, selected experiment identity, and a nonempty source ZIP
passing CRC inspection. The controller's manifest-arm check used the corrected
`harness` value from the outset; no observer false failure occurred.

The delivered pipeline imports `lib/rawsample.py` from retained spam2 solutions.
Git comparison confirms that reader was unchanged between the pre-spam3 shared
commit and the delivered commit: this supplies concrete source-reuse evidence.
The HTML parser and spam3 pipeline were new task-specific code.

Peak supervised process-tree RSS: **2.49 GiB**. Sampled available RAM stayed
above **12.00 GiB**, disk above **8.10 GiB**. No memory/disk safety stop occurred.
Final process inspection found no remaining pipeline, trial or refit process.
Logs, authoritative receipts, health and archived prior state remain disk-backed.

First executed trial took **23 min 03 s**, missing the ten-minute target.
Readiness was accepted at **32 min 43 s**, terminal handover at **40 min 04 s**,
and delivery observed at **41 min 11 s**. This is successful single-task delivery
within 45 minutes; it is not a newly passed spam1–3 gate. It also did not exercise
fallback from a newer promoted champion that fails readiness: the challenger
never promoted. That repair retains its synthetic branch-specific evidence.

No runtime changes or speculative remedies were made during this experiment.
