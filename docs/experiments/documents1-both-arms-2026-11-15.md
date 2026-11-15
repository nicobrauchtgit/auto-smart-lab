# DOCX on both harnesses, 2026-11-15

Archival update: the finetuned task state and solutions tree were preserved in
`runs/archives/2026-11-15T13-24-54Z-documents1-iteration1/` for the
[fresh 150-call retry](documents1-budget150-retry-2026-11-15.md). Deliveries and
minimal state remain in place. That retry document links the verified private
Google Drive backup of this iteration.

Both arms delivered verified predictions and source. Finetuned retained its original validated champion after the challenger failed to earn promotion. Neither arm’s run remains active.

The user authorized `documents1` (Unit 2 task 1, DOCX) on both arms, sequentially, retaining each arm's own Unit 1 Python source. No other documents task ran. Both used the configured offline MythLLM `qwen3.8-flash-next-a5b` and unchanged harness budgets, on repository commit `03dd35c`. No model coaching, operator questions, manual process stops, imposed diagnostic deadline, upload or submission was supplied during these runs.

The common archives, original training labels, reconstructed task material and provenance limitations are recorded in [DOCX setup](unit2-docx-setup-2026-11-15.md). Training has 6,301 samples and test has 2,969. The course metric and complete original individual task page remain unverified; the declared local metric is balanced accuracy. No test labels or instructor scores are available.

## Outcomes

| Arm | Outcome | Wall time | Development result | Calls / sessions |
| --- | --- | --- | --- | --- |
| minimal | delivered and mechanically verified | 26 min 48 s process; 26 min 51 s controller including exit detection | reported 0.9952, five-fold stratified CV on the safety implementation | 49 calls; one solver session |
| finetuned | delivered and independently verified | 1 h 34 min 38 s | delivered original: 0.9948222353; challenger: 0.9949054499, not promoted | 86 of 100 calls; two physical lead sessions, one logical run |

These CV numbers do not establish a winner: minimal used the full labelled corpus and five folds, while finetuned measured on 5,847 development rows with ten folds and reserved the remaining training rows for its private confirmation. Neither number is test accuracy. Minimal's final predictions also differ at three test IDs from the implementation that produced its reported CV score; see below. Private confirmation scores are omitted.

## Minimal: local modeling and delivery

Launch: 00:05:33 UTC. Fresh root: `runs/minimal/2026-11-15T00-05-33/`, with source copied from `runs/minimal/2026-11-11T08-29-56`; originating module hashes are in `source-retention.json`. Old memory, predictions and fitted models were not copied. The solver's standard 30-minute cap and three-consecutive-failure policy applied. It delivered in its first session.

The agent inspected ZIP structure and malformed inner documents, installed `oletools` in its own environment, wrote a static extractor, and extracted all training/test documents. It repaired file-path mistakes inside its jailed filesystem; a mistyped sibling directory did not exist on the host. Some feature extraction was repeated after edits and background jobs overlapped.

An initial richer text/SVD ensemble failed because `numpy.vstack` was used with sparse matrices. The agent then executed a fixed histogram-gradient-boosting model on 3,319 structural/keyword features, with five-fold stratified CV, followed by a full-data fit and test predictions. The command completed in 364 seconds and printed balanced accuracy 0.9952. This is permitted local modeling in the minimal arm.

It simplified the saved task module, added a dependency list, and reran its `solve` entry. The final CSV agreed with the earlier safety predictions on 2,966 of 2,969 rows. The final module had changes including explicit L2 regularization and feature-key filtering; it did not report another CV score for that exact final source. Consequently 0.9952 is corroborated for the precursor diagnostic implementation, not independently established for the final source. No extra fitting was performed by the observer to repair that evidence gap.

The harness accepted `SOLVER_DONE` and mechanically delivered predictions/source. The controller independently verified all 2,969 exact test IDs, uniqueness, binary domain, output SHA-256 and source ZIP CRC. Those checks establish artifact integrity, not classifier quality or exact independent regeneration from the archived source.

Minimal output: `runs/minimal/2026-11-15T00-05-33/logs/deliveries/2026-11-15T00-05-34/documents1/`. Output SHA-256: `705c57b5920b9827caad10d32a47b41d65a48c3a56b408f66cf6577df28392bb`. Source ZIP: 66 files; SHA-256 `2444204078c926e99bea8f0cff2aaf0700463f050d3b771f730a1f20dac2797e`.

