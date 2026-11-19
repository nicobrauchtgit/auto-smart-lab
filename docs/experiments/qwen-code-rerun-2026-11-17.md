# Qwen code/attacks rerun on the clustering base (2026-11-17)

User-authorized rerun of code2, attacks1, code3 and code1, both arms, after resetting both arms to the state right after documents4. Launch records: `runs/launches/2026-11-17-qwen-code-rerun/` (status.json, reset receipt). Base: main 4c983d2, patch 98340412…, refit framework b71783fc…; details in `runs/launches/2026-11-16-qwen-unit2-continuation/base-2026-11-17-clustering.json`. Earlier results on the old base: `docs/experiments/qwen-unit2-continuation-2026-11-16.md`.

2026-11-17T16:10Z: observer check. code2 minimal running since 15:39Z on a new snapshot (`snapshot-1794929967405`). After 31 min: 61 solver tool calls, still exploring the data. RSS about 390 MB, 21 GB RAM available, 25 GB disk free. No data from the reset run state was reused: the agent recreated `work/code2` at 15:41Z.

2026-11-17T16:16:17.794748+00:00 — code/attacks workflow stopped on a concrete check: Step failed; inspect code2-minimal-controller.log. Inspect preserved receipts. No later arm/task launched.

## User decision: no minimal rerun (2026-11-17, ~16:15Z)

The clustering/trial-feedback change touches only `harness/finetuned/`. A diff of `2a9bab2..9b05d3a` shows `harness/minimal/`, `experiment/`, `units/` and `resources/` untouched. The old-base minimal results for code2, attacks1, code3 and code1 therefore stay valid. They are in `docs/experiments/qwen-unit2-continuation-2026-11-16.md`, and their Drive folders are kept, not trashed.

- **Stopped attempt:** the code2 minimal attempt (15:39–16:16Z, about 37 min, still exploring) was stopped with SIGTERM to its controller (state `stopped`). The minimal run folder was restored to the post-documents4 snapshot. All removed files are hashed in `restore-minimal-receipt.json`; the attempt's own snapshot was identical to the restore point and was removed.
- **Workflow:** `workflow_code.py` now runs the finetuned arm only and was relaunched at ~16:17Z. code2 finetuned started after a passing setup check.
- **Minimal state:** the minimal run's state after code1 is not available locally any more, since the reset removed it. The minimal Drive backups hold its code, logs, submissions and resources, but not its binary work caches.

2026-11-17T16:40Z: observer check. code2 finetuned has run for 23 min (since 16:17Z): lead phase `baseline`, 18 of 150 calls used, no trial result yet. RSS about 330 MB, 21 GB RAM available, 27 GB disk free.

2026-11-17T17:10Z: observer check. code2 finetuned has run for 53 min, phase `improvement`, 63 of 150 calls used, 2 trials.
- Champion `727bb145`: anchored ARI 0.636 over 4 folds × 1 repeat (fold range 0.359–0.918, sd 0.244, 525 labelled rows). The test partition is identical across all fits (test agreement 1.0, 6 comparisons); singleton fraction up to 0.03. Fit time 146 s, trial 78 s.
- Resources: RSS about 360 MB, 18 GB RAM available, 27 GB disk free.

## Hold: metric-bound bug (2026-11-17, ~17:25Z)

The Google observer found that `harness/finetuned/agent/training/results.ts:429` rejects any primary metric above 1 as `invalid_result`.
- **How it was hit:** sklearn average precision can exceed 1 by floating-point rounding. Google's attacks1 rerun had an eligible first trial with evidence AP 1.0 in every fold, mean 1.0000000000000002. It was never promoted ("Champion now: none yet"), and the lead used up all 150 calls without a delivery.
- **Scope:** the check predates today's change and is present in main `4c983d2`. Any task whose fold scores land at about 1.0 can hit it.
- **Qwen:** code2 finetuned is unaffected so far (champion ARI 0.636, fold max 0.918).
- **Hold in place:** `stage_code.py` now refuses to stage while `HOLD_STAGING` exists. code2 closes out normally, then the workflow stops at the attacks1 staging step (state `failed`, reason pointing to `adv-staging.log`).
- **Waiting for:** the user's decision on the fix.

2026-11-17T17:40Z: observer check. code2 finetuned has run for 83 min, 88 of 150 calls used, 4 trials.
- New champion: anchored ARI 0.897 (trial `ba637e39`, folds 0.808–0.947, test agreement 1.0). Trial `2b5eea0b` is close behind at 0.896 (folds 0.857–0.921).
- Other trials: `727bb145` 0.636; `82bc5119` interrupted at 0.499.
- No trial is near 1, so the metric-bound bug has not been hit.
- The hold files `HOLD_STAGING` and `CODE1_HOLD` are in place. 22 GB RAM and 27 GB disk free.

## Metric-bound fix applied (user decision, 2026-11-17 ~17:45Z)

The range check in `training/results.ts` now tolerates 1e-9 of rounding at both bounds. A mean of 1.0000000000000002 passes; 1.01 is still rejected as `invalid_result`. One test was added to `results.test.ts`.
- **Checks:** the results tests pass (11 of 11) and typecheck passes.
- **Records:** the patch is in `runs/launches/2026-11-17-qwen-code-rerun/metric-bound-fix.patch`, and the change is noted as a follow-up in the base record. The file is not part of the refit framework hash.
- **code2:** the running code2 finetuned process loaded the old check before the fix. No score there is near 1, so it is unaffected.
- **Next:** `HOLD_STAGING` was removed, so attacks1 starts on the fixed code once code2 closes out.

2026-11-17T18:10Z: observer check. code2 finetuned has run for 113 min, 130 of 150 calls used, 5 trials. Two sealed confirmations, both observer-only:
- Earlier champion `727bb145`: CV 0.636 but sealed ARI 0.352 [0.262, 0.443], gap 0.284 (16:50Z local log time). The cross-validated score did not hold up on the sealed rows.
- Current champion `ba637e39`: CV 0.897, sealed ARI 0.863 [0.741, 0.958], gap 0.033. 8 clusters among 132 sealed rows, 7 test-part clusters.
- Resources: RSS 1.2 GB, 21 GB RAM available, 27 GB disk free.

