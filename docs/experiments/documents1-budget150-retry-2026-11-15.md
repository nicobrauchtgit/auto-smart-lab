# DOCX retry with 150 lead calls, 2026-11-15

The fresh finetuned `documents1` retry delivered all 2,969 predictions in
1 h 43 min 33 s, using 142/150 calls and the requested 60%/15% warnings.
It retained its original validated champion after a cohort pilot and a
challenger that failed paired promotion. Output/source integrity checks passed.
Readiness nevertheless accepted a review whose only dynamic check failed;
that limitation and a local feature-change comparison are recorded below.

The user requested restoration of the exact source baseline from before the
first DOCX iteration. Minimal was not rerun. The completed first iteration
remains preserved and independently backed up; this retry is preserved locally.

## Verified backup and restoration

[Private Google Drive backup](https://drive.google.com/drive/folders/1c8bVPw5kXO0dAtnJ2o7SxTPPjANa9W80):
four ZIPs, 213,487,961 bytes, covering repository code/history, both arms'
DOCX results/source/records, fitted artifacts, and launch/setup evidence.
Downloads passed SHA-256, ZIP CRC and individual inventory-member hashes;
ownership-only permissions were checked. Credentials, environments, caches and
regeneratable malware dataset ZIPs were excluded. Drive flagged the finetuned
archive and required owner acknowledgment for its verification download. The
acknowledged download passed the same checks; no content was executed.
Original evidence was not deleted. Receipts and inventories are retained under
`runs/exports/2026-11-15T13-19-53Z-docx-iteration1-backup/`.

Completed finetuned task state and the complete former solutions tree were
renamed into `runs/archives/2026-11-15T13-24-54Z-documents1-iteration1/`.
Delivery directories and the first minimal run remain at their original paths.
Internal archived absolute paths are retained for provenance; the archive
manifest records how to restore the pair. This retry does not resume that state.

The fresh solutions repository has exact original commit
`d889538e1f93f43b45cb7ca116585619c3dc10fd`, tree
`e438929071b33b26be9c452de4c44ff321d4ebde`, branch `main`, and prior
references whose commits belong to that ancestry. Later DOCX commits/objects,
modules, scratch, findings and checks are absent. The old Git database was
preserved in the archive, rather than reset destructively or exposed to the retry.

Shared task-material hashes are unchanged. Fresh deterministic data preparation
produced an exactly equal split declaration and development ZIP SHA-256
`18bf9b420bd4e87b93953ee20a61dc486ece2aee0c60310d2589f431dbf9c61d`.
The two immutable development-ZIP paths share disk storage after a byte-hash
comparison; neither source code nor learned state is shared with the retry.
Data preparation occurs before the timed run controller and is recorded separately.

## Run contract and validation

The requested changes are the lead limit, 100 to 150, and (after launch of a
partial attempt) warnings at 60% and 15% remaining: 90 and 22 calls. Thresholds
now live in `team.lead.warningRemainingPercent` and
`team.lead.finalWarningRemainingPercent`; existing warning templates render
those values. Other accounting, scout budgets, model, folds/seed policy,
boundaries and completion/fallback behavior are unchanged. No requirement to
try more challengers or modeling hints is added.

Fast suite after updating configured-budget expectations: 595 passed, two
platform skips, no failures (164.62 s). Typecheck and whitespace checks passed.
Initial runs of those tests caught stale 100-call expectations; runtime behavior
was not changed to satisfy them. The full suite remains required before merging;
no merge or push is part of this experiment.

Production `--check-setup documents1` passed without executing stages:
pipeline `c0cefd28-d66e-47a0-ad27-afa33bac93cf`,
[setup trace](https://cloud.langfuse.com/project/cmumh75f5014jad0dx0f2gn0w/traces/2c1750be150a1b6bcdd74e7b619e4207).
The runtime remains offline MythLLM `qwen3.8-flash-next-a5b`, with the existing
session safety bound, no extra diagnostic deadline and a 2 GiB disk reserve.

Launch/observation records:
`runs/launches/2026-11-15T13-46-14Z-documents1-budget150-warning60/`.
The detached controller started at 13:47:05 UTC on `5450830`, with lead/training
run `bbbc95ab-5544-4531-a587-0aa8f6da4e4d`, pipeline
`4d5a44e3-a959-4fd1-aa99-c36449464395`, and initial lead agent session
`71c280fa-f1ac-42f6-93f7-2f3677ded575`.
[Live trace](https://cloud.langfuse.com/project/cmumh75f5014jad0dx0f2gn0w/traces/c2cfa1bb4f2981bea7ccc59c3c03abb1).
Progress confirms the persisted 150-call limit. The controller completed at
15:30:38 UTC with exit 0 and `handed_over` progress.

## Observed execution

The lead first explored development and unlabelled test archive structure,
consulted data/ideas scouts, inspected its own retained spam source, and wrote a
DOCX parser and pipeline. Two file-tool writes were rejected as outside the
persistent solve workspace (14:01:45 and 14:03:04 UTC); the lead then used the
shell at the actual solutions path. Later source/artifact shell inspections
also encountered inaccessible paths. These are interface/access events, not
completed measurements or evidence of a failed training worker.

At 14:06:39 a local single-candidate check attempted to fit 400 development
rows and score another 200. It failed during feature construction with a
list/dictionary type error. After correcting that defect, a rerun started at
14:07:04 and completed successfully (10.0 s fit, 4.5 s prediction, local BA 0.99).
This was a bounded one-candidate fit/score check, not a multi-candidate sweep,
and supplied no promotion evidence. Parser timing/coverage checks are separate
from classifier fitting.

Harness smoke passed at 14:07:41. The first promotion trial started at 14:08:01,
using commit `82c3898078a0769f9e87ab6a3b50048eea9e9766`, ten-fold stratified CV
and the committed pipeline. It completed with development BA
0.9950581683147748 and became champion (`af431d39-2f5e-47c6-a7b0-20801da63104`).
Readiness passed at 14:22:43, saving this selection as the validated baseline
and changing the lead phase to improvement. Validation used `run_checks`;
that call returned `passed: false`, exit 1. The check required a separate
`.labels` file even though this task delivers development labels through its
manifest/member suffixes, so it reported real data unavailable and took a
synthetic fallback. Its `frame()` then reversed archive/member fields and
tried opening `doc_0_0` as the ZIP path. This is a defect in the check itself,
not proof of a pipeline defect. Nevertheless, readiness was accepted without
successful dynamic check evidence. The successful scout/session and readiness
statuses must not be presented as passing that check or proving correctness.
The validation scout used all ten of its calls: eight inspections, one write,
then `run_checks` as call ten. It had no ordinary calls left to repair that
check. Its route enforcement held (no bash); route compliance and successful
validation evidence are different properties.

One context handoff ran from 14:13:34 to 14:14:51, continuing as agent session
`5d828710-ce2f-4c12-b87f-454d8afb630a`. The actual tool-result message at
14:16:01 confirms the first warning: 90 remaining, 60% or less. Budget
accounting continued across the handoff.
A second handoff ran from 14:49:06 to 14:50:34, continuing as
`8b7a1acb-ab5b-411b-a265-c6a6072d48de`; it also retained budget and baseline.
A third handoff, 15:15:10–15:16:22, resumed as
`4c925c8c-a5f6-49e3-91ba-d5e36565aa97` while the challenger continued fitting.
Thus four physical lead sessions belong to the same persisted allowance,
not four fresh budgets.

A second experiment request at 14:23:50 was rejected before fitting because
the validation check was untracked. After committing it, the lead started a
leave-one-cohort-out pilot at 14:24:21
(`3d2c4032-3d17-4c1e-9979-c671019c6093`). It completed with development BA
0.9488639722545176 and was not promotion eligible. It measures a different
split question from the first trial; the two scores are not an accuracy
improvement comparison. The validated baseline remained unchanged.

The lead then wrote `census.py` for corpus/cohort prevalence analysis. Its
first version contained no fit calls despite its header mentioning transfer
fits. A later version added two transfer-direction fits intended to diagnose
errors from the pilot, with reduced feature caps. Neither background attempt
reached those fits: at 14:29:20 and 14:35:55 the lead launched `nohup` children
and let their shell commands end after 20 and three seconds respectively.
Logs contained only startup counts; no census artifact existed and read-only
process inspection found no census process. Follow-up calls slept 45, 90,
100 and 180 seconds before rereading the same logs.

This matches the existing sandbox lifetime contract: bubblewrap's PID namespace
ends with each shell command, so background children cannot outlive that call
(`agent/experiments/README.md`, supervised shell section). The runtime isolation
prompt mentions a PID namespace but does not explicitly spell out this child
lifetime. The evidence establishes a concrete execution mismatch and time
spent waiting; it does not establish why the model continued to expect results.
No operator guidance or runtime change was introduced to correct it mid-run.
At 14:45:19 the lead launched the census in the foreground with a 280-second
timeout. Before that execution it removed the transfer-fit loop and replaced
it with prevalence tables (the old header still mentioned fits). This version
completed with `DONE` and saved `census.pkl`; inspection of the executed script
confirms data analysis only, not an executed model comparison. A timestamped
source/hash capture is retained in the launch folder's `diagnostic-source/`.

After inspecting/revising diagnostic scripts, the lead launched `probe.py` at
14:56:06. It failed before any fit because `Parallel` was not imported. The
corrected rerun at 14:56:18 completed two local fits of the same current
pipeline, training on each development cohort and predicting the other. Its
output reports false-negative/false-positive marker profiles and completes
with `DONE`. This is targeted error diagnosis after a measured transfer
failure, not a multi-candidate ranking sweep; it is still local evidence and
cannot promote a model. The script header describes that diagnostic intent
(self-report); the executed body and outputs corroborate the operation.

The lead then inspected payload-token prevalence with `tokscan.py` (data/feature
analysis, no estimator fits; early executions failed before a corrected run
completed). After changing `lib/docxview.py`, it launched `checkfix.py` at
15:07:00. This script fitted the changed pipeline in both cohort directions
and printed a mean transfer score directly alongside the earlier pipeline's
scores. It completed with `DONE`. Its stated purpose was to verify revived
payload features "before spending harness trials". This is a local before/after
feature-change performance comparison, not just a contract/shape check and not
a multi-candidate sweep. The parser defect and diagnostic work provide context;
the script's explicit comparison establishes what it did, while its header is
only a self-report of intent. The lead prompt directs feature comparisons to
the harness and permits local fitting only for bounded concrete-failure
diagnosis. These local scores do not establish promotion or an official result.

The final warning appeared at 15:12:18 with 22 calls remaining (15% or less).
The lead committed the parser change, corrected an uncommitted INDEX rejection
from smoke, then passed smoke at 15:13:36. At 15:14:07 it started a ten-fold
stratified promotion trial on source `8cf2df0`
(`dad9109a-e1db-4de4-87fe-d31ca63c0921`). Subsequent workspace/INDEX cleanup
left eight ordinary calls at 142 used. The saved validated baseline remained
available while the challenger ran. It completed all ten candidate folds and
ten paired champion reruns, without promotion.

## Measurements, finalization and delivery

| Harness experiment | Scope / folds | Development balanced accuracy | Outcome |
| --- | --- | --- | --- |
| `af431d39` | Promotion / 10 | 0.9950581683 | First champion; validated and delivered |
| `3d2c4032` | Cohort-transfer pilot / 2 | 0.9488639723 | Advisory; not promotion eligible |
| `dad9109a` | Promotion / 10, plus 10 paired champion folds | 0.9955579308 | Eligible measurement; failed promotion |

The final paired comparison measured champion mean 0.9942821626 and challenger
mean 0.9955590492, difference 0.0012768866 against standard error 0.0006703229.
The lead did not exceed the required two-standard-error rule: six folds favored
the challenger, two favored the champion and two tied; ten development errors
were corrected and three introduced. The slightly different trial-summary and
paired-mean values reflect their aggregations; use the paired verdict for
promotion. The cohort pilot asks a different split question and is not a
ranking comparison with the stratified scores. No official test score is known.

Finalization was explicitly requested at 15:28:23 with eight calls remaining,
not forced by exhaustion. At 15:28:32 the harness reused the original validation
receipt and accepted the selected champion; no newer champion failed review,
so the older-candidate fallback branch was not exercised. Terminal source froze
at 15:28:57, refit started at 15:29:01, and artifact validation completed at
15:30:36. Selection stayed experiment `af431d39` / commit
`82c3898078a0769f9e87ab6a3b50048eea9e9766`; later live source was not silently
substituted for the delivered measurement.

Delivery: `runs/finetuned/deliveries/documents1/4cc06918c89a/`.
Independent read-only verification passed exact 2,969 test IDs, uniqueness,
binary output domain, output SHA-256, 13 source files and source ZIP integrity,
and selected measurement/source provenance. Output SHA-256:
`dc4e538b8b2752610be1a882ab5f370e59542f160b6de7fb1623b1a584b38c28`;
source ZIP SHA-256:
`8020a7afce184de978335c213c8678a3ca24c8c96ab7885d7c6c40ee6a60678b`.
Receipts are in the launch folder. These checks establish artifact integrity,
not task accuracy or successful execution of the scout's failed check.

## Calls, decisions and limits of explanation

The 142 counted lead calls comprise 85 bash, 16 edit, eight write, four read,
two ls, eleven experiment status, three output, four start, three smoke,
two workspace checks and four scout requests. Two `hand_over` calls were free.
The four explicit scout requests produced five background consultations; one
checkpoint validation made six scout sessions in total (three data, two ideas,
one validation). Four physical lead sessions shared one persisted budget.

| Decision | UTC | Ordinary calls remaining |
| --- | --- | --- |
| First smoke | 14:07:41 | 117 |
| First promotion trial start | 14:08:01 | 116 |
| Readiness request | 14:16:45 | 88 |
| Readiness accepted | 14:22:43 | 88 |
| Cohort pilot start | 14:24:21 | 82 |
| Challenger start | 15:14:07 | 15 |
| Explicit finalization | 15:28:23 | 8 |

Observed local classifier work was one successful small single-candidate
fit/score check (after a failed attempt), two transfer fits for error profiling,
and two changed-pipeline transfer fits explicitly compared with earlier scores.
Parser benchmarks, archive exploration, census tables and token scans are data
analysis, even where a stale script header mentioned fitting. Internal fits
inside smoke, CV, paired champion reruns and terminal refit were harness-owned.
Rejected writes/smoke/start requests are not executed fits; repeated foreground
script errors and stopped background attempts are not completed comparisons.

No operator interview, coaching or extra run was introduced. The lead's authored
hypotheses and script headers provide contemporaneous self-reports: it wanted
to diagnose cross-cohort errors and verify revived features before spending
trials. Scripts and outputs corroborate those actions and the local before/after
comparison. They do not prove internal causation. Concrete observed friction
includes inaccessible source/artifact paths, short-lived background children,
script defects and budget consumed by inspection/cleanup. No provider failure,
training cost-guard rejection or resource stop forced the local comparison.
This single run cannot isolate an effect of the extra calls: both warnings,
model trajectory and host RAM differ from the first iteration.

## Resource safety and retained evidence

The configured disk reserve remained 2 GiB. Across 1,243 health records,
minimum free disk was 3.51 GiB and minimum available RAM 15.88 GiB. The
supervisor recorded peak aggregate RSS 8.27 GiB (the five-second health samples
peaked at 6.28 GiB and missed that brief peak). No safety stop occurred.
The final supervisor receipt records `exited`, exit 0 and zero retained process
members. Bounded sandbox/session descendant cleanup remained in effect.

The first completed run, the censored partial attempt, delivery archives,
runtime dependency journal and all launch/telemetry evidence remain preserved.
Only the previously verified transfer ZIP duplicates were removed as recorded
above. The new run was not uploaded or submitted, and no speculative runtime
repair, further model session, merge or push followed it. Warning/config code
was already checked with the fast suite and typecheck; this observation update
changes documentation only.


## User-requested warning change and restart

The first 150-call attempt started at 13:31 UTC with the original 50%/15%
warning policy. Its outer controller ended during a conversation interruption,
while the separately supervised pipeline continued. On the user's explicit
restart request, the existing supervisor was reattached to its recorded process
birth identities and stopped the owned tree. No duplicate model run was started.
This partial attempt used 23 calls and completed no trials; it is censored, not
reported as a completed experiment. Its task state and complete solutions tree
are preserved in
`runs/archives/2026-11-15T13-45-01Z-documents1-budget150-before-warning-change/`.

The fresh restart restores `d889538` again and verifies the same split and
immutable development ZIP. Its controller is launched detached so conversation
interruptions do not end monitoring. Final warning/config/template tests passed:
595 tests passed, two platform skips, zero failures (169.44 s); focused tests
and typecheck also passed. Threshold ordering/range is checked before sessions.

The host now reports about 23 GiB total RAM; iteration 1 reported about 15 GiB.
This is an observed hardware difference, not a change made by the controller.
Source/data baseline equality does not make timing or resource comparisons a
pure test of the larger tool budget. Data preparation is outside timed launch.