[Minimal solver trace](https://cloud.langfuse.com/project/cmumh75f5014jad0dx0f2gn0w/traces/da70e2ae56bff7fef14814b89b9c7cc0).

## Finetuned: agents, handoff and harness measurements

Started at 00:33:04 UTC, after minimal's process tree had exited and its delivery was verified. Existing `runs/finetuned/solutions/` was clean at `d889538`; its own spam modules and helpers were retained. Fresh lead/training invocation: `51ba5ea6-2fa8-47b1-b36c-04331de5059b`. Pipeline: `725474c3-cbd9-4551-ac03-c8e1f240304b`.

[Finetuned trace](https://cloud.langfuse.com/project/cmumh75f5014jad0dx0f2gn0w/traces/91788c01b8e338252773dcfc6d62a0eb).

UTC timestamps; elapsed begins at 00:33:04. Tool counts are the authoritative shared lead allowance; control handovers are free.

| Time | Elapsed | Action | Calls remaining near observation |
| --- | --- | --- | --- |
| 00:33–00:35 | first two minutes | Lead locates the shared solutions mount, reads prior modules, starts input inspection | about 82 |
| 00:35:49 | 2:45 | One asynchronous request starts data and ideas scouts | about 76 |
| 00:44:15 | 11:11 | Ideas scout completes | about 70 |
| about 00:50 | about 17 min | First DOCX parser written; bytes/string and fallback-constant defects are repaired | about 63 |
| 00:53:46 | 20:42 | Initial data scout completes | 54 |
| 00:53:57–01:09:10 | 20:53–36:06 | Local 150-document parser benchmark takes 912.7 seconds, exits normally | 54 |
| 01:11–01:12 | about 38–39 min | Parser rewrite bounds reads/skips media; edit errors repaired; same sample now parses in 7.3 seconds | about 48 |
| 01:13:21 | 40:17 | First smoke passes on committed `f6168af` | about 43 |
| 01:13:53 | 40:49 | First ten-fold stratified harness trial starts | 42 |
| 01:22:17 | 49:13 | Follow-up data scout completes | about 34 |
| 01:22:51–01:24:07 | about 50–51 min | Context handoff after the 100,000-token threshold; same trial and budget retained | 34 at handoff |
| 01:28:18–01:28:25 | about 55 min | New-candidate smoke admission rejected for missing hypothesis/scope; corrected smoke passes | about 20 |
| 01:29:09 | 56:05 | First trial's ten folds complete, development BA 0.9948222353 | about 20 |
| 01:29:55–01:34:45 | about 57–62 min | New physical lead runs one local live-pipeline fit/test-behavior diagnostic | 18 |
| by 01:31 | about 58 min | Original trial completes confirmation and becomes champion | 18 |
| 01:34:52 | 61:48 | Free readiness checkpoint starts a validation scout on frozen original source | 18 |
| by 01:41:39 | about 68 min | Validation passes; baseline is saved; phase becomes improvement | about 17 |
| about 01:42 | about 69 min | Fixed challenger starts on `c91ff38`; baseline remains available | 14 |
| 02:02:53 | 1:29:49 | Challenger comparison completes without promotion | 14 |
| 02:03:23–02:03:41 | about 1:30 | Explicit finalization accepts original validated selection; receipt reused | 14 |
| 02:04:26–02:07:41 | about 1:31–1:34 | Deterministic full-training refit, test prediction and delivery complete | 14 |

Physical lead sessions: initial `0a06cb3b-937c-4fa7-b558-20c352aa5f1e`, replacement `ba14aa43-9000-46ed-aa9c-579ad5038233`. Handoff did not reset the 100-call limit. Data/ideas scouts and the later data follow-up completed; the first validation scout completed successfully. There were no further lead handoffs or validation scouts. The saved validation was reused for terminal finalization.

The first trial was `7c22bbde-9143-46d4-8609-86282b9eea2c` on `f6168af`, ten-fold stratified CV, promotion scope. The fixed challenger is `5b6d9674-7052-4607-81cb-0ac3e219ff17` on `c91ff38`, also ten-fold. It adds OLE-object text and structural columns; it is one candidate, not a parameter-search sweep. The trial's frozen code is independent of ongoing live-tree edits.

### Challenger verdict and final artifacts

The challenger finished ten candidate folds and a ten-fold champion rerun. In that paired comparison, the incumbent mean was 0.9952100834 and the challenger mean 0.9949039851: mean difference -0.0003060983, standard error 0.0004931900, two folds favoring the challenger, three favoring the incumbent and five ties. It corrected three errors and introduced five. The lead did not exceed the noise criterion; no promotion occurred. The aggregate candidate score should not be compared directly with the original trial score to infer improvement: the authoritative paired rerun is the comparison evidence.

Finalization selected original experiment `7c22bbde-9143-46d4-8609-86282b9eea2c`, source `f6168af2496b34b76bd58196532c3a06467c6262`. It reused the successful validation receipt; no newer failed validation had to be bypassed, so this run does not newly demonstrate the separate fallback-after-review-failure repair. It demonstrates retention of a validated baseline when a later candidate does not earn promotion.

Finetuned delivery: `runs/finetuned/deliveries/documents1/d3d0008edb01/`. The final source ZIP contains 13 files, SHA-256 `a4a6fbcff694cadba35b1627e0cbada94887e764bd6e62bca82791c72ad4f712`; output SHA-256 `ac427c31fc62869d24b87158716c8c330316748ccf00d6a47b33b013ab945768`. Independent checks passed for all 2,969 exact test IDs, uniqueness, binary predictions, manifest hash/row count, source ZIP CRC, selected experiment and handed-over status. One terminal refit attempt executed; source and result artifacts passed validation.

### What ran locally in finetuned

Parser/structure/content probes, heuristic-rule scoring and parser timing ran locally. The long benchmark was slow but finite: it exited with code 0 and received no manual cancellation or extra deadline. The same-sample result improved from 912.7 seconds to 7.3 seconds after a combined rewrite; the observation cannot isolate one particular change as the cause of the speedup.

The follow-up data scout also executed a small fixed logistic-regression diagnostic comparing stratified and document-body-grouped CV to investigate duplicate-group effects. Its script/output are preserved under `solutions/scratch/scouts/documents1/research/s6_followup.py` and `s6_out.txt`. It was a split-diagnosis exercise on structural flags, not promotion evidence for the lead's multiview text model. Similar scores in that diagnostic do not prove the full text model is free of duplicate-group inflation; label-pure duplicate groups can still inflate ordinary CV. This remains a limitation of the chosen validation designs.

The replacement lead's `bash-c4c0c36b` fitted one current live-source pipeline on all 5,847 development rows, inspected training decision values, and predicted all 2,969 unlabelled test rows. Fit took 168.9 seconds, test prediction 64.7 seconds; no empty parses were found in the first 400 test documents checked. It used no test labels and did no candidate/C sweep or local CV loop. This was a runtime/behavior diagnostic on a newer source revision, not verification of the frozen champion's exact test behavior or promotion evidence. Its printed in-sample “BA” expression actually computed overall accuracy; it is not a CV result and is not used here as one.

The code contains optional internal threshold calibration, but both fixed trial requests used factory defaults with `calibrate=False`. The routine was not enabled in these requests. Fitting/calibration inside a legitimate harness-run pipeline is distinct from shell-based candidate comparisons.

### Concrete interface friction

The captured opening/system prompts called the source tree `solutions/` and named `solutions/tasks/documents1.py`, but the actual writable mount was `/home/nico/Projects/auto-smart-lab/runs/finetuned/solutions`. The lead spent its early calls searching shallow directory trees and creating/removing an ineffective relative directory before reading `/proc/mounts` and using the actual path. This is direct prompt/mount evidence of ambiguity, not proof of the model's internal cause. No path workaround or coaching was supplied by the observer.

Three smoke calls were observed through the first checkpoint: two executed and passed, one was rejected at request validation because `hypothesis` and `scope` were missing. The rejection started no fit and charged no trial unit; the ordinary tool call still counted. Final counts: three smoke requests (two executed/passed, one rejected before fitting); three experiment-start requests (two executed trials, one dirty-tree rejection); three free hand-over calls (initial readiness, a repeated checkpoint while the challenger ran, and explicit finalization). The start rejection concerned an untracked validation check; committing it allowed the corrected start. It charged no trial unit, while the ordinary call still counted. Of the 86 ordinary lead calls, 52 were bash, 6 writes, 6 edits, 2 read, 5 experiment status, 4 experiment output, 3 smoke, 3 workspace checks, 3 experiment starts and 2 scout requests.

## Evidence and resource safety

Launch records, existing-supervisor controllers, health samples, status, full protected shell receipts, Cloud observation captures and verified-delivery receipts are under `runs/launches/2026-11-15T00-05-19Z-documents1-both-arms/`. Controllers reused `ExperimentSupervisor`, process birth identities and bounded descendant cleanup. Each arm ran alone, with the standard memory protection and a 2 GiB disk reserve. All scratch was disk-backed. No earlier evidence, source, delivery, archive or Python journal was reset or deleted.

The parent observation turn was interrupted around 01:52 UTC, before the
challenger finished. The controller continued through completion at 02:07 UTC.
After the user's continuation request, observation resumed at 03:55 UTC and
verified the delivery and final Cloud records. Events during that gap are
reconstructed from authoritative receipts and telemetry, not claimed as live
parent observations. No operator interview was performed; purposes attributed
to diagnostics here follow their scripts and requests, not a causal self-report.

Sampled free disk stayed above 5.41 GiB for minimal and 3.49 GiB for finetuned; available RAM stayed above 9.68 and 8.51 GiB respectively. Aggregate process-tree peak RSS was 4.81 GiB and 6.66 GiB; aggregate RSS includes shared pages. Neither controller recorded a safety stop. Final free disk was about 4.1 GiB and available RAM about 14 GiB. Both process trees exited, and no cleanup or deletion was required. No production code or prompts were modified for these runs. Source solutions were authored by the configured runtime model. The prior setup commit's fast suite passed 595 tests, skipped two platform-specific checks, and typecheck passed; no new suite is required for run-only documentation, and no merge/push is performed. New run artifacts remain local and have not been uploaded to the earlier Drive backup.

Post-run rehash confirmed the common DOCX data aggregate is unchanged. A host process check found no active experiment entry points. No extra model session or fit was launched for verification.