2026-11-17T18:18:02.615575+00:00 — code2 finetuned: delivered 355 predictions; exact IDs, domain, hashes and source ZIP checks passed.

2026-11-17T18:18:15.269302+00:00 — code2 finetuned: private Drive round-trip verified; https://drive.google.com/drive/folders/1h2b8yaQOPUOWzZJUPRKm8VH0wMuaQHIo

2026-11-17T18:18:15.327566+00:00 — code2: finetuned rerun complete and backed up; task data removed (hashes in dataset-cleanup.jsonl).

### code2 finetuned rerun: delivered (2026-11-17, 16:17–~18:20Z)

- **Delivery:** handed over after 133 of 150 lead calls. Champion `ba637e39` (commit `3b63fa5`): anchored CV ARI 0.897 (4 folds, 0.808–0.947); sealed ARI 0.863 [0.741, 0.958], gap 0.033. Delivered 355 test predictions in 7 clusters (155, 79, 51, 42, 20, 5, 3). Exact IDs, domain, hashes and source ZIP verified.
- **Trials:** 5. The first champion `727bb145` (CV 0.636) had sealed ARI only 0.352. The sealed check was observer-only, so the lead never saw it; its next champion replaced it on CV alone.
- **Backup:** private Drive round trip verified, folder `1h2b8yaQOPUOWzZJUPRKm8VH0wMuaQHIo`. `php-train-dev.zip` and the two `sealed.zip` files were excluded with hashes, and the local ZIP was deleted after verification. The old-base finetuned code2 folder `1poD--HZnlp12pebeOcWijYSkNcMA_HgK` went to Drive trash at 18:18Z (`replacedOldFolder`). The PHP data was removed with a hash receipt.
- **Arm context:** minimal code2 (old base, unchanged harness) delivered 5 clusters, with the agent reporting 0.889. The old-base finetuned number (CV ARI 0.718, sealed 0.742) is not comparable because folds and scoring differ.
- **Earlier log line:** a stale workflow line "Step failed; inspect code2-minimal-controller.log" comes from the stopped minimal attempt (16:16Z), not from this run.

attacks1 finetuned started at about 18:20Z with the metric-bound fix; its setup check passed. The Google observer reports that its attacks1 rerun delivered all zeros: the champion's `predict` returned 1/0 instead of the declared anomaly label -1. The user has not yet decided whether the harness should flag that pattern, so Qwen's attacks1 runs on the unchanged contract.

2026-11-17T19:10Z: observer check. attacks1 finetuned has run for about 50 min: lead phase `baseline`, 51 of 150 calls used, no trial result yet. RSS about 340 MB, 22 GB RAM available, 25 GB disk free.

2026-11-17T19:2xZ: code1 slot handed to Google. Its code3 finetuned rerun delivered with sealed ARI 0.986 and 57 clusters, and Google stages code1 after its code3 cleanup. Qwen holds no code1 data, and `CODE1_HOLD` stays until Google reports its code1 cleanup.

2026-11-17T19:40Z: observer check. attacks1 finetuned has run for about 80 min: phase `baseline`, 109 of 150 calls used, and no harness trial yet. The single training folder holds only a lock file. The lead has spent its calls on 78 shell experiments in its scratch space (`diag*.py`, `ens.py`, cached probability arrays), currently debugging its own detector class (IndexError, AttributeError). There is no `solve/agent/evidence.json` yet. Without a trial and a validated hand-over in the remaining 41 calls, this ends without delivery. No intervention (no coaching). Disk 19 GB free: Google's code1 is staged. RAM 20 GB available.

2026-11-17T19:5xZ: Google finished its finetuned rerun. Its code1 delivered 54 clusters with sealed ARI 0.668; its code1 data was removed (8.17 GB, receipt in its checkout) and it holds no unit data. `CODE1_HOLD` is removed, so Qwen stages code1 when its workflow reaches it, after attacks1 and code3.

2026-11-17T20:10Z: observer check. attacks1 finetuned is at 145 of 150 calls. The lead wrote `solve/agent/evidence.json` (19:45Z) and ran one harness trial, `06de253a`: completed, promotion-eligible, evidence AP 0.396 (proxy evidence, 2,990 rows, fit 110 s). It is the champion, and the metric-bound fix is not involved. The flagged share is not in the digest because no completed fold measurement is available. The outcome (hand-over or budget end) is pending. 26 GB disk free.

2026-11-17T20:40Z: observer check. attacks1 finetuned is at 148 of 150 calls (last progress write 20:34Z). The process is alive, at low CPU while waiting on the model; still one trial (AP 0.396), no hand-over yet. 26 GB disk free.

## Hold: anomaly-label contract fix (2026-11-17, ~20:45Z)

The user asked, via the Google observer, to hold before the next run while a harness fix is deployed to the main working tree.

- **The contradiction:** the course page and unit both say "1 = adversarial", but the attacks1 declaration sets `anomalyLabel` to -1 (scikit-learn's convention), and the lead prompt asks for -1. Google's attempt 2 returned 1 for adversarial images, so the harness delivered all zeros.
- **Fix 1:** attacks1's `anomalyLabel` becomes 1.
- **Fix 2:** a predict-contract check. A pipeline that never returns the declared anomaly label (or returns it for every row) is reported at smoke and cannot become champion.
- **Who builds it:** gpt-6.1-sol implements, Opus reviews, and the full suite runs before deployment.

`HOLD_STAGING` is set, so the workflow cannot stage code3. The current attacks1 run (148 of 150 calls, one trial with AP 0.396) finishes and closes out as usual. No relaunch until Google reports the fix deployed and verified.

**Proposed Qwen order:** restore the finetuned memory to post-code2 from the verified code2 rerun backup, rerun attacks1, then code3 and code1. This keeps the original task order, which is possible because Qwen has not run code3 or code1 yet. Google ran code3 and code1 with its attacks1 attempt-2 memory present and reruns attacks1 last, so the two observers end up with a different order.

2026-11-17T20:50Z: Google agreed on the order. Qwen restores to post-code2 and then runs attacks1, code3, code1; Google removes only its attacks1 traces and runs attacks1 last. Google records the different order. `HOLD_STAGING` stays until Google reports the fix deployed and verified. Qwen attacks1 is still at 148 of 150 calls.

2026-11-17T20:51:21.281894+00:00 — code/attacks workflow stopped on a concrete check: Step failed; inspect attacks1-finetuned-controller.log. Inspect preserved receipts. No later arm/task launched.

### attacks1 finetuned rerun: no delivery (ended ~21:05Z)

- **How it ended:** the lead used all 150 calls. Most went to scratch experiments; the first harness trial came at 19:48Z. Three trials, all completed and promotion-eligible: evidence AP 0.396 (`06de253a`, champion), 0.391 (`28e65ec4`) and 0.412 (`99dd83f8`). The champion failed the lead's own validation: its content-manifold deviation term has different semantics on scored rows than on fit rows (`tasks/attacks1.py:277-284`). The calls ran out before a fix and hand-over, and the pipeline outcome is a failure.
- **Not superseded by the metric-bound fix:** no score was near 1. The anomaly-label contract problem did not arise either, because no delivery was made.
- **Backup failed:** the Drive upload was refused with HTTP 403. The Drive account is full: 14.93 of 15 GiB used, including 0.73 GiB of trash. The local archive (`attacks1-finetuned-rerun.zip`, 116 MB) and its inventory are kept, and the old-base attacks1 Drive folder was not trashed. The upload is pending a decision on Drive space.
- **Data kept:** the adv data stays staged, because attacks1 is rerun next after the contract fix.
- **Qwen is idle:** no Qwen harness process is running. The processes left belong to Google's fix worktree on CPUs 4-7.

## User decision: attacks1 runs last (2026-11-17, ~21:30Z)

Both sides run code2 → code3 → code1 → attacks1, and no code task is rerun because of attacks1.

- **Qwen memory:** Qwen did nothing between code2 and attacks1, so "remove only the attacks1 attempt's traces" equals the post-code2 state. Finetuned memory was restored from the verified code2 rerun backup, downloaded from Drive with a sha256 match (`30ef019b…`). Result: solutions HEAD `abaa701`, including code2's own uncommitted probe files; 23 tags, none for attacks1; findings journal 524 lines, an exact prefix of the 580-line live journal.
  - This is more exact than deleting files: during attacks1 the lead had also committed two leftover code2 probe files (`f12f798`, `5294be5`).
- **Removed:** `runs/finetuned/attacks1`, the 4 attacks1 tags, 56 attacks1 board entries and the staged adv data. 2,329 files are hashed in `remove-attacks1-receipt.json.gz`.
- **Attempt records:** moved to `attacks1/finetuned-attempt1` and `attacks1/backup-finetuned-attempt1`. Its local backup archive (116 MB) is still waiting for Drive space.
- **Workflow:** order changed to code3, code1, attacks1. The superseded attacks1 record is ignored.
- **Recorded asymmetry:** Google's code3 and code1 ran with its failed attacks1 attempt's memory present; Qwen's run without it.

Still on hold (`HOLD_STAGING`): waiting for the Google observer to deploy the contract fix, and for the user's decision on Drive space.

## Drive space freed (user decision, 2026-11-17 ~21:45Z)

The user said "we only need our newest submissions". On that basis the Google observer emptied the Drive trash and permanently deleted the old-base Qwen code1 finetuned folder (2.37 GB); its receipt is in the Google checkout, `runs/diagnostics/google-rerun-20261117/drive-cleanup-receipt.json`. The quota is now 11.89 of 15 GiB, with 3.1 GiB free.

- **Backup script:** `backup_task.py` now records `replacedOldFolder.alreadyDeleted` when the old folder returns 404, instead of failing after a verified upload. Without this, the code1 replacement would have failed.
- **attacks1 attempt archive:** the failed-attempt archive (`attacks1/backup-finetuned-attempt1`, 116 MB) is not uploaded, because only the newest submissions are wanted. It stays local, and its empty Drive folder `1FZaooVmsaKj_FH9Tc4YoJtDm0JSBJXj0` is left as is.
- **Still on hold:** only the contract-fix deployment.

## Anomaly output-contract fix deployed (2026-11-17, ~22:10Z)

The Google observer deployed the fix to the main tree: patch sha256 `c6f4d8eb…6aed`, 24 files, from branch `t3/anomaly-output-contract-1` (`24e9738`→`9d30493`). The reverse-apply check is clean here.

- **Changes:**
  - attacks1 declares `anomalyLabel` 1, and the lead prompt says predict returns 1 for anomalies and 0 for normal rows.
  - For label-1 tasks, predict values outside {0,1} are a contract violation.
  - A trial whose predict never or always returns the anomaly label across all folds cannot become champion.
  - Binary classification and clustering are unchanged.
- **Google's checks:** typecheck passes, targeted tests 10/10, full bun suite 778 pass with 1 known pre-existing failure, `test:py` 175 OK.
- **New hashes:** refit framework `2e6b3ddf…`, tree `e9b79968…`, `pipeline.config.json` `13789c0a…`. The new and changed anomaly prompt hashes are in the base record's `followUpFixes`.
- **Applies to:** code3, code1 and attacks1 on the Qwen side.

`HOLD_STAGING` was removed and the workflow relaunched for code3 → code1 → attacks1.

2026-11-17T22:15Z: Google attacks1 finetuned attempt 3 launched at 21:49Z. The Google observer notes that the findings journal requires `cursor` == line number (`agent/team/journal.ts`); filtering lines out of the middle breaks `readFindings`. Qwen restored a prefix, so it is unaffected. Drive rule ("only newest submissions"): at the end, Qwen trashes the empty failed-attempt folder `1FZaooVmsaKj_FH9Tc4YoJtDm0JSBJXj0`. Emptying the shared trash is coordinated with Google.

2026-11-17T22:3xZ: Google finetuned rerun complete, and its schedules are disabled.
- Google attacks1 attempt 3 (fixed contract, run last): 217 of 2,990 flagged (7.3%), champion evidence AP 0.990, 109 of 150 calls. It matches the original minimal output on 2,600 of the images.
- Google table: code2 4 clusters (sealed 0.864); code3 57 clusters (0.986); code1 54 clusters (0.668); attacks1 217 flagged.
- Google holds no data or processes, and Drive usage is about 12.09 GiB after its trash was emptied.

2026-11-17T22:40Z: observer check. code3 finetuned has run for 53 min, phase `baseline`, 40 of 150 calls used, no trial result yet. RSS about 360 MB, 22 GB RAM available, 21 GB disk free.

2026-11-17T23:0xZ: user decision via Google: run the Tor unit overnight on both sides after the current reruns, tor1 (closed world, new multiclass kind) and tor2 (open world, binary), minimal and finetuned. Google deploys the multiclass and Tor declaration patch to the main tree only while Qwen is between runs. `CODE1_HOLD` was set again, so Qwen pauses after code3 (state `waiting_code1_slot`). That pause is the deployment window and the disk check: at least 12 GiB free is needed before staging code1.

2026-11-17T23:10Z: observer check. code3 finetuned has run for 83 min, 78 of 150 calls used, phase `baseline`, no champion yet. One trial result: `aad0b0d6`, status `interrupted`, anchored ARI 0.989 on its completed folds (0.985–0.994), test agreement 0.995. RSS 730 MB, 12 processes; 21 GB RAM available; disk 18 GB free, with Google Tor data staged.

2026-11-17T23:40Z: observer check. code3 finetuned has run for 113 min, 86 of 150 calls used. Champion `5e176046` (completed, promotion-eligible): anchored ARI 0.990, test agreement 0.997. Interrupted trials: `aad0b0d6` 0.989 and `c2736482` 0.937. Disk 18 GB free, 22 GB RAM available.

2026-11-18T00:10Z: observer check. code3 finetuned has run for 143 min, 106 of 150 calls used. Sealed confirmation of champion `5e176046`, observer-only: CV 0.990, sealed ARI 0.989 [0.976, 0.998] on 331 sealed rows. The lead is in validation and hand-over territory. Disk 18 GB free.

2026-11-18T00:3xZ: Google reports a minimal-arm format gap for Tor. `harness/minimal/agent/run/output_check.ts` and `instructions/solver.md` accepted only `<id>;<integer label>`, so tor1 website names could not be submitted; Google minimal tor1 attempt 1 ended without a delivery. Google's fix accepts `<id>;<label>` with a single-token label (format only). It changes the solver prompt hash, so the minimal chain's `chain-version.json` promptHash must be updated with a receipt. The fix goes into the main tree in the same deployment window as the multiclass patch. Qwen runs no minimal Tor before it is applied.

2026-11-18T00:40Z: observer check. code3 finetuned is at 114 of 150 calls (173 min), champion `5e176046` (CV 0.990, sealed 0.989), not yet handed over. Disk 18 GB free.

2026-11-18T01:10Z: observer check. code3 finetuned is at 127 of 150 calls (203 min), 6 trials, champion `5e176046` (CV 0.990, sealed 0.989). Its one validation attempt returned `verification_incomplete`: the validator found that the `predict(same_rows=False)` branch assigns all unseen rows to one cluster when fit and predict rows differ. That branch is not the batch `fit_predict` path used for delivery. There is no hand-over yet; it either hands over in the remaining 23 calls or ends without delivery. Disk 17 GB free.

2026-11-18T01:40Z: Google tor1 is done in both arms. Minimal delivered class indices 0-29 instead of names, which is the model's error; finetuned had no delivery (the champion was blocked by validation, then 150 of 150 calls were used). The deployed multiclass code worked end to end on the Google side.
- Disk plan: Google stages tor2 now (about 7.5 GB with finetuned copies). Qwen code1 (about 8 GB peak) waits behind `CODE1_HOLD` until Google's tor2 cleanup.
- Observer plan (user may veto): at the code1 pause, Google deploys the multiclass patch (`80760741…`), the minimal label fix (`902c8241…`) and the Tor registration. Qwen then runs tor1 (about 1.3 GB) in both arms while waiting, then code1, attacks1 and tor2. This reorders "Tor after the reruns" because of disk and the morning deadline.

2026-11-18T02:56:50.559584+00:00 — code/attacks workflow stopped on a concrete check: Step failed; inspect code3-finetuned-controller.log. Inspect preserved receipts. No later arm/task launched.

### code3 finetuned rerun: no delivery (ended ~02:55Z, 2026-11-18)

- **How it ended:** 150 of 150 lead calls, 6 trials. Champion `5e176046`: anchored CV ARI 0.990, sealed ARI 0.989 [0.976, 0.998] on 331 sealed rows, observer-only.
- **Why there was no delivery:** the lead's validation rejected it twice. The non-batch `predict()` on unseen rows is broken: at `tasks/code3.py:348`, `_sim` recomputes `S @ S.T`, so a rows × centroids score becomes rows × rows. The calls ran out before a fix and validated hand-over.
- **Pattern:** the old-base code3 finetuned run also had a high-scoring champion rejected by validation (row-order dependence).
- **Backup:** Drive round trip verified, folder `1XEc-iM3CHbJY8XO9SMQUuyF6p1wvIvKP`. `win-train-dev.zip` and `sealed.zip` were excluded with hashes, and the local ZIP deleted. The old-base code3 finetuned folder `1ihEXm…` was trashed. The Windows data was removed with a hash receipt.
- **Arm context:** minimal code3 (old base) delivered 8 clusters, with the agent reporting 0.935.

**Order from here (observer decision):** Google's Tor is complete and its tor2 data is gone (19 GB free). Qwen runs Tor next, because results are due this morning: tor1 and tor2, both arms. Then code1 and attacks1. Tor data and code1 data are never staged at the same time. `CODE1_HOLD` stays until Tor is done.

## Rerun continued after Tor (2026-11-18, ~08:45Z)

Tor is complete; see `docs/experiments/qwen-tor-2026-11-18.md`. All Tor data was removed and 13 GiB was free, so `CODE1_HOLD` was removed and the workflow relaunched. code1 was staged identical to the first run, its finetuned setup check passed, and code1 finetuned is running. 8 GB disk free with the Android data staged. attacks1 follows.

2026-11-18T09:10Z: observer check. code1 finetuned has run for 30 min, phase `baseline`, 28 of 150 calls, no trial yet. Disk is at 5.6 GB free with the Android data and finetuned copies staged. The first code1 run's later growth (confirmation about 0.6 GB, refit about 0.2 GB) leaves about 4.5 GB, above the 2 GiB safety stop. Watched.

2026-11-18T09:40Z: observer check. code1 finetuned has run for 60 min, 83 of 150 calls, 1 trial: `75df398c`, completed but not promotion-eligible (likely a pilot scope), anchored ARI 0.516 (folds 0.457–0.559), test agreement 0.991. No champion yet. Disk stable at 5.6 GB free.

2026-11-18T10:10Z: observer check. code1 finetuned has run for 90 min, 131 of 150 calls, 4 trials.
- Champion `53908f5d`: anchored ARI 0.527.
- `f39fbbcd`: 0.535, eligible but not champion (within noise).
- `5c755e63`: 0.686, not promotion-eligible (pilot scope).
- `75df398c`: 0.516, pilot.
- Test agreement 0.97–0.99. No hand-over yet.
- Resources: disk 4.6 GB free (confirmation in progress), RSS 1.4 GB, 12 processes.

2026-11-18T10:2xZ: disk dipped to 2.13 GiB during code1 (Google worktree activity), just above the 2 GiB safety stop. The run continued. The Tor finetuned dev and sealed dataset copies (6 files, about 3.9 GB) were removed with a hash receipt in `runs/launches/2026-11-18-qwen-tor/dataset-cleanup.jsonl`; Tor was already complete and backed up without them.

2026-11-18T10:3xZ: Google gave advance notice that it re-stages tor1 in its checkout for a manual finetuned tor1 output, peaking at about 3 GB; its stage_tor.py aborts below 6 GiB free. Google removed stale worktrees, and about 14 GB is free.

## Planned: manual code3 completion (user decision, 2026-11-18)

Same procedure as Google's finetuned tor1.
- **Promote:** the lead's fix trial `35309428` (commit `476f538`, out-of-sample predict through the nearest unit centroid) to champion in place of the validation-blocked `5e176046`. The fix scored +0.0000 against the champion, so the 2-SE rule never promoted it, and hand-over accepts only the champion.
- **Then:** the harness sealed confirmation, refit and delivery, all without an agent session.
- **Tool:** `manual_completion.ts` (sha256 `db48dc74…`, copied from the Google checkout and read).
- **Timing:** it runs after code1 closes out and before attacks1. `HOLD_STAGING` is set so the workflow stops before attacks1.
- **Stop condition:** the original dev ZIP is still on disk (sha256 `336bd5f9…`), and the rebuild must reproduce it.

2026-11-18T11:10Z: observer check. code1 finetuned is at 149 of 150 calls (last progress write 11:09Z) with no hand-over yet. The close-out follows on the next wake.

### Why code1 validation stayed `verification_incomplete` (observer finding plus live-lead answer, 2026-11-18 ~11:16Z)

At the user's request ("check with the agent"), the observer asked the live code1 lead via `ask_lead.ts`. The run was at 149 of 150 calls, so the effect on the outcome is negligible, but this is recorded as an observer intervention in a measured run. Question and answer are under `runs/finetuned/code1/lead/operator/questions/` (question `2026-11-18T11-16-03-863Z-b9e5c3`).

- **Harness rule:** `harness/finetuned/agent/run/lead_session.ts:600` sets `verification_incomplete` when any check in the validation's `checkResults` does not exit 0, even when the review is clean.
- **The validation itself was clean:** "fix: none demonstrated", all code1 checkers exit 0, and the 12-fold reproduction gave mean 0.6647 against the measured 0.6676.
- **The blocking entry was a code3 check:** `checks/code3/verify_trial_5e176046_cut_path.py`, a leftover code3 checker in the shared solutions repository, reported "Check execution did not complete".
- **Lead's explanation (summary):**
  - The review enumerates checks by path under the shared `checks/` tree rather than per task.
  - The code3 checker imports code3's frozen trial and reads the Windows archives, which are not reachable from code1's boundary (and not staged), so it stalls until the runner gives up.
  - "Code1 is being blocked by evidence about a different task's dataset."
  - With its last calls it committed `4294fe0`, a guard in that foreign checker (print `PARTIAL` and exit 0 when the archives are unreadable). Its final `hand_over` still returned `verification_incomplete`, and it could not tell whether the foreign check still failed.
- **Assessment: harness gap.** One task's hand-over can be blocked by another task's checker in the shared repository. Related to the blocked-champion gap on Google tor1 and Qwen code3.
- **Side effect:** the lead modified a code3 checker (`4294fe0`). That checker is not used by the manual code3 completion, which runs no checks.

#### Root cause (observer analysis of harness code and validation records; corrects the lead's explanation)

- **The scout picked a wrong path:** the code1 validation scout requested the code3 checker `checks/code3/verify_trial_5e176046_cut_path.py` in a `run_checks` call. That checker is listed in the shared `INDEX.md` together with every other task's checks.
- **The tool refused it:** `run_checks` accepts only `.py` files inside `checks/<task>` and answered "not a .py file in …/checks/code1".
- **Harness bug, part 1:** `validationCheckTool` (`harness/finetuned/agent/team/runner.ts`) enters every requested path into the results as "Check execution did not complete" before it checks the folder. The refused request therefore stayed as a failed check (`exitCode: null`).
- **Harness bug, part 2:** `lead_session.ts:592` carries failed check results into later validation attempts and clears them only by a successful rerun at the same path, which the tool can never allow for a foreign path. Every later hand-over of champion `e9da9bc2` therefore stayed `verification_incomplete`, although the review found no defect.
- **The lead's explanation was partly wrong:** it said the review runs every check under the shared `checks/` tree. In fact the scout requested the path itself.
- **The scout flagged it four times on the findings board** (lines 853, 861, 869, 883): the entry "must be scoped out, not repaired" and "cannot be closed from this session". It also found that the guard the lead added in its last calls (`4294fe0`) calls the non-existent `time.monotone` and would itself exit 1.
- **The scout cannot fix this:** it has no bash or delete tool and may write only inside `checks/code1`.
- **Behavioural observation for the report:** agents pick paths from the shared repository index across task boundaries. The harness should not depend on scout-typed paths at all, because it knows the task's checks folder.

Sealed confirmations for code1 (observer-only): champion `e9da9bc2` CV 0.668, sealed ARI 0.640 [0.575, 0.739] on 200 rows; earlier champion `53908f5d` CV 0.527, sealed 0.549.

**User decision (2026-11-18):**
- Hand-submit code1 as well: a manual completion of champion `e9da9bc2`, whose only blocker is the false check entry.
- Fix the harness code and provide the fixed code with a note in the report.

#### Fixed code for the validation path gap (provided, not deployed to the running campaign)

Branch `fix/validation-check-paths`, commit `f8392d9` on top of `251346c`. Patch: `runs/launches/2026-11-17-qwen-code-rerun/validation-check-paths.patch` (sha256 `72aaf813…`). It is built in a separate worktree, so the main tree was not changed under the live code1 run.

- **`team/runner.ts`:** `run_checks` validates every requested path first and records "did not complete" placeholders only for accepted paths inside `checks/<task>`. A refused path is answered with the existing error and leaves no result behind.
- **`run/lead_session.ts`:** carried-over and new check results are filtered to `checks/<task>/`. This clears receipts that already hold a refused foreign path, as code1's did.
- **Test:** a new regression test in `team/integration.test.ts` requests another task's checker and expects the error with no recorded result. It fails without the fix.
- **Checks:** all 14 tests in that file pass with the fix; `lead_session.test.ts` 36 of 36; typecheck passes.
- **Not done:** the cleaner design (the harness runs all `checks/<task>/*.py` itself, so scouts never type paths) is a larger change, left for after the campaign.

2026-11-18T11:49:15.719178+00:00 — code/attacks workflow stopped on a concrete check: Step failed; inspect code1-finetuned-controller.log. Inspect preserved receipts. No later arm/task launched.

### finetuned code1 (manual completion after harness gap: foreign validation-check path), 2026-11-18 ~12:00Z

- **How the run ended:** it used 150 of 150 lead calls (08:43–11:49Z). Its final `hand_over` returned `verification_incomplete; no approved evidence`, and the pipeline outcome was failure. In its last minutes the lead wrote its closing turn and the harness wrote recovery records; there was no further trial or tool work.
- **Completion:** `manual_completion.ts refit-champion code1 e9da9bc2…` (tool sha256 `e2ed007f…`, from the Google observer).
  - Champion tag unchanged: `e9da9bc2`, commit `a4b5787`.
  - Refit with the sealed confirmation receipt the lead recorded (`c52394e7…`, sha `28fa8c89…`).
  - No new sealed read; refit `validation.valid: true`.
  - Receipt: `runs/launches/2026-11-18-qwen-tor/code1-manual/manual-code1-refit-receipt.json`.
- **Delivery:** `runs/finetuned/deliveries/code1/d3c0f0f0847e/output.csv`. 1,000 rows, exact test IDs, unique, integer cluster IDs, manifest hash and lines match, source ZIP intact. 53 clusters (largest 143, 100, 96).
- **Scores:** CV ARI 0.668; sealed ARI 0.640 [0.575, 0.739] on 200 rows.
- **Backup:** Drive folder "Qwen finetuned code1 MANUAL completion - 2026-11-18" (`10uk5-DoaVVxBam8GNpOn5_fYY2hFV5Ue`), round trip verified. Dataset copies were excluded, the local ZIP removed, and the old code1 folder is `alreadyDeleted`. The Android data and finetuned dev/sealed copies were removed with a hash receipt.
- **Caveats:**
  - The champion never got validation approval; its open findings were about the foreign check, not its own code.
  - The run used all 150 calls without hand-over.
  - No agent ran for the completion.
- **Context:** minimal code1 (old base) delivered 15 clusters, agent-reported 0.751. Google finetuned code1: 54 clusters, sealed 0.668.

### finetuned code3 (manual completion after harness gap: blocked champion), 2026-11-18 ~12:15Z

- **Data:** Windows data re-staged, identical to the original staging. `rebuild code3` reproduced the dev ZIP exactly (`336bd5f9…`).
- **Promotion:** the dry run gave `rebuildMatchesCurrentTag: true`. `--apply` moved `champion/code3` from the validation-blocked `5e176046` to the lead's predict fix `35309428` (commit `476f538`, CV ARI 0.987). The receipt keeps the old tag and the ledger: `runs/launches/2026-11-18-qwen-tor/code3-manual/manual-code3-promotion-receipt.json`.
- **Sealed confirmation (harness):** ARI 0.989 [0.976, 0.998] on 331 rows. The read count is now 2.
- **Refit:** `validation.valid: true`.
- **Delivery:** `runs/finetuned/deliveries/code3/93f423ceea01/output.csv`. 1,487 rows, exact test IDs, unique, integer cluster IDs, manifest hash and lines match, source ZIP intact. 54 clusters (largest 402, 300, 168).
- **Backup:** Drive folder "Qwen finetuned code3 MANUAL completion - 2026-11-18" (`1v0kbf5-SvK3ZnGriKJl1c2xruh2LW5E3`), round trip verified. The failed-rerun folder `1XEc…` is kept. The backup copy re-issued "trash" on the old-base code3 folder `1ihEXm…`, which was already in trash since 03:00, so nothing new was trashed. Windows data and dev/sealed copies were removed with a hash receipt.
- **Caveats:**
  - `35309428` never got validation approval; the scout's blocking finding is exactly what it changes.
  - The sealed rows were read twice.
  - No agent ran.
- **Context:** minimal code3 (old base) delivered 8 clusters, agent-reported 0.935. Google finetuned code3: 57 clusters, sealed 0.986.

attacks1 is next: `HOLD_STAGING` removed, workflow relaunched.

2026-11-18T~12:20Z: attacks1 finetuned started on the fixed contract (anomalyLabel 1, contract check), base HEAD `251346c`. The adv data is the same as the first run's staging, and the setup check passed.

2026-11-18T12:40Z: observer check. attacks1 finetuned has run for 22 min, phase `baseline`, 38 of 150 calls, no trial yet. 21 GB disk free, 22 GB RAM available.

2026-11-18T13:10Z: observer check. attacks1 finetuned has run for 52 min, 81 of 150 calls, still phase `baseline` with no harness trial (55 shell calls so far). This is the same pattern as the first attacks1 rerun attempt, which spent most of its calls outside harness trials.

2026-11-18T13:40Z: observer check. attacks1 finetuned is at 81 of 150 calls, unchanged for 30 min: one agent shell call has been running since 13:09Z (`python3 cnn_oof.py`, about 3.4 cores, 805 MB, CPUs 0-3). Still no harness trial or evidence file. Healthy (21 GB disk, 21 GB RAM); no intervention.

2026-11-18T14:10Z: observer check. attacks1 finetuned is at 96 of 150 calls after 112 min: the CNN probe (`cnn_oof.py`) finished, but there is still no harness trial and no `evidence.json`.

2026-11-18T14:40Z: observer check. attacks1 finetuned is at 117 of 150 calls.
- The lead wrote `solve/agent/evidence.json` at 14:28Z (local 15:28): 258 hand-found labels, 108 adversarial and 150 clean.
- First harness trial `e9b94869` (10 folds, promotion-eligible) is champion with evidence AP 0.922.
- Contract: `invocation.anomalyLabel` is 1, and the per-fold predicted anomaly fraction is 0.21–0.23, so predict returns the declared label 1 on part of the rows. The contract check has nothing to block.
- No hand-over yet.

2026-11-18T15:10Z: observer check. attacks1 finetuned is at 140 of 150 calls. Champion `e9b94869` (evidence AP 0.922) is `verification_incomplete` and not handed over. Its validation `checkResults`:
- `checks/attacks1/verify_e9b94869_contract.py`: exit 0.
- `checks/attacks1/real_data_e9b94869_evidence.py`: exit 1. The scout's own over-strict assertion (`rho > 0.98` on a 10% fit-set ablation) failed after all five contract sections printed PASS. The scout reports it as its own mis-specified check, not a pipeline defect. This is fixable by editing and re-running the check at the same path.
- `../../../../auto-smert-lab/runs/finetuned/solutions/checks/attacks1/real_data_e9b94869_evidence.py`: `exitCode: null`, "Check execution did not complete". **Second instance of the foreign/wrong-path bug.** The scout typed a misspelled absolute-relative path ("auto-smert-lab"); `run_checks` refused it but recorded it as a failed check. It can never be re-run at that path, so it blocks the hand-over permanently, even if the real check is fixed. The undeployed fix (`fix/validation-check-paths`) would have rejected it without recording it.

2026-11-18T15:2xZ: Google checked the attacks1 typo path against its `fix/handover` branch. It is covered: refused at run time and pruned on resume; tests e2947dc, 58 of 58. Two points for a possible manual attacks1 completion:
- Unlike code1, champion `e9b94869` also has a real failing check (exit 1, the scout's own mis-specified `rho > 0.98` assert). A manual completion would bypass that too, not only the typo artifact.
- attacks1 declares `holdout: none`, so PROGRESS `holdout` is `skipped` ("this task has no withheld rows"). `refit-champion` requires a completed sealed row and would refuse, so a completion would need a refit without a confirmation receipt.

2026-11-18T15:3xZ: verified Google's receipt point in `harness/finetuned/agent/confirmation/receipt.ts`. Without a receipt and without `latest.json`, `confirmedCandidate()` refits only if `confirmationRequirement()` finds no confirmation metadata in the sealed split records; otherwise it throws (fails closed). Google's updated `manual_completion.ts` (sha256 `4926bb42…`, not yet copied) passes the no-withheld-rows case through to that gate. The remaining caveat for a manual attacks1 completion is the bypassed failing rho check; no sealed score exists for attacks1 by design.

2026-11-18T15:25:45.683648+00:00 — code/attacks workflow stopped on a concrete check: Step failed; inspect attacks1-finetuned-controller.log. Inspect preserved receipts. No later arm/task launched.

### attacks1 finetuned rerun: stopped without delivery (2026-11-18 ~15:25Z)

On the user's instruction ("if nothing useful will happen anymore just stop it"), the observer stopped the run with SIGTERM to the controller at 145 of 150 calls. The controller state is `stopped` and no harness process is left.

- **Last calls:** the lead fixed its own failing check; `real_data_e9b94869_evidence.py` now exits 0, and three further checks exit 0. It also ran two more trials:
  - `cf53ae78`: evidence AP 0.942, +0.0147 against the champion with standard error 0.0110, within fold noise, not promoted;
  - `6cd70fc0`: 0.918, −0.0087.
- **Why nothing more could happen:** champion `e9b94869` (AP 0.922, predicted anomaly fraction about 0.22, contract fine) stayed `verification_incomplete` only because of the refused typo path `../../../../auto-smert-lab/…`, which can never be re-run. No call budget would have changed that: hand-over accepts only the champion, and the better `cf53ae78` was not promotable under the 2-SE rule. That is the blocked-champion gap again.
- **Backup:** Drive round trip verified, folder `130uK1a4LSd1lB5C31K9Y77pi_9wtnWGv`. The old-base attacks1 finetuned folder was trashed. The adv data is kept until the user decides on a manual completion of `e9b94869`.

### finetuned attacks1 (manual completion after harness gap: refused typo check path), 2026-11-18 ~15:45Z

- **Completion:** user decision. `manual_completion.ts refit-champion attacks1 e9b94869…` (tool sha256 `4926bb42…`). Champion tag unchanged.
- **No sealed check:** attacks1 has no withheld rows, so there is no sealed receipt. The harness gate in `confirmedCandidate()` allowed the refit because the split carries no confirmation metadata. Refit `validation.valid: true`.
- **Delivery:** `runs/finetuned/deliveries/attacks1/2da0234f267a/output.csv`. 2,990 rows, exact test IDs, unique, {0,1}, manifest hash and lines match, source ZIP intact. **628 flagged (21.0%).**
- **Contract:** the label-1 rule holds; per-fold predicted anomaly fraction 0.21–0.23, and the contract check had nothing to block.
- **Bypassed:** the scout's own `rho > 0.98` check had failed (exit 1, self-described as mis-specified). The lead fixed it, and it exits 0 at the end. The only remaining blocker was the typo path entry.
- **Observer-only scores against the training ground truth** (`units/_truth`, never visible to agents):

  | Measure | Value |
  |---|---|
  | True attack rate | 4.2% |
  | Champion OOF balanced accuracy | 0.542 |
  | Score AUC | 0.44 / 0.56 (sign-dependent) |
  | Evidence positives that are true attacks | 19% (108 positives) |
  | Evidence negatives that are truly clean | 100% |

  The evidence AP of 0.922 therefore measures agreement with the agent's self-made labels, not real detection quality.
- **Backup:** Drive folder "Qwen finetuned attacks1 MANUAL completion - 2026-11-18" (`1-McmXetCEmHy175R2Oup0taq3sCyoM1k`), round trip verified. The stopped run's backup `130uK1a4…` is kept. The adv data was removed with a receipt.
- **Context:** minimal attacks1 (old base) flagged 37%. Google attacks1 attempt 3 flagged 7.3% (evidence AP 0.990).

## Final summary: Qwen code/attacks finetuned rerun (2026-11-17/18)

**Order:** code2 → code3 → (Tor unit) → code1 → (manual code1, code3) → attacks1. attacks1 was moved last by user decision after the anomaly-contract fix. The minimal arm was not rerun: its harness is unchanged, so the old-base minimal results stand.

| Task | Minimal (old base, unchanged harness) | Finetuned rerun | Old-base finetuned (context only, not comparable) |
|---|---|---|---|
| code2 | 5 clusters; agent 0.889 | **delivered**: 7 clusters; CV ARI 0.897, sealed 0.863 [0.741, 0.958] | 10 clusters; CV 0.718, sealed 0.742 |
| code3 | 8 clusters; agent 0.935 | **manual completion** (blocked champion): 54 clusters; CV 0.987, sealed 0.989 [0.976, 0.998]; the run itself failed at 150/150 | failed (row-order dependence), also after resume |
| code1 | 15 clusters; agent 0.751 | **manual completion** (foreign check path): 53 clusters; CV 0.668, sealed 0.640 [0.575, 0.739]; the run itself failed at 150/150 | 46 clusters; CV 0.730, sealed 0.688 |
| attacks1 | 37% flagged | **manual completion** (typo check path): 21% flagged; evidence AP 0.922 (self-labelled); observer truth OOF BACC 0.542; run stopped at 145/150 | failed at 150/150 |

- **Asymmetry:** Google's code3 and code1 ran with its failed attacks1 attempt in memory; Qwen's did not. Google reran attacks1 last as well.
- **Mid-campaign fixes,** all committed to main by `251346c`:
  - metric-bound tolerance (`results.ts`);
  - anomaly output contract (label 1 for attacks1, {0,1} domain, never-/always-flag check);
  - multiclass kind for tor1;
  - minimal single-token labels. This fix never reached the continued minimal chain, which runs its own copied agent code.
- **Harness gaps found:**
  1. **Blocked champion:** an equal-score fix cannot replace a validation-blocked champion under the 2-SE rule, and hand-over accepts only the champion (Qwen code3, Google tor1, and Qwen attacks1 `cf53ae78`).
  2. **Refused validation-check paths recorded as failed checks:** foreign path in Qwen code1, typo path in Qwen attacks1. Hand-over is blocked permanently.
- **Provided but not deployed:** the fix for gap 2, branch `fix/validation-check-paths` (`f8392d9`). The Google observer's `fix/handover` covers both cases and is pending its split review.
- **Manual completions:** none of the three ran an agent; each is marked as such, with its caveats in the sections above.

## Submission CSVs, units 3–5 (2026-11-18 ~16:10Z)

`runs/exports/submission-csvs-20261118/`, same layout and checks as the Google observer's first package (`submission-csvs-20261117`): `<arm>-<model>/<unit>/<task>/output.csv`, units `03-clust`, `04-tor`, `05-anomaly`.

- **Contents:** 24 output files over four combinations (minimal/finetuned × Gemini/Qwen), plus `README.md` and the two tor1 `label-map.csv` files (identical, `e83e16e9…`).
- **Checks:** every copy matches its recorded hash; output domains are checked per task; the ID-set hash is identical across all four combinations for each task.
- **Google sources:** from `submission-sources-google-20261118/sources.json` (sha256 `f98b6fa5…`); each file also matches its own validation record.
- **Qwen minimal code/attacks:** recovered from the kept minimal Drive backups; archive and output hashes match the original receipts.
- **Drive:** "submission-csvs-for-lukas-2026-11-18-units3-5" (`1IJo7dN0xlGD_189TeTGwg-d1x4HXzmmU`), 27 files, every file downloaded back and hash-compared (`drive-upload-receipt.json`).
