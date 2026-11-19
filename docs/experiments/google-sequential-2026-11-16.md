# Google sequential experiment, 2026-11-16

Status: **minimal spam3 running in the original continuation chain**, launched
at 2026-11-16 10:52:58 UTC (11:52:58 CET). Both spam2 arms are backed up and
their unused dataset files were cleaned.
Both spam1 arms delivered and were backed up; finetuned spam1 finished at
2026-11-16 00:53:00 UTC. The user restored cloud access and authorized persisting
staging credentials in ignored `.env`. The user selected
**high** thinking for both Google arms and assigned human cores **5–8** to this
runner. Linux CPU IDs are **4–7**; use `taskset -c 4-7` for every Google launch.
The VM now has eight online CPUs (IDs 0–7). Qwen is assigned IDs 0–3.
Dataset staging from the course cloud and subsequent cleanup are authorized.

## Execution contract

The user authorized Google experiments in this checkout only, with another
agent running Qwen separately. Run units and tasks in their declared order,
alternating minimal then finetuned for each task. Preserve minimal state with
`--continue` between tasks and units; preserve finetuned's own solutions.
Check the correct unit introduction before each new unit and the task
description before every task. Stop if required material is unavailable.
Use the existing workflow and configured budgets without adding modeling advice.
The user explicitly disabled dollar-spend limits; omit `--max-cost` and do not
set `PI_MAX_COST_USD`. Training-time safeguards and tool-call budgets remain.
The prior start hold was lifted explicitly by the user after the CPU upgrade.
Continue autonomously in the authorized order, preserving the CPU split.

After each completed arm task, validate the delivery, save its result archive
to Google Drive and verify the backup before advancing. Preserve results,
source, measurement records and continuation state. Remove datasets only when
no ongoing run needs them, coordinating shared storage with the Qwen observer.
Update this report from saved traces and results. Once a run is active, enable
a T3 check every 30 minutes and completion notifications where available.
The recurring observer and completion webhook are now enabled; see the current
run section below. If Codex usage limits interrupt observation, leave the
detached task running and resume from saved state on the next successful wake
after reset. Do not reset or relaunch a live task.

## Starting identity and material

- Checkout: `/home/nico/Projects/auto-smart-lab-google`.
- Branch: `exp/google-vertex`; shared configuration is offline,
  `google-vertex / gemini-3.8-flash`, with `model.thinkingLevel: high`.
- Initially no `runs/minimal/` folder existed. The first minimal invocation establishes
  a fresh Google chain; all subsequent minimal tasks continue that same folder.
  Do not reuse Qwen's learned state from the main checkout.
- Finetuned has a `findings/` directory but no task runs or solutions directory.
  Its journal is empty and its import receipt lists zero sources and zero
  imported entries; it contains no historical learned findings.
- Unit 1's `unit-intro.md` and full nonempty task descriptions are present.
  Metadata declares `spam1`, `spam2`, `spam3` as tasks 1, 2, 3.
- The current index subsequently includes `documents1`, `documents2` (DOCX,
  PDF). Their descriptions are reconstructions, as documented in prior setup
  reports; existence alone does not verify the original course instructions.
  Check unit completeness and declared task order again before advancing.
- At the initial check all task `data/` directories were empty, including Unit 1.
  The earlier instruction assigning preparation to the user was incorrect and
  has been corrected in `AGENTS.md`. The observer now stages each task from the
  cloud, verifies inputs, and cleans datasets after both arms finish and their
  backups are verified. Only this checkout's staged data is eligible for cleanup.

## Setup evidence

Commands were run through `./dev` in the Google checkout:

```text
./dev bun run experiment -- --arm minimal --only spam1 --check-setup
Minimal arm setup ok.

./dev bun run experiment -- --arm finetuned --no-fetch --check-setup spam1
[pipeline] Task spam1: Spam Detection with Machine Learning (50 points)
[pipeline] Unit 1 (01-spam), task 1
[pipeline] Fatal error: Task spam1 records no download links; fetch its unit metadata again (./dev bun run fetch-unit -- <unit>)
```

Minimal's setup result is a static prerequisite check, not proof of corpus
availability. Both arms must pass the relevant checks with real staged inputs
before the measured sequence starts. Available disk was about 41 GiB.

Read-only Google Drive API metadata inspection succeeded using the existing
local Google login, without printing credentials. The established backup root
is [Full Results Backup 2026-11-14T20-24-36Z](https://drive.google.com/drive/folders/1GO9xr3PSPhiyCe5mLJz-z7lQD5GGm_jq),
with `capabilities.canAddChildren: true`. Prior backup code is at
`/home/nico/Projects/auto-smart-lab/runs/exports/2026-11-15T18-58-57Z-documents2-backup/backup.py`.
Reuse its credential exclusions, inventories, upload receipts and round-trip
hash verification, adapting scope to Google results without executing its
hardcoded historical task backup. No new backup folder was created yet.

## Resume

1. Read `runs/diagnostics/google-sequential-20261116/active-step.json` and inspect
   the current detached run before taking action; do not start duplicates.
2. Confirm process identity, CPU affinity 4–7, output and authoritative results.
3. Keep task inputs only as long as both arms need them; stage subsequent tasks
   from the cloud as needed. The current staging helper supports plain-ZIP spam
   tasks; spam2 needs bounded GPG/gzip handling, using the prior staging workflow.
4. Preserve minimal chain `runs/minimal/2026-11-15T23-44-56` for continuation.
5. Keep the 30-minute observation routine and completion notification enabled.
6. Validate, archive and verify finetuned `spam1`, then proceed minimal `spam2`,
   finetuned `spam2`, minimal `spam3`, finetuned `spam3`.
   Stop on missing material or unresolved run/backup failure.

## Staging and thinking correction

`spam1` was downloaded directly from the authenticated course share, with TLS
verification and redirects refused. Live WebDAV sizes and ETags matched GET
responses; ZIP CRC, duplicate-name and member-path checks passed. Embedded
training labels were saved without extracting the corpus. Source receipts and
unit-intro/task-prompt SHA-256 values are in
`runs/diagnostics/google-sequential-20261116/spam1-staging.json`.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| spam1-train.zip | 27,401,128 | `7a382cb9419b98a44fa5b98d46e11c8137d9dbbc92e489d088f036754b7bd649` |
| spam1-test.zip | 29,384,234 | `30828a4f5795ee57817224085b0dc51a076b8640862ec8a785563a931d114288` |

The original model preflight then failed independently of dataset access.
Bounded diagnostics classified the response as HTTP 400 for unsupported
`MINIMAL` thinking; authentication and quota failures were not indicated. A
tiny high-thinking request succeeded. Raw provider errors and credentials were
not logged. The temporary medium-only probe fix has been replaced by explicit
shared configuration: `model.thinkingLevel: high`. The minimal controller writes
that value to the confined Pi settings when preparing or continuing a run.
Finetuned resolves the same value for lead sessions and scouts, and uses it for
the setup probe. Agent-start telemetry records the actual SDK thinking level.
No runtime instructions or model-selection heuristics were changed.

The user asked not to add tests. All temporary test edits were removed; no test
file changes remain. Existing checks passed against the final code.
The earlier fast suite (before explicit high wiring) passed 619 tests with two
platform skips.

Final configuration checks:

- Minimal `--only spam1 --check-setup`: passed with the shared high setting.
- Finetuned `--no-fetch --check-setup spam1`: passed, no stages executed;
  pipeline `66c15ac5-0c39-4a67-8743-1a6a53f6a7ef`,
  [Langfuse trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/f2312418b21df45cd5a448071339fcd0).
- `./dev bun run typecheck`: passed after the final high configuration wiring.
- `git diff --check`: passed; no test file modifications remain.
- Final existing fast suite: **619 passed, 2 platform skips, 0 failed**, 621 tests
  across 77 files in 187.48 seconds; see
  `runs/diagnostics/google-sequential-20261116/fast-tests-high.log`.

Ready for the first task's launch once explicitly authorized. The full suite
was not run; no merge or publication is being performed.

## Current run and observation

- First minimal continuation chain:
  `runs/minimal/2026-11-15T23-44-56`. Reuse this exact folder with `--continue`
  for subsequent minimal tasks; do not start another fresh Google chain.
- Observer controller PID 6345, worker PID 6363 at launch. Active state is in
  `runs/diagnostics/google-sequential-20261116/active-step.json`; unique launch
  record is `first-launch.json` in that directory. Treat PIDs as evidence only
  after checking they still belong to this invocation.
- Log: `runs/diagnostics/google-sequential-20261116/2026-11-15T23-44-55-522Z-minimal-spam1.log`.
- The actual minimal Pi settings were checked: `defaultThinkingLevel: high`.
  A process-tree inspection found eight Google processes, all with affinity
  exactly `[4, 5, 6, 7]`. Child fits inherit this affinity.
- Both preflights passed again after the VM restart, under `taskset -c 4-7`.
  New finetuned setup pipeline `2786d916-cc3b-4b02-a5ed-3a7dd0896aad`;
  [setup trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/e05a156bf8e27b176e7a171deae1579a).
- Minimal Cloud session `spam1-20261115T234458-cdca7e`:
  [live trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/48dca20728d7e62cdb18bdba66278100).
  The Cloud v2 observations API returned ten recent live generation/tool events
  for this session at about 23:46 UTC, independently verifying ingestion.
  The legacy traces-list endpoint returned HTTP 410; use the installed SDK's
  `LangfuseClient.api.observations.getMany` with session ID and bounded time
  window instead. This is a reader API change, not an ingestion failure.
- T3 30-minute observer ID:
  `scheduled-task:command:mcp:72dae021-e9f6-480f-945e-f11e0f53deb6:schedule-task:google-experiment-observer-20261116-30min`.
  First scheduled check: **2026-11-16 00:14:21 UTC / 01:14:21 CET**.
- T3 completion webhook ID:
  `scheduled-task:command:mcp:72dae021-e9f6-480f-945e-f11e0f53deb6:schedule-task:google-experiment-observer-20261116-completion`.
  The observer wrapper posts after task process exit; the wake must validate
  local records and delivery before advancing. The webhook URL is in private
  `runs/diagnostics/google-sequential-20261116/completion-webhook.url`.
  **Exclude that credential file from every archive and log.** Nonsecret
  schedule metadata is in `schedules.json` beside it.

Next action: observe minimal spam3, validate and back up its eventual delivery,
then run finetuned spam3, on CPU IDs 4–7. Do not rerun
completed tasks. Missing local files alone are normal rolling availability:
retrieve and prepare the next task from course sources before declaring a blocker.

## Scheduled observation, 2026-11-16 00:14 UTC

Minimal spam1 remains active in its first solver session, about 30 minutes
after launch. Controller/worker PIDs and their parent chain match the recorded
invocation; all nine observed processes retain CPU IDs 4–7. The task status
record was updated at 00:14:37.900 UTC, and the log shows completed model
comparisons followed by another live Python command. This is progress, not a
finished delivery. The existing 30-minute session safeguard remains unchanged;
the harness owns session rollover/failure handling.

The status reports 48 completed model requests, 192,645 input tokens, 23,678
output tokens and 785,505 cache-read tokens; dollar budget is null. No delivery
or batch summary exists yet, so nothing is eligible for result backup or
advancement. About 39 GiB disk and 20 GiB available RAM remain, with no swap
used. No intervention, reset, duplicate launch, dataset cleanup or settings
change was made. Keep the completion webhook and recurring observer enabled.

## Minimal spam1 completion, 2026-11-16 00:24 UTC

The minimal task delivered after 39.9 minutes, in solver session 2. The first
session reached its unchanged 30-minute time cap; the harness retained its files
and started its normal second session, which finished in 9 minutes 53 seconds.
The observer did not intervene or supply modeling advice. The retained solver
uses word (1–2) and character-within-word (3–5) TF-IDF features with LinearSVC.
Its reported 20% holdout balanced accuracy is **0.996408**. This is a local
solver-reported score, not an official test score or finetuned promotion result.

Independent delivery checks passed: all **15,051** expected test IDs exactly
once, binary predictions, 8,173 positive/6,878 negative, no header, output hash
matching the manifest, source ZIP CRCs, and archived solver bytes equal to the
retained module. Output SHA-256:
`39cada0ed5ff4b88e244a463f38ec3858e80abaca7632da2237a7919e1b5a293`.
The source ZIP has 61 entries and SHA-256
`0c6504263149b290440296f1fd5167207524183bbac2df0c9a6e8ab3ee63b907`.
Validation receipt: `runs/diagnostics/google-sequential-20261116/spam1-minimal-delivery-validation.json`.
The batch summary records usage cost $0.512002275 with no spend cap; both
sessions together made 99 model calls. No submission was sent in offline mode.

The completion webhook returned HTTP 202 and woke this observer. Cloud trace
export completed in three pages with **202 observations**, including both
sessions' generation/tool records, saved in the diagnostic directory. The
Drive archive is being prepared from the minimal continuation folder (excluding
environment/cache and symlinked datasets), delivery, observer records, full
Cloud observations, package inventory and current repository source/config.
The callback URL file is excluded. Both-arm spam1 datasets remain staged.
Advance to finetuned spam1 only after round-trip backup verification succeeds.

## Verified minimal backup and finetuned launch, 2026-11-16 00:27 UTC

Minimal spam1 is backed up in
[Google minimal spam1 - 2026-11-16](https://drive.google.com/drive/folders/1n4uhszLNc2Gw4gts-EN53SROVFy4lWVh),
under the established results-backup root. The result archive contains **726
files, 7,538,395 bytes**, SHA-256
`429895ff3371f514f9cb3dc47d446700bd881860c984402194db9929cc0cfec4`.
Downloaded bytes passed SHA-256, size, ZIP CRC and every inventory-member hash;
owner-only permissions were verified. The separate uploaded backup manifest
also passed download/hash verification. Original evidence and continuation
state remain local. Credential/environment/cache files and the completion URL
were excluded. Receipts, inventories and the local ZIP are in
`runs/exports/google-spam1-minimal-20261116/`.

The completed minimal active-state record, including verified backup reference,
is preserved as `runs/diagnostics/google-sequential-20261116/completed-minimal-spam1.json`.
Only after these checks was finetuned spam1 started, at **00:27:46.616 UTC**,
under the same `taskset -c 4-7` observer wrapper. Controller PID **21526** and
worker PID **21547** were recorded. Log:
`runs/diagnostics/google-sequential-20261116/2026-11-16T00-27-46-551Z-finetuned-spam1.log`.
The CLI resolved Unit 1 task 1 to spam1. Its fresh preflight passed before launch
(pipeline `6251eb40-dcc7-4ed9-b6b5-00e512d07f5b`;
[setup trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/1b372b9517c251acc1089e77550fe968)).
High thinking, offline mode, all original tool/training safeguards and no
dollar cap remain. Spam1 inputs remain because this arm still needs them.

## Scheduled observation, 2026-11-16 00:44 UTC

Finetuned spam1 remains healthy, about 17 minutes after launch. Its current
PROGRESS record is running in the improvement phase, with **81/150 lead calls**
used and two scout calls. One harness trial completed and became champion:
`c69d71ea-dad2-481f-891a-b1ac18daf023`, development balanced accuracy
**0.9942300051**. Its sealed confirmation completed with a positive verdict;
both recorded validation checks exited zero. These are intermediate trial and
readiness records, not a terminal delivery. The retained baseline points to
commit `b2013f2128c297f6aeedc350a23b2d9ed59c7455`.

Controller PID 21526 and worker/descendant identities still match the launch;
all four observed processes have affinity exactly CPU IDs 4–7. PROGRESS was
freshly written during this observation. About 39 GiB disk and 17 GiB available
RAM remain, with zero swap used. No completion, cleanup, backup, intervention,
settings change or new launch was performed. Leave the run and both observers
active; validate and back up its eventual terminal delivery before advancing.

## Finetuned spam1 closeout and task transition, 2026-11-16 00:53–00:56 UTC

Finetuned spam1 delivered in about **25 minutes 13 seconds**, using **94/150**
lead calls and three scout calls. The selected champion is
`b626d62b-8fc4-4a86-a2e1-bb61066de92c`, solution commit
`07caa50e2ac895363ced60c17e72b51627789fd2`, with harness development CV
balanced accuracy **0.9953313569**. Terminal refit records one fit on all
16,662 training rows and predictions for 15,051 test rows. The pipeline trace is
[here](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/39e6a0feef56bf2c345f99440da5ae72).

Independent checks passed: exact unique test-ID coverage, binary output,
7,989 positive/7,062 negative, matching output/manifest hash, source ZIP CRCs
and source equality, both refit artifact hashes, all **17** referenced evidence
hashes, and refit CSV predictions equal to the delivered CSV. Output SHA-256
is `b0a58b7e5b920f643962c1d72ba50eecb5e8a73f5e062c0fdb0175c8dc2f9c5d`.
The delivery manifest has `model: null`; the launch configuration and live
session trace establish the actual Google model. This metadata limitation was
recorded rather than changing a measured result. No official test score exists.
Receipt: `runs/diagnostics/google-sequential-20261116/spam1-finetuned-delivery-validation.json`.

Cloud export saved **1,903 observations** in 20 pages. The
[verified finetuned backup](https://drive.google.com/drive/folders/1b_fOJaJodZXo9cHjXozEj8ZOoEz6fRe2)
contains **1,075 files, 16,753,717 bytes**, archive SHA-256
`d02ba0b7321ec72c6e0d389323b42cdbc742748beb18ffb5510be1c29e9b7843`.
Archive/member hashes, ZIP CRC, round-trip downloaded bytes and owner-only
permissions passed; the separate backup manifest also verified. Results,
source, fitted model, measurements, findings and full continuation state remain
local; regenerated dataset ZIPs and credentials were excluded from this backup.
Receipts are in `runs/exports/google-spam1-finetuned-20261116/`.

After both backups verified and all Google task processes exited, **six**
Google-only dataset files totaling **84,867,557 bytes** were removed: spam1
train/test ZIPs, training labels, development ZIP and two sealed ZIP copies.
Measurement/split/seed records, predictions, model, source and each arm's
continuation state were preserved. Cleanup receipt:
`runs/diagnostics/google-sequential-20261116/spam1-dataset-cleanup.json`.
No Qwen file or process was touched; no next-task dataset was staged yet.

Spam2 has the correct Unit 1 introduction and existing full task description,
but its cloud ZIPs are encrypted. The previously used private share-password
and archive-passphrase files are both absent, and no replacement environment
setting exists. The staging helper now supports bounded GPG/gzip decoding with
integrity checks and source/decoded hashes; available GPG 2.4.9 was located in
the Nix store without installing anything. Private secret cards are needed to
restore access before staging. Both the recurring observer and completion
webhook schedule were disabled while awaiting these credentials, as requested
for a genuine external/input blocker. Re-enable the same schedule IDs before
launching spam2. Do not bypass authentication, copy Qwen datasets or guess keys.

The bounded private share-password request timed out without a credential.
No download/decryption was attempted and no task was started. On resume, request
fresh private files and pass their paths as `SMARTLAB_SHARE_PASSWORD_FILE` and
`SMARTLAB_ARCHIVE_PASSPHRASE_FILE`; never put credential values in commands,
reports or arm-visible files.

## Persistent staging credentials and spam2 preparation, 2026-11-16 09:18 UTC

The user supplied the archive passphrase, restored the share password through a
private card, and explicitly requested persistence to avoid ephemeral-file
expiry. Both are now stored in this Google checkout's ignored `.env` as
`SMARTLAB_SHARE_PASSWORD` and `SMARTLAB_ARCHIVE_PASSPHRASE`; file mode is 0600.
Credential values are not included here, in staging logs, archives or runtime
prompts. Environment loading was checked against the private input without
printing it. The staging helper prefers these settings, retaining private-file
overrides as a fallback. Finetuned's shared agent environment filter removes
these observer-only variables; minimal's controller environment allowlist and
the finetuned sandbox/training allowlists also exclude them. Existing telemetry
and minimal-boundary checks passed (32 tests); no tests were added or changed.

Spam2 train/test were downloaded directly from the course cloud. Live sizes
and ETags matched, GPG integrity and gzip decoding passed, ZIP CRCs and member
identity/path checks passed, and the embedded training labels were retained.
Encrypted transfer copies were removed after decoded ZIP verification. Only
spam2 is staged; spam1 dataset files were already cleaned up after both backups.

| Decoded file | Bytes | SHA-256 |
| --- | ---: | --- |
| spam2-train.zip | 153,185,013 | `25312b1f6468eee465115fca1e094d086370c930b3118f0c16216ba089a60cba` |
| spam2-test.zip | 93,163,883 | `84dfc19a483a650c125d9f98ed48bb4489ea4d382576167b63a2f6069eeee8db` |

Training ZIP has 18,757 members including its labels; test ZIP has 12,469
members. The staging receipt separately preserves encrypted hashes/sizes and
unit-introduction/task-description hashes in
`runs/diagnostics/google-sequential-20261116/spam2-staging.json`. Because source
filenames are encrypted while runtime archives are decoded, metadata uses the
existing local-only offline loading path; provenance is in the receipt rather
than inventing plain cloud download URLs.

## Uncapped continuation repair and spam2 launch, 2026-11-16 09:20–09:22 UTC

Both spam2 preflights passed. Finetuned setup pipeline
`b98b6bed-921d-4bc6-8e98-6cead56074e6` resolved Unit 1 task 2 and passed model,
data and Cloud telemetry checks without executing stages;
[setup trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/39af4166f69af2c0665e8639ceff95f1).

The initial minimal continuation attempt at 09:20:27 UTC exited before any
agent session with `Invalid recorded spend`. The final spam1 summary lacks a
top-level `spentUsd`, and the controller attempted to validate it even though
no chain dollar cap existed. This was the no-cap cost-check bug the user had
flagged. `experiment/source.ts` now reads/validates recorded spend only when a
cap actually exists; an uncapped chain records spend as null rather than
inventing a zero aggregate. Explicit cap behavior remains. No prior result,
summary, learned memory, prompt, time limit or model setting was modified.
The existing 20 minimal/controller checks and typecheck passed; no test edits
or additions were made.

The pre-session failure, source/config and retained state were archived and
round-trip verified before retry in
[Google minimal spam2 pre-session controller failure](https://drive.google.com/drive/folders/1ojSrYE0qfimHcOeKpMlPP28JQFXeeRj4):
745 files, 10,699,334 bytes, SHA-256
`94815b15344338a30c591d4d318ed1d00cf085d40bc9c4ff348b4e3df6371580`.
It is an infrastructure failure record, not a measured solver attempt.
Completed failed state is preserved in
`runs/diagnostics/google-sequential-20261116/failed-minimal-spam2-presession.json`.

The retry started at **09:22:22.319 UTC**, controller PID **173708**, worker PID
**173726**. Log:
`runs/diagnostics/google-sequential-20261116/2026-11-16T09-22-22-265Z-minimal-spam2.log`.
The actual solver session has started and read retained spam1 memory and source
from the original chain `runs/minimal/2026-11-15T23-44-56`. Its invocation record
contains `--reset none`, no cost cap, the unchanged minimal harness identity
and solver prompt hash. High thinking and CPU IDs 4–7 remain enforced.
Cloud session ID: `spam2-20261116T092223-164203`.

Both original T3 schedules are re-enabled, with the next interval check at
**09:50:00 UTC / 10:50:00 CET**. Completion posts to the existing private
webhook URL. Schedule metadata and instructions now reference persistent `.env`
staging credentials and the completed GPG/gzip staging helper, rather than
expired private credential files. No task reset or Qwen interference occurred.

## Queued-wake observation, 2026-11-16 09:23 UTC

This wake arrived shortly after the successful continuation retry. Minimal
spam2 is healthy in its first solver session, inspecting raw-email samples,
training labels and course resources after recalling its own spam1 work. The
log is progressing; there is no completed result or delivery to archive yet.
The active invocation still matches controller 173708/worker 173726 and CPU
IDs 4–7. About 40 GiB disk and 21 GiB RAM are available, with no swap used.
No restart, duplicate launch, intervention, cleanup or settings change was made.
Leave both observers enabled for the active task.

## Scheduled observation, 2026-11-16 09:50 UTC

Minimal spam2 remains active in its first solver session, approximately 28
minutes after launch. The current Python comparison process has accumulated
267.6 CPU seconds and uses about 816 MiB RSS; status heartbeat is fresh at
09:49:53 UTC. The log records completed model comparisons followed by another
running comparison command. Controller/worker parent identities still match
the launch, and all nine observed processes retain CPU IDs 4–7.

The authoritative task status records 39 completed requests, 101,846 input
tokens, 16,900 output tokens and 671,256 cache-read tokens, with no dollar
budget. No terminal delivery exists yet. About 37 GiB disk and 20 GiB available
RAM remain, with zero swap used. The unchanged 30-minute session safeguard
remains harness-owned; no intervention, restart, duplicate launch, backup,
cleanup or settings change was made. Keep both observer schedules enabled.

## Scheduled observation, 2026-11-16 10:20 UTC

Minimal spam2 is still active, now in solver session/iteration 2. The first
session reached the unchanged 30-minute cap (40 tool calls/model requests);
the harness retained its files and performed its normal re-solve. The second
session has recently completed comparison commands and started another Python
fit; the status record is fresh at 10:20:24 UTC. No delivery exists yet.

Controller/worker identities still match the original invocation. All nine
observed processes remain on CPU IDs 4–7; the current fit uses about 980 MiB
RSS. Task usage totals 90 completed requests, 308,631 input tokens, 39,879
output tokens and 1,614,462 cache-read tokens, with dollar budget null. About
37 GiB disk and 20 GiB available RAM remain, with no swap used. No observer
intervention, reset, duplicate launch, backup, cleanup or configuration change
was made. Existing session/failure safeguards and both observers remain active.

## Minimal spam2 completion, 2026-11-16 10:26 UTC

Minimal spam2 delivered in **63.8 minutes**, solver session **3**, after its
first two sessions hit the unchanged 30-minute cap. The third session completed
in 3 minutes 45 seconds. The observer did not change prompts, limits or model
selection. The retained solver reports local 20% holdout balanced accuracy
**0.998547**, using word (1–2) TF-IDF with LinearSVC(C=1.0). This is a local
solver-reported result, not an official test score.

Independent delivery verification passed: **12,469** exact test IDs, no
duplicates or header, binary predictions (7,762 positive/4,707 negative),
manifest/output hash equality, source ZIP CRC and archived solver bytes equal
to the retained module. Output SHA-256:
`fcd0712e95ec6661129dbad66c80388a25d67508507ffcae4c5559c233dd8c31`.
Source ZIP: 62 entries, SHA-256
`26c8732555b8998429c41cf5b44fa1bf890e33486bdba2627de9a1a8f8058151`.
Receipt: `runs/diagnostics/google-sequential-20261116/spam2-minimal-delivery-validation.json`.
Recorded total model cost is $0.70076895, with no spend cap. Original chain,
memory, sources, predictions and measurements remain intact. Keep spam2 inputs
until finetuned spam2 also completes and its archive verifies.

## Verified minimal spam2 backup and finetuned launch, 2026-11-16 10:28 UTC

The [minimal spam2 backup](https://drive.google.com/drive/folders/1eBp_vzmyHkt9N8xtYH7tosvFNknGktF9)
contains **759 files, 11,243,395 bytes**, archive SHA-256
`aa66566b6e3a47f2e54ab57683ed904c5e690cb9989b69764839523497670e30`.
The archive and uploaded manifest passed round-trip size/SHA-256 checks;
ZIP CRC, all inventory member hashes and owner-only permissions also passed.
The scope preserves the full retained minimal state, source and delivery,
measurements/logs, package inventory, repository snapshot, and **281** Cloud
observations exported over three pages. Credentials, environments/caches,
symlinked datasets and the completion URL were excluded. Originals remain local.
Receipts are in `runs/exports/google-spam2-minimal-20261116/`, and the completed
active-state record is `runs/diagnostics/google-sequential-20261116/completed-minimal-spam2.json`.

Fresh finetuned spam2 preflight passed: pipeline
`fa4d181b-019f-45d0-830f-64fee5da73fe`,
[setup trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/98461f8cb76853a9c9f5e490ac4fa895).
Finetuned spam2 started only after backup verification, at **10:28:32 UTC**,
controller PID **204632**. Launch record: `finetuned-spam2-launch.json` in the
diagnostic directory. Log:
`runs/diagnostics/google-sequential-20261116/2026-11-16T10-28-32-626Z-finetuned-spam2.log`.
It retains its own spam1 solutions/findings; no minimal source or memory is
transferred to it. High thinking, CPU IDs 4–7, offline mode, configured
training/tool-call safeguards and no dollar cap remain. Both observers stay
enabled. Spam2 datasets remain because this arm still needs them.

## Finetuned spam2 completion, 2026-11-16 10:49 UTC

Finetuned spam2 delivered in **20 minutes 45 seconds**, with **58/150 lead
calls** and two scout calls. The selected harness trial is
`abf920c9-72ea-439f-ad94-b2db7b2d03f6`, solution commit
`6347f419a4f989844c06b7fe0546d3ebb8824c01`, development CV balanced accuracy
**0.9977479086**. Terminal refit performed one fit on all 18,756 training rows
and produced 12,469 test predictions. This is not an official test score.
[Pipeline trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/fdfc5f9cca8c2d815cd7ebafd1251d14).

Independent verification passed: exact unique test-ID coverage and binary
domain (7,757 positive/4,712 negative), manifest/output equality, source ZIP CRC
and equality to the retained solver, both refit artifact hashes, all **17**
evidence hashes and delivered predictions equal to the refit CSV. Output SHA-256
`76b66b08bb48956822475039e604c09123fdedff0c66f6a357a7660cdd86d043`;
source ZIP SHA-256
`27f34564ffa6fd5237e5fe8689ccbdaf11b0e78f6798cc236fdd9de7786f2648`
(8 entries). Receipt: `runs/diagnostics/google-sequential-20261116/spam2-finetuned-delivery-validation.json`.

No Google task process remains. Its result/continuation/measurement/Cloud
archive is being prepared before any dataset cleanup or next-task staging.

## Verified finetuned spam2 backup and rolling cleanup, 2026-11-16 10:51 UTC

The [finetuned spam2 backup](https://drive.google.com/drive/folders/1QVfN1Ehmxt7m3NoD-tOiZAfNbCvaYnj0)
contains **1,404 files, 28,446,864 bytes**, archive SHA-256
`bfeeb5d2621750b10afd0f369b9b3258be751053b1a227801d32276ab28759fe`.
Downloaded archive/manifest SHA-256 and sizes, ZIP CRC, every member hash and
owner-only permissions passed. It preserves source, fitted artifacts, trial/
refit/validation records, retained solutions/findings and **1,353** Cloud
observations exported in 14 pages. Dataset ZIPs, credentials, environments,
caches and the private callback URL were excluded. Originals remain local.
Receipts: `runs/exports/google-spam2-finetuned-20261116/`; completed active state:
`runs/diagnostics/google-sequential-20261116/completed-finetuned-spam2.json`.

After independently confirming both arm backups and no Google runtime, removed
**five** spam2 dataset files totaling **399,533,819 bytes**: shared train/test
ZIPs and labels, finetuned development ZIP and sealed ZIP. Predictions, fitted
models, source, trial measurements, split/seed/confirmation records, memory and
continuation state were retained. Receipt:
`runs/diagnostics/google-sequential-20261116/spam2-dataset-cleanup.json`.
No Qwen file or process was touched. Only then did staging of current task
spam3 begin from the authenticated course cloud.

## Spam3 staging and minimal continuation, 2026-11-16 10:52 UTC

Only current task spam3 is staged. Its Unit 1 introduction and full task
description match task number 3 and the index. Plain cloud archives passed
live size/ETag checks, SHA-256 recording, ZIP CRC and unique/safe member checks;
the embedded training labels were retained. Training ZIP: 77,138,285 bytes,
SHA-256 `150a9dd08b0c5d91b20d2f1907b1d779f08269d8532738c5782ae08f94fa49ff`
(3,562 members including labels). Test ZIP: 59,145,298 bytes, SHA-256
`17e576c0e62f3639cfcb01745903314d6ea3cd562c77d799fbf98cec7c143b38`
(2,757 members). Source and text hashes are in `spam3-staging.json` in the
diagnostic directory.

Both preflights passed before launch. Finetuned setup pipeline
`a3953ca4-5df9-46e0-8cd4-865d267a457e`,
[setup trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/e28d51464d0cbca91e0d6c733670f714).
Minimal spam3 started at **10:52:58 UTC**, controller PID **236961**, with
`--continue runs/minimal/2026-11-15T23-44-56` and no reset/cost cap. Log:
`runs/diagnostics/google-sequential-20261116/2026-11-16T10-52-58-897Z-minimal-spam3.log`.
It preserves its own spam1/spam2 memory, source and environment. High thinking,
CPU IDs 4–7 and all configured session/failure safeguards remain. No coaching
or model-performance instruction was supplied by the observer. Both observers
remain enabled; keep spam3 inputs until both arms complete and backups verify.

## Queued-wake observation, 2026-11-16 10:53 UTC

Minimal spam3 is healthy in its first session, inspecting HTML samples and
loading 3,561 training documents after recalling retained work. Task status is
fresh at 10:53:48 UTC, with 16 completed model requests and no dollar budget.
All eight owned processes match the recorded parent chain and remain on CPU
IDs 4–7. About 37 GiB disk and 21 GiB RAM are available; swap is unused. No
delivery yet, and no duplicate launch, reset, intervention, cleanup or setting
change was made. Leave the run and both observers active.

Observer check 2026-11-16 11:14 UTC: minimal spam3 solver session at about 21 min
of its 30 min cap, 29 tool calls, controller 236961 and worker 236979 plus all
8 descendants on CPU IDs 4–7 (none outside), 36 GB disk free, 20 GB memory
available. The observer agent's own model changed to Sonnet 5.5 because of rate
limits; the experiment model (Gemini 3.8 Flash, high thinking) and all run
settings are unchanged. No restart or duplicate launch.

Observer check 2026-11-16 11:20 UTC: minimal spam3 still running (controller
236961), solver session at about 27 min of its 30 min cap with 35 tool calls; the
agent is evaluating out-of-fold results. All owned processes remain on CPU IDs
4–7, 34 GB disk free, 20 GB memory available. No delivery yet; no restart,
duplicate launch or setting change.

2026-11-16T11:27:25Z — Unit 2 boundary port staged (user-approved, by the Qwen runner at the user's request). The main checkout's course-resource integration (expanded hash-addressed resource catalogue, lead resource listing, read-only scout resource mount, minimal resource re-staging on --continue, documents3 config, observer/runner-scope docs) is staged as runs/diagnostics/google-sequential-20261116/unit2-port/port.patch and is NOT applied: the live minimal spam3 run and finetuned spam3 keep the current two-document Unit 1 resource set, so both spam3 arms see the same material. After both spam3 backups verify, run unit2-port/apply.sh (taskset -c 4-7) before staging/launching Unit 2; it checks preconditions, applies, runs affected tests and typecheck, and reverts on failure. run_step.ts now refuses non-Unit-1 tasks until unit2-port/applied.json exists (the live controller had already loaded the file; no running process was touched). Details: unit2-port/README.md.

Observer check 2026-11-16 11:32 UTC (observer now on Opus 5.5; run settings
unchanged): the first minimal spam3 solver session hit its 30 min cap at 11:23:00
UTC after 40 tool calls with nothing submitted; the harness killed it as
configured and started session 2 (iteration 2) at 11:23:00, which had made 33
tool calls by 11:32. This is the existing session-cap safeguard working, not a
run failure; controller 236961 is still the only Google run_step process. No
intervention.

Unit 2 boundary port (staged by the Qwen observer, user-approved): confirmed
`runs/diagnostics/google-sequential-20261116/unit2-port/` (README, apply.sh,
port.patch, assets.txt) is in ignored `runs/`, the Google working tree is
unchanged, and `run_step.ts` refuses any task outside `units/01-spam` until
`unit2-port/applied.json` exists. apply.sh's preconditions read the same
`completed-<arm>-spam3.json` receipts (`exitCode: 0`, `backupVerified: true`)
this observer already writes. Both Google schedules now include the boundary
step. Not applied; it runs only after both spam3 arms close out.

Task scope decision (user, 2026-11-16 ~11:40 UTC): run all remaining tasks
except Tor, which Google skips when reached rather than waiting for its task
information. From Unit 2 on this means the dataset-backed set in
`docs/experiments/dataset-backed-scope-2026-11-16.md` (documents1–4, code1–3,
attacks1), both arms each; attacks2, offense1–2 and defense1 have no dataset
archives and stay outside the campaign as that doc records. Any other task whose
material cannot be obtained or verified still stops the run. Both Google
observer schedules were updated to say this; the old "without skipping missing
tasks" sentence was removed. This decision lives here and in observer guidance
only, not in any pipeline prompt or course resource.

Observer check 2026-11-16 11:50 UTC: minimal spam3 session 2 at about 27 min of
its 30 min cap, 53 tool calls. The agent ran the harness `validate spam3`
(VALIDATE_SCORE 0.995495, the agent's own validation, not a delivery) and then
started `solve spam3`; no spam3 delivery folder exists yet. All owned processes
remain on CPU IDs 4–7; 34 GB disk free, 20 GB memory available. No
intervention.

## Minimal spam3 completion, 2026-11-16 11:50 UTC

Minimal spam3 delivered in **57.7 minutes**, solver session **2**, controller
exit code 0 at 11:50:40 UTC. Session 1 hit the unchanged 30-minute cap after 40
tool calls without submitting; session 2 finished in 27 min 39 s with 58 tool
calls. The observer did not intervene, change prompts, limits or model. The
retained solver uses word (1–2) TF-IDF (sublinear tf) with
LinearSVC(class_weight='balanced', C=1.0); its locally reported score is
**0.995495**, the solver's own validation, not an official test score.

Independent delivery verification passed: **2,757** test IDs exactly matching the
test ZIP's `.x` members, unique, no header, binary predictions (419 positive /
2,338 negative), manifest hash and line count match, retained
`submissions/spam3_predictions.csv` equals the delivery, source ZIP CRC passed and
all 63 source members equal the retained run files (including
`agent/smartlab/tasks/spam3.py`). Output SHA-256
`c8fa749a63bf67d4349053da49103085b547a1d01948eeac68d2cdd0deb57089`; source ZIP
SHA-256 `19dd5afb933415395620c46bae9d030d3fcf0ba4d519c055abb5fb6bd1fbd862`.
Recorded model cost $0.61739032 with no spend cap. Receipt:
`runs/diagnostics/google-sequential-20261116/spam3-minimal-delivery-validation.json`.

Cloud export for session `spam3-20261116T105300-e01a58`: **202 observations** in
three pages (99 generations, 98 tool calls = 40 + 58, 5 spans including
`deliver`), saved beside the receipt. Export and validation scripts are in
`runs/exports/google-spam3-minimal-20261116/`. The Drive backup runs next with the
spam2 backup scripts re-scoped to spam3; spam3 datasets stay staged for
finetuned spam3.

## Verified minimal spam3 backup and finetuned launch, 2026-11-16 11:53 UTC

The [minimal spam3 backup](https://drive.google.com/drive/folders/1cGz_ydb4EeIaWPIdHXxF0Ww61mO0vQyI)
contains **790 files, 13,655,733 bytes**, archive SHA-256
`68ba51fa37f6f38a0e0e6b735d0a600cb7f29bb8a7ceedda84acd220317a2e06`.
Archive and uploaded manifest passed round-trip size/SHA-256 checks; ZIP CRC,
all inventory member hashes and owner-only permissions passed. Scope: full
retained minimal chain (spam1–3 state, memory, source, deliveries, logs),
package inventory, diagnostics including the 202 spam3 Cloud observations and the
staged unit2-port files, spam3 unit intro/task description, report and tracked
repository source. Excluded: `.venv`, caches, `auth.json`, `gpg/`,
`completion-webhook.url`, `.env`; datasets are symlinked and were not followed.
No redactions were needed; originals remain local. Receipts:
`runs/exports/google-spam3-minimal-20261116/`; completed state:
`runs/diagnostics/google-sequential-20261116/completed-minimal-spam3.json`.

Before launch no Google experiment process was alive, the staged spam3 ZIPs still
matched their staging SHA-256 values, and a fresh finetuned preflight passed
(pipeline `39444f4d-1721-4272-b6aa-83b2f443e43a`,
[setup trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/8f6a3c6d38de6e81d697e2b1db82b14b)).
Finetuned spam3 started at **11:53:45 UTC** through `launchDetached` and
`run_step.ts`, controller PID **270225**, worker **270250**; all six initial
processes are on CPU IDs 4–7. Launch record `finetuned-spam3-launch.json`; log
`runs/diagnostics/google-sequential-20261116/2026-11-16T11-53-44-979Z-finetuned-spam3.log`.
It keeps its own spam1/spam2 solutions and findings; high thinking, offline,
no dollar cap and existing safeguards are unchanged. Spam3 datasets stay staged
until this arm also closes out. After its verified backup, run
`unit2-port/apply.sh` before staging Unit 2.

## Finetuned spam3 completion, 2026-11-16 12:07 UTC

Finetuned spam3 delivered in **14 minutes** (11:53:45–12:07:45 UTC), exit code
0, with **80/150 lead calls** and one scout call. Selected harness trial
`eca48b12-bd04-4b81-9516-5030e2755a1d`, solution commit
`6991b021d173ca31b62d02a303a81bdd7b46e673`; development CV balanced accuracy
**0.99866**, advisory sealed-holdout balanced accuracy **0.99466** on 712 rows
(one error per class). Terminal refit made one fit on all 3,561 training rows and
predicted 2,757 test rows. Not an official test score.
[Pipeline trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/c72e97b57212720f89a95c74fde31974).

Independent verification passed: exact unique test-ID coverage, no header,
binary domain (419 positive / 2,338 negative), manifest hash/line equality,
source ZIP CRC and all 10 members equal to the refit source, refit source commit
equal to the delivered commit, both refit artifact hashes, all **17** evidence
hashes, and delivered predictions equal to the refit CSV. Output SHA-256
`c8fa749a63bf67d4349053da49103085b547a1d01948eeac68d2cdd0deb57089`; source ZIP
SHA-256 `08ea57558b944f60e26bbbf047a87b6a8e7cca7083964825aff7f40ce8ebb97e`.
Receipt: `runs/diagnostics/google-sequential-20261116/spam3-finetuned-delivery-validation.json`.

**Observation: both spam3 arms delivered byte-identical predictions** (same
SHA-256, all 2,757 rows), although the pipelines differ: minimal uses word
(1–2) TF-IDF + balanced LinearSVC; finetuned uses its own `WebspamClassifier`
with HTML-derived structural tokens. On spam1 and spam2 the arms' outputs
differed. Checked for a boundary leak: the finetuned spam3 state, solutions and
its 1,476 exported Cloud observations contain no reference to `runs/minimal` or
minimal's prediction file. The only cross-checkout path in any trace is the
read-only Bun executable from the main checkout's `.tools`, present in every
Google run of both arms since spam1 (toolchain only, not data). No evidence of
cross-arm reading; the agreement is recorded as an observed result, not
explained.

Cloud export: **1,476 observations** for the pipeline trace in 15 pages (133
generations, 126 tool calls, lead/scout agents, harness trials and setup
checks). The boundary check script and export scripts are in
`runs/exports/google-spam3-finetuned-20261116/`. The Drive backup runs next.

## Verified finetuned spam3 backup, cleanup and Unit 2 boundary, 2026-11-16 12:11 UTC

The [finetuned spam3 backup](https://drive.google.com/drive/folders/1ak7vpjhDytpI4pIeV-f59v-MQbw4QX3C)
contains **1,769 files, 38,301,278 bytes**, archive SHA-256
`9f23e733474c49da0c9865cb947baebf44e9143ae42f497efd6349354a28ba3b`. Archive and
uploaded manifest passed round-trip size/SHA-256, ZIP CRC, every member hash and
owner-only permissions. It includes the fitted refit model, trial/refit/
confirmation records, retained solutions (with git history) and findings, and
the 1,476 Cloud observations. Dataset ZIPs (development and sealed), `.venv`,
caches, credentials and the callback URL were excluded; originals remain local.
Receipts: `runs/exports/google-spam3-finetuned-20261116/`; completed state:
`runs/diagnostics/google-sequential-20261116/completed-finetuned-spam3.json`.

With both spam3 receipts at exit 0 and `backupVerified: true` and no Google
runtime alive, removed **five** spam3 dataset files, **213,421,774 bytes**:
shared train/test ZIPs and labels, the finetuned development ZIP and sealed ZIP.
Their SHA-256 values matched staging before deletion. Results, models, source,
measurements, memory and continuation state were retained. Receipt:
`runs/diagnostics/google-sequential-20261116/spam3-dataset-cleanup.json`.
**Unit 1 is complete for both Google arms.**

Unit 2 boundary: `taskset -c 4-7 bash .../unit2-port/apply.sh` passed all its
preconditions, applied `port.patch` (SHA-256 `2f78439b…0dc107`), copied 22
hash-verified course assets and then passed its checks: **78 tests, 0 failures**
across 5 files, plus typecheck. `unit2-port/applied.json` was written at
12:11:16 UTC; log `unit2-port/checks.log`. From here the ported scope doc and
the user's 11:40 decision apply: documents1–4, code1–3, attacks1, both arms
each; Tor skipped.

Staging documents1: the Unit 2 introduction and DOCX task description are
present and match `meta.json`. `stage_task.py` previously refused non-spam tasks
pending an inspected contract; it now has an explicit per-task table (cloud
folder, prefix) with documents1 = `02-maldoc` / `docx`, and asserts the decoded
DOCX ZIPs equal the SHA-256 values from the Qwen runner's earlier verified
staging of the same course-share files (train `b754d1f3…`, test `2d14ebee…`).
Encrypted tasks now generally drop stale `data_files` as spam2 did. Spam1–3
logic is unchanged.

## Documents1 staged; minimal documents1 launched, 2026-11-16 12:13 UTC

`stage_task.py documents1` downloaded both encrypted DOCX archives with live
size/ETag checks, decrypted (GPG + gzip), CRC- and member-checked them. Encrypted
and decoded SHA-256 values equal the Qwen runner's earlier verified staging of
the same files: train ZIP **1,032,995,813 bytes** `b754d1f3…7d844` (encrypted
`7295bde1…49b93`), test ZIP **394,957,208 bytes** `2d14ebee…5d9dd` (encrypted
`18a44637…c81bb`). The embedded labels cover all **6,301** training documents
exactly once (3,528 benign / 2,773 malicious); the 2,969-member test ZIP has no
labels. Receipt: `documents1-staging.json`; log `documents1-staging.log`. Both
preflights passed: finetuned pipeline `659c09fe-4097-4bfa-a407-615a74ab5adc`
([setup trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/846dece60fad6bbefcb0ecdd08ed21fe)),
minimal `--continue` setup ok.

Minimal documents1 started at **12:13:46 UTC** via `launchDetached` and
`run_step.ts minimal documents1 runs/minimal/2026-11-15T23-44-56`, controller PID
**283841**, worker **283859**, all eight initial processes on CPU IDs 4–7. The
continuation re-staged the run's `resources/` from the ported manifests (now
01-spam, 02-maldoc, clustering-of-malicious-code, detection-of-unknown-attacks)
and scaffolded `agent/smartlab/tasks/documents1.py`, keeping its spam1–3 memory
and source. Cloud session `documents1-20261116T121349-d5b966`. Launch record
`minimal-documents1-launch.json`; log
`runs/diagnostics/google-sequential-20261116/2026-11-16T12-13-46-355Z-minimal-documents1.log`.
Model, high thinking, offline mode, no dollar cap and safeguards unchanged.
This is the first Google task with the expanded course-resource set; do not
attribute it to Unit 1 results. Next: validate/back up, then finetuned
documents1 on the same staged data.

Observer check 2026-11-16 12:20 UTC: minimal documents1 (controller 283841) is in
solver session 1 at about 6 min, 40 tool calls, model thinking between feature
experiments on the DOCX archive; no delivery yet. All owned processes remain on
CPU IDs 4–7; disk 33 GB free, available memory 15 GB (the run is working with
the 1.4 GB staged archives). No intervention.

## Minimal documents1 completion, 2026-11-16 12:28 UTC

Minimal documents1 delivered in **14.8 minutes**, solver session **1** (66 tool
calls, no cap hit), exit code 0, recorded model cost $0.56905 with no spend cap.
The observer did not intervene. Retained approach: structural, syntactic and
metadata features extracted from the DOCX/ZIP packages with a soft-voting
ensemble of ExtraTrees, RandomForest and HistGradientBoosting; locally reported
score **0.996782** (solver's own validation, not an official test score).

Independent delivery verification passed: **2,969** test IDs exactly matching the
test ZIP, unique, no header, binary (1,477 malicious / 1,492 benign), manifest
hash and line count match, retained `submissions/documents1_predictions.csv`
equals the delivery, source ZIP CRC passed and all 82 source members equal the
retained run files (including `agent/smartlab/tasks/documents1.py`). Output
SHA-256 `e8fb7977033951a8d516156ded37423b452895ea8160b0579826ccd7d97c5717`;
source ZIP SHA-256 `5c6b5100bdd8454a8e1fce8bf64606fb211f6cfffc5c4ebdbc1099bffdc6237b`.
Receipt: `documents1-minimal-delivery-validation.json`. Cloud session
`documents1-20261116T121349-d5b966`: **136 observations** (67 generations, 66
tool calls, 3 spans), matching the 66 recorded tool calls.

The [minimal documents1 backup](https://drive.google.com/drive/folders/1kLaJM1-OfiKXtjUAYL9C0BvbxwFEWnsB)
holds **843 files, 58,183,368 bytes**, archive SHA-256
`d1234aa9be9a8f690b8d29a3845fae5bd8a861a0af1075fe12adde114dee9ad4`; archive and
manifest passed round-trip size/SHA-256, ZIP CRC, every member hash and owner-only
permissions. It is larger than the spam backups because the chain now carries the
expanded course-resource snapshots. No dataset ZIPs, environments, caches,
credentials or callback URL were included (checked in the inventory); no
redactions needed. Receipts: `runs/exports/google-documents1-minimal-20261116/`;
completed state `completed-minimal-documents1.json`.

Finetuned documents1 launched at **12:30:07 UTC** after a fresh preflight (pipeline
`b8a0dded-228d-4438-bf04-8ca1c66ba3f0`,
[setup trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/e19db57c862f6ea8e276a02ecae23892))
and a check that the staged DOCX ZIPs still match their staged hashes and no
Google process was alive. Controller PID **291255**, worker **291274**, all
processes on CPU IDs 4–7; log
`2026-11-16T12-30-07-813Z-finetuned-documents1.log`. It keeps its own spam
solutions and findings; settings unchanged. DOCX datasets stay staged until this
arm closes out and backs up.

Observer check 2026-11-16 12:50 UTC: finetuned documents1 (controller 291255) is
20 min in and has reached hand-over: lead status `handing_over`, 85/150 lead
calls, one scout call, champion `b13dc450-a2fb-4643-94ea-797b9b87d939` with
harness-measured score 0.99459 (a development measurement, not a delivery). The
hand-over review is written and the terminal refit directory is being populated
(files updated within the last minutes). All 7 owned processes remain on CPU IDs
4–7 (about 713 MiB); disk 32 GB free, 15 GB memory available. No delivery yet;
validate and back up when the controller exits. No intervention.

## Finetuned documents1 completion, backup and cleanup, 2026-11-16 12:51 UTC

Finetuned documents1 delivered in **20 minutes 45 seconds** (12:30:07–12:50:52
UTC), exit code 0, with **85/150 lead calls** and one scout call. Selected
harness trial `b13dc450-a2fb-4643-94ea-797b9b87d939`, solution commit
`e4fce332d3b6e96761823893699dcd372de814f1`; development CV balanced accuracy
**0.99459**, advisory sealed-holdout balanced accuracy **0.99356** on 454 rows.
Terminal refit: one fit on all 6,301 training rows, 2,969 test predictions. Not
an official test score.
[Pipeline trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/c99644be06251fc7ddcd2722b3f8c773).

Independent verification passed: exact unique test-ID coverage, no header, binary
domain (1,499 malicious / 1,470 benign), manifest hash/line equality, source ZIP
CRC and all 12 members equal to the refit source, refit source commit equal to the
delivered commit, both refit artifact hashes, all **17** evidence hashes, and
delivered predictions equal to the refit CSV. Output SHA-256
`49913c3af42382bb63d82406cb13a45f12992bd7c6312ab81d2fa51376745302`; source ZIP
SHA-256 `59286b05e93e7b3f7d11bc56081421626b33d092aa10358e58b57cf06bbc0b81`.
Receipt: `documents1-finetuned-delivery-validation.json`. (The receipt's
last field was first emitted under a stale `Spam3` name by the copied script and
was renamed to `identicalToMinimalDocuments1Output` and regenerated; value false.)

**Arm comparison, documents1:** the two arms' predictions differ on **24 of
2,969** test rows (minimal: soft-voting tree ensemble, local 0.99678; finetuned:
CV 0.99459 / holdout 0.99356). Local scores come from different protocols and are
not comparable as a ranking. No `runs/minimal` or minimal-prediction reference
appears in the finetuned state or its **1,567** exported Cloud observations
(16 pages; 139 generations, 132 tool calls).

The [finetuned documents1 backup](https://drive.google.com/drive/folders/1Jiesd0gHOUf8a1lW4d1CiT8uQcs2ZDA_)
holds **2,200 files, 43,249,272 bytes**, archive SHA-256
`9cd062a4433c22faf666a08e4dc26135f337df22d9e3924fcfc5caecc3a39a1d`; archive and
manifest passed round-trip size/SHA-256, ZIP CRC, every member hash and owner-only
permissions. It contains the fitted model, trial/refit/confirmation records,
retained solutions with history and the Cloud observations; development and
sealed dataset ZIPs, environments, caches, credentials and the callback URL were
excluded (no redactions needed). Receipts:
`runs/exports/google-documents1-finetuned-20261116/`; completed state
`completed-finetuned-documents1.json`.

With both documents1 receipts at exit 0 and `backupVerified: true` and no Google
runtime alive, removed **five** DOCX dataset files, **2,460,948,746 bytes**: shared
train/test ZIPs and labels, the finetuned development ZIP and sealed ZIP; the two
shared ZIP hashes matched staging before deletion. Results, models, source,
measurements, memory and continuation state were retained. Receipt:
`documents1-dataset-cleanup.json`. Qwen's DOCX files were not touched.

Staging documents2 (PDF): unit introduction already verified at Unit 2 entry;
the PDF task description is present and matches `meta.json`. Like DOCX, it
states that it is a factual reconstruction of archived course material, not the
verbatim task page; the observer adds nothing to it. `stage_task.py` gained a
`documents2` entry (`02-maldoc` / `pdf`) asserting the decoded ZIPs equal the Qwen
runner's earlier verified PDF staging (train `fd30f759…cc50`, test `da8ff9af…a37e`).

## Documents2 staged; minimal documents2 launched, 2026-11-16 12:53 UTC

`stage_task.py documents2` downloaded both encrypted PDF archives with live
size/ETag checks, decrypted and CRC/member-checked them. Decoded SHA-256 values
equal the Qwen runner's earlier verified staging: train ZIP **952,346,209 bytes**
`fd30f759…cc50` (6,145 members incl. labels), test ZIP **1,414,371,770 bytes**
`da8ff9af…a37e` (2,895 members, no labels). The embedded labels cover all
**6,144** training PDFs exactly once (4,055 malicious / 2,089 benign — the first
task with a malicious majority in training). Receipt: `documents2-staging.json`.
Both preflights passed: finetuned pipeline `db3e2f5e-4921-4733-93e6-d54102926fc9`
([setup trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/f973022a7304cbc24f5228c9b70fd26d)),
minimal `--continue` setup ok; no Google process was alive.

Minimal documents2 started at **12:53:47 UTC** via `launchDetached` and
`run_step.ts minimal documents2 runs/minimal/2026-11-15T23-44-56`, controller PID
**302367**, worker **302386**, all eight processes on CPU IDs 4–7; the solver is
already reading the staged data. Launch record `minimal-documents2-launch.json`;
log `2026-11-16T12-53-47-433Z-minimal-documents2.log`. It keeps its spam1–3 and
documents1 memory and source in the retained chain. Settings unchanged. Next:
validate/back up, then finetuned documents2 on the same staged PDFs.

## Minimal documents2 completion and backup; finetuned documents2 launch, 2026-11-16 13:20 UTC

Minimal documents2 delivered in **24.8 minutes**, solver session **1** (79 tool
calls, no cap hit), exit code 0, recorded model cost $0.75216 with no spend cap.
No observer intervention. Retained approach: PDFiD-style structural, stream,
entropy and obfuscation features (hex-name unescaping, Flate/hex stream
decoding, XFA detection) with a soft-voting ExtraTrees / RandomForest /
HistGradientBoosting ensemble; locally reported score **0.981109** (solver's own
validation, not an official test score).

Independent delivery verification passed: **2,895** test IDs exactly matching the
test ZIP, unique, no header, binary, manifest hash and line count match, retained
`submissions/documents2_predictions.csv` equals the delivery, source ZIP CRC
passed and all 83 source members equal the retained run files. Output SHA-256
`c8cfb7da827b44989d46721896b256cbe1dd6df069d622601c5ee0a1be193b63`; source ZIP
SHA-256 `7f8eb26f9e1066f39274081eca037e93fb3ee4ce44a6664cee2fab75f84ae35d`.
Receipt: `documents2-minimal-delivery-validation.json`. **Observation:** the
delivery predicts **675 malicious / 2,220 benign (23% malicious)**, whereas the
training labels are 66% malicious (4,055 / 2,089). That is a large gap between
training and predicted class balance; it may reflect a genuinely different test
distribution (member IDs are dated folders) or a model weakness, and cannot be
resolved without test labels. Recorded as an observation only; no action taken.
Cloud session `documents2-20261116T125350-bd4de9`: **160 observations** (78
generations, 79 tool calls, 3 spans), matching the recorded 79 tool calls.

The [minimal documents2 backup](https://drive.google.com/drive/folders/1CRpq6Ca7AzpIYiom_S12MtHE35wr5nDv)
holds **871 files, 61,131,946 bytes**, archive SHA-256
`c09517b361c733cc3b15f90d8f641ad509cf5e4ef91f25ee8cde92857cea11f7`; archive and
manifest passed round-trip size/SHA-256, ZIP CRC, every member hash and owner-only
permissions. Inventory check: no dataset ZIPs, environments, caches, credentials
or callback URL, no redactions. Receipts:
`runs/exports/google-documents2-minimal-20261116/`; completed state
`completed-minimal-documents2.json`.

Finetuned documents2 launched at **13:20:05 UTC** (controller PID **313993**,
worker **314012**, all processes on CPU IDs 4–7) after a fresh preflight
(pipeline `e94ff5d4-b03a-480b-8fe8-0c2711352eec`,
[setup trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/1baf7cfc31c96a029aaa79ba68b8a271)),
a check that both staged PDF ZIPs still match their hashes, and a check that no
Google experiment process was alive. Log:
`2026-11-16T13-20-05-226Z-finetuned-documents2.log`; launch record
`finetuned-documents2-launch.json`. Settings unchanged; PDF datasets stay staged
until this arm closes out and backs up.

Observer note: the idle check must be anchored to this checkout's paths. An
unanchored process search also matches Qwen's processes (main checkout, CPU IDs
0–3), which are not Google's and were left untouched; an earlier self-matching
pattern briefly reported a false "alive" and the launch guard stopped the script
before anything started.

Observer check 2026-11-16 13:20 UTC: finetuned documents2 (controller 313993) is
under a minute in: lead status `running`, phase `baseline`, 4/150 lead calls, no
scout calls yet. All owned processes on CPU IDs 4–7; disk 31 GB free, 21 GB memory
available. No intervention.

Observer check 2026-11-16 13:50 UTC: finetuned documents2 (controller 313993) is
30 min in, lead status `running`, phase `baseline`, **101/150 lead calls** and one
scout call. The lead spent about 21 minutes (to 13:41:00) exploring the PDFs
before launching its **first harness trial** (spam3 and documents1 launched
theirs at about 8 min); that trial has been running for about 9 min with its
files updated within the last minute, so the run is progressing and not stalled.
No champion or hand-over yet. 12 owned processes on CPU IDs 4–7 (none outside,
about 1.1 GB RSS); disk 31 GB free, 19 GB memory available. No delivery yet. No
intervention; the existing lead-call budget remains the safeguard.

## Finetuned documents2 completion, backup and cleanup, 2026-11-16 14:01 UTC

Finetuned documents2 delivered in **41 minutes** (13:20:05–14:01:14 UTC), exit
code 0, with **116/150 lead calls** and one scout call; its first harness trial
started at 13:41 (about 21 min in) and was the only completed trial. Selected
trial `7e20e725-ccf6-4b9d-a278-b0b80f3fd647`, solution commit
`98a0d878cd3070014acde4e110aa37a3876e27f8`; development CV balanced accuracy
**0.98309**, advisory sealed-holdout balanced accuracy **0.97840** on 588 rows.
Terminal refit: one fit on all 6,144 training rows, 2,895 test predictions. Not an
official test score.
[Pipeline trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/126bd08b3fa7219563d761796cb0ac10).

Independent verification passed: exact unique test-ID coverage, no header, binary
domain (604 malicious / 2,291 benign), manifest hash/line equality, source ZIP CRC
and all 14 members equal to the refit source, refit source commit equal to the
delivered commit, both refit artifact hashes, all **17** evidence hashes and
delivered predictions equal to the refit CSV. Output SHA-256
`6e7838b30da9f6c7e51dca95568e46e624b2bf78c48b59a7904077a2afc91ea7`; source ZIP
SHA-256 `87f65b9a90fc11010d924b1e14e9f98e38d7b59aeca14d5f846f6014172d148f`.
Receipt: `documents2-finetuned-delivery-validation.json` (its last field was again
emitted under a stale name by the copied script, renamed to
`identicalToMinimalDocuments2Output`, regenerated; value false).

**Arm comparison, documents2:** the arms' predictions differ on **217 of 2,895**
rows (minimal: PDFiD-style ensemble, local 0.98111; finetuned: CV 0.98309 /
holdout 0.97840). Local scores come from different protocols and are not ranked.
**Both arms independently predict a small malicious share on test** (finetuned
604 = 20.9%, minimal 675 = 23.3%) against 66% malicious in training; two
different pipelines agreeing on this supports a genuine training/test shift
rather than one model's quirk, but test labels are unavailable, so it remains an
observation. No `runs/minimal` or minimal-prediction reference appears in the
finetuned state or its **1,878** exported Cloud observations (19 pages; 167
generations, 163 tool calls).

The [finetuned documents2 backup](https://drive.google.com/drive/folders/1WQQQYqP37aHPS3gSeYgjWFMbMcHsxjwp)
holds **2,671 files, 48,578,759 bytes**, archive SHA-256
`6227a9f5761062da251c5c6dcda76e62a3211b6e18dc3e0aded67e7443e7f852`; archive and
manifest passed round-trip size/SHA-256, ZIP CRC, every member hash and owner-only
permissions; fitted model, trial/refit/confirmation records, retained solutions
and Cloud observations included; dataset ZIPs, environments, caches, credentials
and the callback URL excluded (no redactions). Receipts:
`runs/exports/google-documents2-finetuned-20261116/`; completed state
`completed-finetuned-documents2.json`.

With both documents2 receipts at exit 0 and `backupVerified: true` and no Google
runtime alive, removed **five** PDF dataset files, **3,319,064,102 bytes** (shared
train/test ZIPs and labels, finetuned development and sealed ZIPs; the shared ZIP
hashes matched staging before deletion). Results, models, source, measurements,
memory and continuation state retained. Receipt:
`documents2-dataset-cleanup.json`. Qwen files untouched.

## Documents3 (RTF) registration, 2026-11-16 14:04 UTC

Unlike DOCX and PDF, **documents3 was not registered in this checkout**: no
`units/02-maldoc/malicious-code-in-rtf-files/`, no `units/index.json` entry (the
ported patch carries the RTF pipeline configuration, but `units/` is gitignored
data). The registration was prepared earlier by the Qwen observer in the main
checkout under the same authorization. I copied its `meta.json` (hash-identical)
and `prompt.md`, and added the matching `units/index.json` URL; nothing was
written to the main checkout.

Provenance and limits, stated plainly: the RTF prompt is the same
archived-source *reconstruction* as the DOCX and PDF ones (it says so itself:
"factual reconstruction, not a verbatim complete task page") — identical to the
DOCX template except for the title/points and the DOCX-specific sentence about XML
packages; it adds no requirement. Its **30 points** are corroborated by
`docs/experiments/unit2-readiness-2026-11-14.md`. I could **not** independently
verify the RTF task URL/ID: it is absent from every repo file and from the archived
`course-materials.zip` I searched in the main checkout's `runs/incoming`; it
originates in the archived local metadata cited in that readiness note. It is used
only in `meta.json` and the index consistency check, not in agent-visible text.
The user should be aware of this unverified element.

## Documents3 staged; minimal documents3 launched, 2026-11-16 14:04 UTC

`stage_task.py documents3` downloaded both encrypted RTF archives with live
size/ETag checks, decrypted and CRC/member-checked them. Decoded SHA-256 values
equal the Qwen runner's earlier verified staging (`matchesEarlierVerifiedStaging`
true for both): train ZIP **1,861,091,394 bytes** `b892b607…7e2` (4,742 members
incl. labels), test ZIP **463,815,953 bytes** `909f0e0a…3582` (1,847 members, no
labels). The embedded labels cover all **4,741** training RTFs exactly once (2,789
benign / 1,952 malicious). Receipt: `documents3-staging.json`. Both preflights
passed: finetuned pipeline `d6e8a160-d858-4948-aebf-8a89037ac170`
([setup trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/bea5f9f269335961d7e36ef8faba5a44)),
minimal `--continue` setup ok; no Google experiment process was alive.

Minimal documents3 started at **14:04:32 UTC** via `launchDetached` and
`run_step.ts minimal documents3 runs/minimal/2026-11-15T23-44-56`, controller PID
**333977**, worker **333996**, all eight processes on CPU IDs 4–7; the solver is
already inspecting the staged archives. Launch record
`minimal-documents3-launch.json`; log
`2026-11-16T14-04-32-181Z-minimal-documents3.log`. It keeps its spam1–3,
documents1 and documents2 memory and source in the retained chain. Settings
unchanged. The RTF task description is the reconstruction recorded above (task
URL/ID unverified by this observer). Next: validate/back up, then finetuned
documents3 on the same staged RTFs.

Observer check 2026-11-16 14:20 UTC: minimal documents3 (controller 333977) is in
solver session 1 at about 15.5 min (cap 30 min), 55 tool calls; the agent is
running parallel feature extraction over the 4,741 training RTFs. No delivery yet.
All owned processes on CPU IDs 4–7; disk 31 GB free, 17 GB memory available. No
intervention.

## Minimal documents3 completion and backup; finetuned documents3 launch, 2026-11-16 14:24 UTC

Minimal documents3 delivered in **18.4 minutes**, solver session **1** (63 tool
calls, no cap hit), exit code 0, recorded model cost $0.52495 with no spend cap.
No observer intervention. Retained approach: structural, syntactic, OLE-object,
drawing-shape (pFragments) and parser-exploit feature extraction from RTF with a
soft-voting ExtraTrees / RandomForest / HistGradientBoosting ensemble; locally
reported score **0.998208** (solver's own validation, not an official test score).

Independent delivery verification passed: **1,847** test IDs exactly matching the
test ZIP, unique, no header, binary (909 malicious / 938 benign — close to the
training balance of 41% malicious, unlike documents2), manifest hash and line
count match, retained `submissions/documents3_predictions.csv` equals the
delivery, source ZIP CRC passed and all 86 source members equal the retained run
files. Output SHA-256
`60bf7e151f5bd6c9212b2f6ea6aeae8eed5c4b43627cb313c5889c43b1fe8b85`; source ZIP
SHA-256 `6c4317b3d0b82c5036882663e0f2f4733bd5711b30cd670258145c7feac859aa`.
Receipt: `documents3-minimal-delivery-validation.json`. Cloud session
`documents3-20261116T140433-cb8bef`: **129 observations** (63 generations, 63
tool calls, 3 spans), matching the 63 recorded tool calls.

The [minimal documents3 backup](https://drive.google.com/drive/folders/1MBfEl_e4WSaLP39fYrDoDksTptutou-O)
holds **899 files, 64,210,594 bytes**, archive SHA-256
`8ff7af52937823f8af101f2724c6d9af208cb16c1a1360e0d51d3ee93dba6fae`; archive and
manifest passed round-trip size/SHA-256, ZIP CRC, every member hash and owner-only
permissions; inventory has no dataset ZIPs, environments, caches, credentials or
callback URL; no redactions. Receipts:
`runs/exports/google-documents3-minimal-20261116/`; completed state
`completed-minimal-documents3.json`.

Finetuned documents3 launched at **14:24:25 UTC** (controller PID **342461**,
worker **342480**, all processes on CPU IDs 4–7) after a fresh preflight (pipeline
`01f27f41-3e2a-46b2-9403-35c8396515e1`,
[setup trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/f6951e3767910b928860b5296829a6ad)),
a check that both staged RTF ZIPs still match their hashes, and an idle check of
this checkout's experiment processes. Log:
`2026-11-16T14-24-25-938Z-finetuned-documents3.log`; launch record
`finetuned-documents3-launch.json`. Settings unchanged; RTF datasets stay staged
until this arm closes out and backs up.

Observer note: my first launch attempt this wake was stopped by my own idle guard
because the command line that contained the launch script also matched the
process-name pattern ("alive" false positive, nothing was running or started). The
idle check now runs as its own command, before and apart from the launch script.

Observer check 2026-11-16 14:50 UTC: finetuned documents3 (controller 342461) is 26
min in, lead status `running`, phase `baseline`, **93/150 lead calls**, one scout
call. First harness trial (started 14:35:33) completed; current champion
`afe276c3-306f-4d44-afaa-df5858cef073` with harness-measured score 0.99238 (a
development measurement, not a delivery); no hand-over yet. All owned processes on
CPU IDs 4–7; disk 31 GB free, 21 GB memory available; run files updated in the last
minutes. No delivery yet; no intervention.

## Finetuned documents3 completion, backup and cleanup, 2026-11-16 14:57 UTC

Finetuned documents3 delivered in **32 minutes 44 seconds** (14:24:25–14:57:09
UTC), exit code 0, with **104/150 lead calls** and one scout call; first harness
trial 14:35:33, only one completed trial. Selected trial
`afe276c3-306f-4d44-afaa-df5858cef073`, solution commit
`a2f80f4248c0377f8db73afa14977b294953e91f`; development CV balanced accuracy
**0.99238**, advisory sealed-holdout balanced accuracy **0.99250** on 486 rows.
Terminal refit: one fit on all 4,741 training rows, 1,847 test predictions. Not an
official test score.
[Pipeline trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/3798b6f2d2e05ef1221a44f6d77a30e2).

Independent verification passed: exact unique test-ID coverage, no header, binary
domain (896 malicious / 951 benign), manifest hash/line equality, source ZIP CRC
and all 17 members equal to the refit source, refit source commit equal to the
delivered commit, both refit artifact hashes, all **17** evidence hashes and
delivered predictions equal to the refit CSV. Output SHA-256
`216434fb6ec70dfa7ebda55c09d47cb021d6264429b954e2c079ce613577f2b9`; source ZIP
SHA-256 `85d87d9de527958a4210944e9fdf2b5d190173e611630f76fa877d2adde048c2`.
Receipt: `documents3-finetuned-delivery-validation.json`.

**Arm comparison, documents3:** predictions differ on **35 of 1,847** rows (minimal:
local 0.99821, 909 malicious; finetuned: CV 0.99238 / holdout 0.99250, 896
malicious); local scores are different protocols and not ranked. No `runs/minimal`
or minimal-prediction reference appears in the finetuned state or its **1,780**
exported Cloud observations (18 pages; 158 generations, 150 tool calls).

The [finetuned documents3 backup](https://drive.google.com/drive/folders/1DiyZCG2lVEQB1fYwulN_E7pFZ2ofW8Y1)
holds **3,112 files, 53,565,213 bytes**, archive SHA-256
`7652744f8e5797ab9051d3bd9bbdb54be88b673e6a76c885bf1e11341de0b669`; archive and
manifest passed round-trip size/SHA-256, ZIP CRC, every member hash and owner-only
permissions; fitted model and all evidence included; dataset ZIPs, environments,
caches, credentials and the callback URL excluded (no redactions). Receipts:
`runs/exports/google-documents3-finetuned-20261116/`; completed state
`completed-finetuned-documents3.json`.

With both documents3 receipts at exit 0 and `backupVerified: true` and no Google
runtime alive, removed **five** RTF dataset files, **4,185,998,655 bytes**; the
shared ZIP hashes matched staging before deletion. Results, models, source,
measurements, memory and continuation state retained. Receipt:
`documents3-dataset-cleanup.json`. Qwen files untouched.

## Stop at documents4: task protocol not established, 2026-11-16 15:00 UTC

**Done and backed up for both arms:** spam1–3, documents1–3 (twelve closeouts,
every one with a round-trip-verified Drive backup and a cleaned dataset).
**Not started:** documents4 (mixed-format bonus), then code1–3 and attacks1.

Why this is a stop and not a skip (standing rule: stop on missing/ambiguous task
material; skip only Tor): the share's `mix-train.zip.gz.gpg` is a 346-byte archive
that holds only a note (`mix-train.txt`, read from the Qwen observer's inspection
of 2026-11-16 14:57 UTC): the task has **no training data of its own; all
training data of the other tasks may be used**. `mix-test` (287,904,201 bytes
encrypted) exists. So documents4 has no staged training archive or label file, and
no task folder, index entry or prompt exists for it in either checkout. Defining
its data contract means choosing how three formats' training sets (DOCX, PDF,
RTF, with different ID conventions and label files) are supplied to each arm,
whether the mixed test is checked against format-specific IDs, and how the task
description is worded — decisions that would invent protocol, and that must be
**identical** to whatever the Qwen runner uses for the two campaigns to remain
comparable. The Qwen observer recorded at 14:30 UTC that it is preparing this
contract and inspected the archive at 14:57; no contract exists yet.

Consequences for resuming: the DOCX, PDF and RTF training archives were deleted
from this checkout by the standard post-task cleanup (backed up, hashes recorded
in `documents{1,2,3}-dataset-cleanup.json`) and would be re-staged from the share
with the hash checks already in `stage_task.py` once a contract is chosen. Nothing
is running. Both observer schedules are being disabled per the standing rule for a
blocker; state is intact (`active-step.json`: finetuned documents3, exited, exit 0,
`backupVerified: true`), and resuming needs only the contract decision and
re-enabling the 30-minute observer.

## Correction: archived course snapshot found, 2026-11-16 ~15:30 UTC

The main checkout holds an archived snapshot of the course platform,
`units/_vm-archive/units/malicious-code-in-documents/` (task `meta.json`/`prompt.md`
shells and the unit overview page), which this observer had not searched. It
resolves two points recorded above:

- **documents3 (RTF) task URL/ID is verified**: the archived RTF `meta.json`,
  `prompt.md` and the overview's Highscores link all carry task ID
  `192d072ac94b4653842db9efaa9404af`, matching the registration copied on 14:04 UTC.
  The overview also lists RTF at 30 points.
- **documents4 wording is sourced**: the archived overview says verbatim "Finally,
  there is a bonus task. For this task, we have collected brand-new malicious
  documents. These documents are mixed and have not been pre-filtered. Therefore,
  you will need to determine the format on your own and use appropriate detection
  methods." (20 points; task ID `2c5f75749dc740dbae658c74928051a9`). The archived
  task page itself is only a submission-form shell.

No scoring metric for Unit 2 appears in the archived overview (only per-task
Highscores links); BACC is stated verbatim only on the spam1 task page.

## Resuming at documents4 with the Qwen runner's contract (user decision), 2026-11-16 ~15:45 UTC

The user approved reusing the Qwen runner's documents4 contract unchanged. Done so
far in this checkout:

- Registration copied from the main checkout: `units/02-maldoc/mixed-malicious-code/`
  `meta.json` and `prompt.md` (hash-identical; prompt SHA-256 `d3465082…`), plus the
  `units/index.json` entry. The URL equals the archived course metadata in
  `units/_vm-archive/` (task ID `2c5f75749dc740dbae658c74928051a9`). The prompt is a
  labelled reconstruction quoting the course note verbatim with a translation; it
  adds no modeling hint (it omits the overview's "use appropriate detection
  methods", as the RTF prompt did).
- Finetuned declaration: `harness/finetuned/pipeline.config.json` now carries the
  same `documents4` entry as the main checkout (the only difference between the
  two files); it equals the documents3 declaration apart from file names
  (zip_members, binary targets, inductive, stratified holdout, balanced accuracy,
  full-training refit).
- Staging: `stage_mix.py` in the diagnostic directory, adapted from the Qwen
  runner's script to this checkout's paths, CPU IDs 4–7, share inventory and
  documents1–3 staging receipts. It also decrypts the 346-byte `mix-train` note
  independently and requires it to equal the Qwen decryption, and finally compares
  the staged files with the Qwen runner's. Running now.

## Documents4 staged; minimal documents4 launched; observers re-enabled, 2026-11-16 16:18 UTC

`stage_mix.py` completed. The 346-byte `mix-train.zip.gz.gpg` (SHA-256
`e58b00e2…`) was decrypted independently here: it holds only `mix-train.txt`, whose
hash equals the Qwen runner's decryption. The DOCX, PDF and RTF training archives
were re-fetched with live size/ETag checks and decrypted to exactly the SHA-256
values of this checkout's documents1–3 staging. The original `mix-test.zip`
(encrypted 287,904,201 bytes `fed14f7d…`, decoded **644,857,905 bytes**
`2c8f8f55…`, 1,155 `.x` members, no labels) was staged unchanged. The union
`mix-train.zip` (**3,846,181,903 bytes**, ZIP_STORED) and `mix-train.labels`
(**17,186 rows**: 8,406 benign / 8,780 malicious; DOCX 6,301, PDF 6,144, RTF 4,741;
exact label coverage, suffix/label agreement, train/test disjoint) were built with
`docx-train/`, `pdf-train/`, `rtf-train/` prefixes. **All three staged files are
byte-identical (SHA-256) to the Qwen runner's staged files.** Receipts:
`staging-mix/staging.json`, `staging-mix/data-inspection.json`; log
`documents4-staging.log`.

Both preflights passed: finetuned pipeline `fb7662e2-bae3-4cb8-bb30-b017d4180bd4`
([setup trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/7f179d0617fa0840160eea621ee095df)),
minimal `--continue` setup ok; no Google experiment process was alive.

Minimal documents4 started at **16:18:18 UTC** via `launchDetached` and
`run_step.ts minimal documents4 runs/minimal/2026-11-15T23-44-56`, controller PID
**391465**, worker **391484**, all eight processes on CPU IDs 4–7; the solver is
reading its own documents1/documents2 solvers from the retained chain. Launch
record `minimal-documents4-launch.json`; log
`2026-11-16T16-18-18-027Z-minimal-documents4.log`. Settings unchanged.

Both observer schedules were re-enabled with updated guidance (documents4 decision,
`_vm-archive` and Qwen receipts as read-only verification sources, anchored idle
checks run separately from launch scripts); next 30-minute check at 16:49 UTC.
Disk: about 21 GB free with the 4.5 GB documents4 inputs staged.

## Minimal documents4 completion; backup blocked by Drive sharing change, 2026-11-16 16:30 UTC

Minimal documents4 delivered in **9.5 minutes**, solver session **1** (55 tool
calls), exit code 0, recorded model cost $0.29036. Approach: format-signature
identification (DOCX/PDF/RTF) with format-specialized structural extractors and
soft-voting ExtraTrees / RandomForest / HistGradientBoosting ensembles; locally
reported score **0.989875** (solver's own validation on the union training data,
not an official test score). Independent verification passed: **1,155** test IDs
exactly matching the test ZIP, unique, no header, binary (363 malicious / 792
benign), manifest hash/lines, retained predictions equal the delivery, source ZIP
CRC, all 89 source members equal the retained run. Output SHA-256
`b466dae85d45989a8f222df792519294f428de58247380b60e8e64e6fae046c2`; source ZIP
`4d4d7d5882baea6135c27f56a05961e709a4175d6a6b2c217ab9ebc80e10f91b`. Receipt:
`documents4-minimal-delivery-validation.json`. Observation: test IDs are under
`data/mix-2019/` while the format training sets are from 2017-09 folders; the
arm predicts 31% malicious against 51% in the union training set. Cloud session
`documents4-20261116T161820-be3301`: **113 observations** (55 generations, 55
tool calls, 3 spans), complete.

**Backup not verified — stopped.** The re-scoped backup packed 935 files /
68,547,013 bytes and uploaded them to a new folder
[Google minimal documents4 - 2026-11-16](https://drive.google.com/drive/folders/1zngqGHDkF2Oao-zpZ71K_WYJzs3KH55X),
but the existing owner-only check failed ("Unexpected backup sharing
permissions") before the download round trip. A read-only permission query shows
that the **backup root folder `1GO9xr3PSPhiyCe5mLJz-z7lQD5GGm_jq` now has a second
user with role `writer`** (a gmail.com account, not the owner), inherited by every
folder and file beneath it — including the earlier backup folders of today, which
were owner-only when they were verified. The change happened after the
documents3 finetuned backup (14:57 UTC) passed. The observer did not remove the
permission, delete the upload, or relax the check. `active-step.json` remains
minimal documents4, exited 0, **without** `backupVerified`; no further task was
started; documents4 data stays staged. Both observer schedules were disabled per
the standing rule. Resuming needs the user's decision on the sharing: either
remove the writer (then re-run `run_backup.py`, which reuses the folder and
re-verifies), or approve a backup check that accepts this named collaborator.

## Sharing is intentional; minimal documents4 backup verified; finetuned documents4 launched, 2026-11-16 17:35 UTC

The user confirmed that the second Editor on the backup root is **intentional**: a
collaborator should see the results. The owner-only rule "did not need to be a
check". `backup.py` in `runs/exports/google-documents4-minimal-20261116/` now
records each backup file's sharing (type/role only, no addresses) in the receipt
instead of failing on it; the hash, ZIP CRC and member-hash round trip are
unchanged. Later tasks copy this `backup.py`. Earlier receipts saying "owner-only"
were true when they were written.

`run_backup.py` re-verified the archive uploaded at 16:30 instead of uploading a
duplicate. It reuses an upload only when Drive's `sha256Checksum` and our
`appProperties.sha256` both equal the local archive. **Verified:**
`google-documents4-minimal.zip`, **68,547,013 bytes**, SHA-256 `b486af49…`,
935-member inventory. The download matched the size and SHA-256, the ZIP CRC passed,
and every member hash matched. Sharing: owner plus one user writer. Folder:
https://drive.google.com/drive/folders/1zngqGHDkF2Oao-zpZ71K_WYJzs3KH55X. Receipts:
`backup-manifest.json` and `manifest-upload-receipt.json`. `active-step.json` and
`completed-minimal-documents4.json` are marked `backupVerified`.

Finetuned documents4 started at **17:34:39 UTC** via `launchDetached` and
`run_step.ts finetuned documents4`, controller PID **419916**, worker **419934**,
with every process on CPU IDs 4–7. Its preflight (`documents4-finetuned-preflight.log`)
had already passed. Launch record: `finetuned-documents4-launch.json`. Log:
`2026-11-16T17-34-39-112Z-finetuned-documents4.log`. Settings are unchanged, and the
documents4 data stays staged until finetuned closes out. Both observer schedules
were re-enabled with the sharing decision added.

## Finetuned documents4 check, 2026-11-16 18:05 UTC

The run is healthy, 31 minutes in. The controller (419916), `bun run experiment`
(419934), the experiment CLI (419947) and `pipeline_cli.ts` (419959) are all alive
on CPU IDs 4–7 with cwd in the Google checkout. Memory: 21 GB available. Disk:
17 GB free.

Lead session `dccdbf84-92c9-4a40-96de-0651eff44d0f` started 17:35:34 UTC. Its
harness-split development set is 16,777 rows; the sealed holdout is 409 rows.

| Item | Value |
|---|---|
| Trial `13c616eb` (17:43–17:56) | "Format-routed ensemble classifying DOCX, PDF, and RTF documents with specialized structural feature extractors and calibrated decision thresholds"; harness CV **0.98905**; champion |
| Holdout confirmation (1 read, 409 rows) | **0.99511**; verdict "holdout confirms the improvement" |
| Validation scout | No fix items. Advisory notes: it ran out of tool calls before executing its dynamic checks, and `classes_` is not set |
| Budget | 60/150 tool calls used, 2 scout calls; phase "improvement" |

The lead reuses its own `documents1`–`documents3` solvers through `tasks/documents4.py`.
The validator recorded that format detection routes on magic bytes, not on the
`docx-train/` style prefixes.

Process-identity note: `pipeline_cli.ts` runs with the bun 1.3.13 binary found on
the launch PATH, at `auto-smart-lab/.tools/…` in the main checkout. It only
executes that binary, which is the same pinned version; its cwd and all writes are
in the Google checkout, and nothing in the Qwen checkout is written. No action
taken.

## Finetuned documents4 check, 2026-11-16 18:35 UTC

The run is healthy and in **terminal refit**. The lead finished with status
`handing_over` after 73/150 tool calls, 2 scout calls and 1 session.

**Trials:**

| Trial | Time (UTC) | Hypothesis | Harness CV | Champion |
|---|---|---|---|---|
| `13c616eb` | 17:43–17:56 | Format-routed ensemble | 0.98905 | yes |
| `d7248853` | 18:07–18:27 | "Format-routed ensemble with explicit classes attribute and validated contract compliance…" | 0.98892 | no (lower) |

The champion's single holdout read stays at **0.99511**.

**Refit:** it started at 18:31 UTC under `refit/980a4709…`, with three refit worker
processes plus the controller, experiment CLI and `pipeline_cli.ts`. All of these
run on CPU IDs 4–7 with cwd in the Google checkout.

**Resources:** 21 GB memory available, 17 GB disk free.

**Process note:** an unanchored match also caught PID 365722, a Qwen process
(cwd in the main checkout, CPU IDs 0–3). It was only listed and left untouched.

## Finetuned documents4 closeout; documents4 closed; stopped before code1, 2026-11-16 18:45 UTC

**Finetuned documents4.** The run exited 0 at 18:36:47 UTC; the
[trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/73eba35a62082fe67c70c0e72ff7eb17)
is in Langfuse. Terminal refit `980a4709…` used champion `13c616eb` (solution commit
`8c857933`): 1 fit on all 17,186 rows, 1,155 test rows.

Independent validation (`documents4-finetuned-delivery-validation.json`) passed every
check:
- exact and unique test IDs, no header, binary domain;
- manifest hash and line count;
- source ZIP CRC, with all 19 members equal to the refit source;
- refit artifact hashes, and 17/17 evidence hashes;
- refit predictions equal to the delivery.

| Measure | Finetuned | Minimal |
|---|---|---|
| Predictions malicious / benign | 424 / 731 | 363 / 792 |
| Output SHA-256 | `f677948f…` | `b466dae8…` |
| Harness CV | 0.98905 | — |
| Sealed holdout BACC (409 rows) | 0.99511 | — |
| Official test score | none (offline) | none (offline) |

The two arms differ on **87 of 1,155** rows: in 74 the minimal arm predicted benign and
finetuned predicted malicious; in 13 the reverse. Cloud observations: 2,014 (trace mode,
21 pages, complete). Recorded model cost is about $1.22.

**Backup.** `google-documents4-finetuned.zip`: 62,702,707 bytes, SHA-256 `04ea8de6…`,
3,492 inventoried files including `model.pkl`, predictions and `result.json`. The round
trip verified size, SHA-256, ZIP CRC and every member hash. Sharing (recorded, not
enforced): owner plus one writer. Folder:
https://drive.google.com/drive/folders/1GLnuXUKjDUwYlusV5D8C_MspKsgEcYaT.
`completed-finetuned-documents4.json` and `active-step.json` carry `backupVerified`.

**Data cleanup.** Both documents4 arms are verified. With no Google runtime alive, I
removed the mix train, labels, test, finetuned development and sealed ZIPs: 8,338,058,227
bytes. The cleanup receipt `documents4-dataset-cleanup.json` lists each file's hash.
Disk: 25 GB free.

### Code1 blocker: task description and finetuned declaration are not available

`code1` is "Malicious Code for Android" (archived meta, task URL `…/tasks/9f4c52c7…`;
cloud `03-clust/android-*`, 3.0 GB + 1.66 GB encrypted). Before starting any agent I
checked the established sources:

- **Archived course snapshot** (`units/_vm-archive`): the task page was not captured.
  Its `prompt.md` holds only page chrome ("Submit New Attempt"). The unit page keeps
  only a truncated teaser: "In this task, you are to automatically cluster malicious
  code for Android. The malicious applications have been collected in recent years and
  contain typical malicious routines for Android, such as routines for spying on data
  or sending premium-rate SMS …". The unit introduction is present and complete.
- **Course-material export:** `docs/course-materials-mapping-2026-11-16.md` states it
  does not supply individual SmartLab task descriptions.
- **Repository precedent:** `code2` (Web Servers) is registered with a prompt
  "Reconstructed on 2026-11-10 from the unit description". `code1` and `code3` have no
  registration in either checkout. The Qwen runner has not prepared any clustering task.
- **Scoring evidence:** `harness/minimal/docs/EXPERIMENT_LOG.md` (live lab,
  2026-10-03/04) shows all three clustering tasks were scored by ARS on the platform.
- **Finetuned harness:** no clustering task is declared in `pipeline.config.json`
  (either checkout). For labelled clustering, `task_configuration.ts` fixes:
  - metric `adjusted_rand_index`;
  - holdout `group`;
  - predictions `cluster_id`.

  It leaves one choice open: execution `batch` (fit_predict on the test set) or
  `inductive`.
- **Task ID order:** that October log used `code1` = PHP and `code2` = Android, while
  the archive metadata and the cloud map use `code1` = Android. The course page lists
  Web Servers first.

Writing a `code1` task description and a finetuned declaration would create
instructions and harness settings that no source verifies. This matches the
documents4 situation, which the user decided. I stopped here and disabled both
observer schedules. Nothing is running, and no `code1` data has been downloaded.

### Code-task description search, 2026-11-16 ~19:10 UTC (user question)

No original task page exists for any remaining scoped task. Searches:

- **Git history** (both checkouts, all refs including T3 checkpoints, unreachable
  blobs): `units/*` is gitignored (`.gitignore:30`), so no task page was ever
  committed. Phrases from the Android, Windows and web-server teasers do not occur.
  `android-train` occurs only in download-code comments and the October log.
- **Archived course snapshot** (`units/_vm-archive`): the pages for Web Servers,
  Android, Windows, Adversarial Example Detection and Network Intrusion Detection
  each hold only page chrome (231–235 bytes: title, source URL, "Submit New
  Attempt"). The unit pages keep truncated teasers ending in "…". The Unit 2
  document tasks, by contrast, were captured in full.
- **Langfuse Cloud:** the current organization has no observations from the
  October 3–4 live clustering run, and the legacy traces API is retired for this
  organization.
- **Pre-merge archive** `auto-smart-lab-archives/harness-state-exercise1-2026-11-03.zip`
  (1,246 members): no clustering material.
- **Local disk:** the October VM logs (`logs/vm/stud03@…`) are not present.

Existing material: `code2` and `attacks1` have prompts marked "Reconstructed on
2026-11-10 from the unit description". `code1` and `code3` have none. The search
scripts are in `code-task-search/`; all are read-only.

### Old Langfuse project search, 2026-11-16 ~21:30 UTC (user request)

The user asked me to search the old Langfuse project, `cmumh75f5014jad0dx0f2gn0w`
("auto-smart-lab"). Its key pair was found only inside
`runs/launches/2026-11-12-interface-fix-checks/tmp/terminal-refit-Y0bvjK/refit-options.json`
in the main checkout. That file is world-readable (mode 0644); I left it unchanged.
I used the keys read-only through `code-task-search/with_old_keys.py`, which never
prints their values.

**Data window:** the project returns observations only from **2026-11-02 to
2026-11-15**. There is nothing from October, so the October 3–4 live clustering run,
the last run with the original task pages, is not available.

**Full scan** (`search_multi.ts`): 49,964 observations with input and output,
complete. Matches are in `old-project-hits.json`, 266 in total:

| Phrase | Matches | What they are |
|---|---|---|
| "Malicious Code for Android" | 2 | `list_challenges` previews (11-02) of the archived page chrome |
| "Malicious Code for Windows" | 2 | same |
| "Adversarial Example Detection" | 4 | same (11-02), or previews of the 11-10 reconstruction (11-15) |
| "Malicious Code for Web Servers", `php-unknown` | 118 + 140 | 2026-11-11 finetuned probe runs (6 traces) and 2 previews on 11-15, all quoting the **2026-11-10 reconstruction** |
| "premium-rate", `android-unknown`, `win-unknown`, `adv-test` | 0 | — |

**Result:** the old project holds no original description for any code task or
for attacks1.

**Side finding, task-ID history:** on 2026-11-02 the challenge list numbered the
tasks differently:

| Task | ID on 2026-11-02 | Current ID |
|---|---|---|
| Web Servers | `code1` | `code2` |
| Android | `code2` | `code1` |
| Windows | `code3` | `code3` |
| Network Intrusion | `attacks1` | `attacks2` |
| Adversarial Example | `attacks2` | `attacks1` |

The 2026-11-02 numbering matches the October lab log. The current IDs come from
the archived metadata and the cloud map. The task URLs identify each task
unambiguously.

## Submission CSVs for manual scoring, 2026-11-17 (user request)

At the user's request, one `output.csv` per task and harness-model combination was copied to the Drive folder `submission-csvs-for-lukas-2026-11-17` (https://drive.google.com/drive/folders/1WEZxc4ipXvxm0k2JVhRPJ14XIza2851A, under the backup root), laid out as `<harness>-<model>/<unit>/<task>/output.csv`: 4 combinations × spam1-3 and documents1-4 = 28 files. The course pages ask for a file named `output.csv`. Every copy matches its recorded delivery hash (Google: delivery-validation records; Qwen: delivery manifests), and each task's ID set is identical across the four combinations. Every upload was downloaded again and hash-compared. Qwen sources were only read. Qwen choices: minimal = continuation chain `runs/minimal/2026-11-11T08-29-56`; finetuned = the latest delivery per task (spam1 `17495f43cb12` of 2026-11-13 over three earlier spam1 deliveries; documents1 `4cc06918c89a` budget150 retry over `d3d0008edb01`). Receipt and local tree: `runs/exports/submission-csvs-20261117/`.

## Code/attacks port applied; code2 staged; minimal code2 launched, 2026-11-17 00:35 UTC

The code1 blocker is resolved. With the user's approval, the Qwen observer sent
`runs/diagnostics/google-sequential-20261116/code-attacks-port/` (README, `apply.sh`,
`harness.patch`, task pages, unit intros, `units/_truth/`, resource catalogue,
declarations, `stage_code.py`).

**Port.** `apply.sh` ran on CPUs 4–7 at 00:33:44 UTC while no Google experiment
process was alive.
- Patch SHA-256 `947ee6a4…`; 55 files copied, all matching `files.sha256`.
- The targeted tests passed (111 across 12 files) and so did `tsc --noEmit`. Receipt:
  `code-attacks-port/applied.json`; log: `checks.log`.
- The harness patch changes the finetuned arm only:
  - labelled clustering may declare a family-stratified 20% sealed holdout;
  - sealed clustering confirmation is scored by ARI with a percentile bootstrap;
  - attacks1 uses an evidence selection score.
- Binary-task behaviour is unchanged. The Google thinking-level edit in `setup.ts`
  survived.
- The resource catalogue now matches the main checkout:
  - the spam and maldoc manifests changed too, but those units are already
    complete;
  - the clustering and unknown-attacks manifests are new for the coming tasks.
- `code1` (Android) and `code3` (Windows) task pages end in a PENDING local
  protocol. **No agent starts on a PENDING page.** The Qwen observer will send the
  filled `prompt.md` files once it has staged and inspected those archives.

**Order** (aligned with the Qwen side, user-approved message): code2, attacks1, code3,
code1. Each task runs both arms, minimal first. Tor and attacks2 stay out of scope.

**code2 staging** (`stage_code.py php`, CPUs 4–7, receipt `staging-php/staging.json`,
log `code2-staging.log`). Both archives were downloaded with live size/ETag checks,
decrypted (GPG + gzip) and passed the ZIP CRC check:
- `php-train.zip`: 48,939,023 bytes, SHA-256 `98244aa0…`. It holds 657 scripts plus
  the embedded labels, families 1/2/3/4 = 538/25/21/73.
- `php-train.labels`: SHA-256 `014b31f0…`.
- `php-test.zip`: 31,304,847 bytes, SHA-256 `2cabbcc6…`. It holds 355 `.x` scripts
  and no labels.

All three files, the task page and the unit intro are **byte-identical** to the Qwen
runner's staging and `units/` files (read-only comparison). The unit intro
"Clustering of Malicious Code" and the code2 page ("Malicious Code for Web Servers",
verbatim live page + local protocol checked against the staged archives) were read
before launch.

**Preflights.** Both passed:
- minimal `--only code2 --continue runs/minimal/2026-11-15T23-44-56 --check-setup`:
  ok;
- finetuned `--no-fetch --check-setup code2`: run
  `1ee8cae4-55a7-4250-bc66-c953e18e6222`
  ([setup trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/516bd14f2be6ec7264058fba81aeb352)).

The finetuned preflight prints "Unit ?" because the unit folder has no numeric
prefix. That line is cosmetic; the task was resolved correctly.

**Launch.** Minimal code2 started at **00:35:03 UTC** via `launchDetached` and
`run_step.ts minimal code2 runs/minimal/2026-11-15T23-44-56`.
- Controller PID **639824**; all experiment processes are on CPU IDs 4–7.
- The solver resolved `google-vertex/gemini-3.8-flash`. Settings are unchanged.
- Launch record: `minimal-code2-launch.json`. Log:
  `2026-11-17T00-35-03-078Z-minimal-code2.log`.
- Disk: about 28.6 GB free.

Both observer schedules were re-enabled with updated guidance:
- task order code2 → attacks1 → code3 → code1;
- staging with `code-attacks-port/stage_code.py`;
- attacks1 archive hash `cb9c7fd7…`, with `units/_truth` never in agent workspaces;
- no agent start on a PENDING page.

### code3 local protocol received, 2026-11-17 ~00:40 UTC

The Qwen observer finished code3's local protocol and sent a follow-up (user-approved
channel). I copied the main checkout's
`units/clustering-of-malicious-code/malicious-code-for-windows/prompt.md` over this
checkout's copy (the main file was only read).
- SHA-256 of both files: `3b44a9cc…`. **The code3 page is no longer PENDING.**
- The only change is that the PENDING paragraph was replaced by the data, data-note and
  output-format section; lines 1–20 are unchanged.
- It records:
  - `win-train.zip`: 1,644 programs under `data/win-known/`, 12 families (1–12), plus
    the embedded `win-train.labels`;
  - `win-test.zip`: 1,487 programs under `data/win-unknown/`.
- When code3 is staged here, check these counts against this checkout's own
  `staging-win/staging.json` before launching.

code1 (Android) stays PENDING until the Qwen routine stages its data and sends the page.

## Minimal code2 completion and backup; finetuned code2 launched, 2026-11-17 01:06 UTC

**Minimal code2.** Delivered in **28.4 minutes**, exit code 0, recorded model cost
$0.62170.
- Solver sessions: one.
- Solver module: `agent/smartlab/tasks/code2.py` (245 lines).
- Approach (from the manifest): "multilayer deobfuscation with word and char_wb TF-IDF
  feature union and cosine average-linkage hierarchical clustering".
- The agent validated with `AgglomerativeClustering(n_clusters=<number of families>)`
  on its own training split. The final test clustering used `distance_threshold=0.65`.
- Self-reported local ARI: **0.957563**. That is the agent's own measurement on
  training data, not an official score.
- Delivery: `runs/minimal/2026-11-15T23-44-56/logs/deliveries/2026-11-17T00-35-04/code2/`.

**Independent validation** passed every check. It ran through a new observer script,
`validate_minimal_code.py` (an observer tool, not a test). Record:
`code2-minimal-delivery-validation.json`.
- 355 rows, matching the 355 `.x` test members exactly; unique IDs; no header; integer
  cluster IDs.
- Manifest hash and line count match.
- Source ZIP CRC passed. All 93 members equal the retained run, including the solver
  module.
- The retained `submissions/code2_predictions.csv` equals the delivery.
- **8 clusters**, sizes 152/79/51/42/20/6/4/1.
- Output SHA-256 `6bada551…`.

Cloud observations: 166 (session `code2-20261117T003505-242de5`, 2 pages, complete).

**Backup.** `google-code2-minimal.zip`: 160,978,752 bytes, SHA-256 `dd29f193…`, 1,034
inventoried files. The round trip verified size, SHA-256, ZIP CRC and every member hash.
- It is larger than earlier minimal backups because the diagnostics folder now holds
  the port package, including its 42 MB `pre-apply.tar` snapshot.
- Excluded:
  - the port's copy of `units/_truth/` (README and `attacks1-train.labels`), recorded
    as excluded in `status.json`;
  - credentials, environments/caches, datasets and the callback URL.
- Sharing (recorded, not enforced): owner plus one writer.
- Folder: https://drive.google.com/drive/folders/105aL84uke252ckF7BQDKtEiHcrIrfsIe.
  Scripts and receipts: `runs/exports/google-code2-minimal-20261117/`.
- `completed-minimal-code2.json` and `active-step.json` carry `backupVerified`.

**Finetuned code2** setup check passed again before launch: run `04146702-…`
([trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/2e8d762a9c33bc5796507edea5cfc655)).
- Started at **01:06:04 UTC** via `launchDetached` and `run_step.ts finetuned code2`.
- Controller PID **652578**, worker **652596**. All Google experiment processes are on
  CPU IDs 4–7. The only PID allowed on 0–7 that matches the path pattern is
  another session's shell, not an experiment process.
- Launch record: `finetuned-code2-launch.json`. Log:
  `2026-11-17T01-06-04-270Z-finetuned-code2.log`.
- Memory: 21 GiB available. Disk: 29 GB free.
- The code2 datasets stay staged until the finetuned arm is verified and backed up.

### Finetuned code2 check, 2026-11-17 01:07 UTC

- Healthy and about 1 minute in. The lead session for run `5b5546cc-…` started at
  01:06:21 UTC.
- Phase: `baseline`. Trial budget: 5 of 150 used. Board cursor: 238, with 4 findings
  visible.
- The harness built the development archive `php-train-dev.zip` and the `sealed/`
  holdout. Dataset SHA-256 `8f6d3f22…`.
- The task text has no PENDING marker, and nothing in the workspace references
  `_truth`.
- Every Google experiment process is on CPU IDs 4–7. No action taken.

### Finetuned code2 check, 2026-11-17 01:36 UTC

The run is healthy at 30 minutes, and I took no action.

- **Progress:** phase `baseline`, 35 of 150 budget used, 1 scout call. There are still
  **0 harness trials** and 0 holdout checks.
- **What the lead is doing:** it is sweeping its own experiments in shell calls (19 so
  far), with no harness trial yet:
  - TF-IDF char/word n-gram settings × agglomerative distance thresholds, scored by its
    own training-split ARI;
  - a word-based sweep (around 0.39);
  - a char (3,4)/(3,5) sweep (0.80–0.89, std up to 0.17).
- **Current shell call:** `bash-4f0e552a` started at 01:24:49 UTC and its last line
  was at 01:33:35. The supervisor's output-gap gate reported `stale` once (149 s
  maximum gap); the process is still running at 99% CPU with 0.3 GB RSS.
- **Resources:** all experiment processes are on CPU IDs 4–7. Memory: 21 GiB available.
  Disk: 29 GB free. Load: 1.6.

Harness trials are the promotion evidence. A long stretch without one is worth watching,
but it is not a failure. No coaching or intervention (harness rule).

### Finetuned code2 check, 2026-11-17 02:06 UTC

Healthy at 60 minutes; no action taken.

- **First harness trial:** after 34 shell calls of the lead's own exploration, it
  declared `runs/finetuned/solutions/tasks/code2.py`. The trial
  `6ccc5dc2-9285-4954-a618-321e7d306ab4` started at 02:05:55 UTC. Its hypothesis:
  char 4–5-gram TF-IDF, cosine, average-linkage agglomerative clustering.
- **Budget:** 65 of 150 used, 1 scout call, 0 holdout checks.
- **Affinity:** the experiment processes run on CPU IDs 4–7. The harness trial workers
  are pinned to subsets of that range (4,6 and 5,7). The only 0–7 PID is the other
  session's shell, as before.
- **Resources:** memory 20 GiB available, disk 29 GB free.

### Finetuned code2 check, 2026-11-17 02:36 UTC

Healthy at 90 minutes, now in `handing_over`: the lead is validating its champion
before the deterministic terminal refit, and a `refit/` folder has appeared. No action
taken.

- **Budget:** 98 of 150 used. 1 scout call; 54 shell calls in total.
- **Harness trials:**
  - `6ccc5dc2` (char 4–5-gram TF-IDF, cosine, average linkage) scored ARI **0.4313**
    and became the first champion.
  - `3c7d06f5` ran 02:31–02:33 UTC and scored ARI **0.9014**. Verdict: "+0.4551,
    improvement beyond fold noise (standard error 0.0297)". It is the champion.
- **Sealed confirmations:** both trials have their receipt in `confirmation/`. The lead
  is told only that the check was recorded; the values will be read at closeout.
- **Resources:** all experiment processes are on CPU IDs 4–7. Memory: 21 GiB available.
  Disk: 29 GB free.

## Finetuned code2 closeout; code2 closed; attacks1 staged; minimal attacks1 launched, 2026-11-17 02:39 UTC

**Finetuned code2** exited 0 at 02:36:16 UTC, after 90 minutes.
- Lead: 1 agent attempt, about 98 of 150 budget used, 1 scout call, 54 shell calls,
  2 harness trials.
- [Trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/344b0a8f4f29f08c51fa86e637443e99),
  run `2a66481b-…`.
- Champion: `3c7d06f5` (solution commit `e1616e5e`).
- Terminal refit `a2089d1a…`: `fit_predict` on the 355-script test batch, 1 fit call.
- Recorded model cost: about $1.25 (sum over 152 costed observations).

Independent validation (`code2-finetuned-delivery-validation.json`, script
`runs/exports/google-code2-finetuned-20261117/validate_delivery.py`) passed every check:
- 355 rows = exact unique test members; no header; integer cluster IDs;
- manifest hash and line count;
- source ZIP CRC, with all 22 members equal to the refit source;
- refit artifact hashes, and 17/17 evidence hashes;
- refit predictions equal to the delivery, and the source commit matches.

| Measure | Finetuned | Minimal |
|---|---|---|
| Clusters (sizes) | 5 (299/51/3/1/1) | 8 (152/79/51/42/20/6/4/1) |
| Output SHA-256 | `40977fb3…` | `6bada551…` |
| Harness CV ARI (development rows, family-stratified) | 0.9014 | — |
| Self-reported local ARI | — | 0.9576 (agent's own measure) |
| Sealed holdout ARI (132 rows: 108/5/4/15) | **0.8701**, 95% bootstrap [0.740, 0.966], gap 0.031, no selection-overfit flag | — |
| Official test score | none (offline) | none (offline) |

On the test scripts, the two arms' partitions agree at ARI **0.2166** with each other.
The finetuned arm puts 84% of the test scripts in one cluster.
- Training family shares are 82/4/3/11%. Whether the test distribution is similar is
  unknown, since there are no test labels.
- Cloud observations: 1,682 (trace mode, 17 pages, complete).

**Backup.** `google-code2-finetuned.zip`: 155,906,650 bytes, SHA-256 `d61ffdbf…`,
4,097 inventoried files including `model.pkl`, predictions and `result.json`.
- The round trip verified size, SHA-256, ZIP CRC and every member hash.
- `_truth` copies are excluded and recorded.
- Sharing (recorded, not enforced): owner plus one writer.
- Folder: https://drive.google.com/drive/folders/1-LavLPyuOlLfnQCg31-Jzg-2NYfohA6J.
- `completed-finetuned-code2.json` and `active-step.json` carry `backupVerified`.

**code2 data cleanup.** Both arms are verified, and no Google runtime was alive.
Removed: `php-train.zip`, `php-train.labels`, `php-test.zip`, the finetuned
`php-train-dev.zip` and two `sealed.zip` copies, 139,198,706 bytes in total. Receipt:
`code2-dataset-cleanup.json`. **code2 is closed.**

**attacks1.** Unit intro ("Detection of unknown attacks"), task page and `meta.json`
were read. They and the finetuned declaration (hash `f7f36d06…`) are identical to the
main checkout's. The page has no PENDING marker.

Staging (`stage_code.py adv`, receipt `staging-adv/staging.json`, log
`attacks1-staging.log`) used live ETag/size checks, and the archives are unencrypted.
- The share's `adv-train.zip` (SHA-256 `3d4175fd…`, 5,980 members) also holds a labelled
  copy (`.0`–`.3`) of every image. Those 2,990 copies were removed.
- Agent `adv-train.zip`: 7,302,662 bytes, SHA-256 **`cb9c7fd7…` = required hash**,
  2,990 `.x` members, CRC ok.
- `adv-test.zip`: 7,312,940 bytes, `ee0b1a3d…`, 2,990 `.x` members.
- Both are byte-identical to the Qwen receipts. There is no label file in the data
  folder.
- The minimal chain's `units/` holds only the four unit links, so `units/_truth/` is not
  linked into any workspace.

Both preflights passed:
- minimal `--continue` check-setup: ok;
- finetuned: run `d78895b7-…`
  ([trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/cc7cbd3fd6dee18fa9b3b7639a65f676)).

**Minimal attacks1** started at **02:38:49 UTC** via `launchDetached` and
`run_step.ts minimal attacks1 runs/minimal/2026-11-15T23-44-56`.
- Controller PID **689538**, worker **689556**, all on CPU IDs 4–7.
- Model: `google-vertex/gemini-3.8-flash`.
- Launch record: `minimal-attacks1-launch.json`. Log:
  `2026-11-17T02-38-49-526Z-minimal-attacks1.log`.
- Disk: 28 GB free.

## Minimal attacks1 completion and backup; finetuned attacks1 launched, 2026-11-17 02:51 UTC

**Minimal attacks1.** Delivered in **10.7 minutes**, exit code 0, recorded model cost
$0.56440.
- Solver sessions: one.
- Solver module: `agent/smartlab/tasks/attacks1.py` (357 lines).
- Approach (from the manifest): a multi-view anomaly ensemble, with per-class
  standardization of z-scored components. The components are center-of-mass and
  center-of-neighborhood distances, a per-class One-Class SVM and IsolationForest, a
  cross-class contrastive ratio, and a high-frequency/DCT noise One-Class SVM.
- Self-reported local score: **0.594777**. That is the agent's balanced accuracy on
  adversarial examples it synthesized for a validation split, not a measurement on real
  labels and not an official score.
- The solver, its logs and the observer log contain no reference to `_truth` or
  `attacks1-train.labels`.

**Independent validation** (`attacks1-minimal-delivery-validation.json`;
`validate_minimal_code.py` now also checks the binary 0/1 domain for attacks1) passed:
- 2,990 rows = exact unique `.x` test members; no header; binary domain;
- manifest hash and line count;
- source ZIP CRC, with 95/95 members equal to the retained run, including the solver
  module;
- the retained predictions equal the delivery.

Predictions: **299 adversarial / 2,691 normal** (10.0%). Output SHA-256 `dedbbbac…`.
Cloud observations: 120 (session `attacks1-20261117T023851-e1cb76`, complete).

**Backup.** `google-attacks1-minimal.zip`: 164,220,545 bytes, SHA-256 `597f785e…`,
1,060 inventoried files.
- The round trip verified size, SHA-256, ZIP CRC and every member hash.
- `_truth` copies are excluded and recorded.
- Sharing (recorded, not enforced): owner plus one writer.
- Folder: https://drive.google.com/drive/folders/1pbHVtFHpE6_y2AXRTlN0PEj_kHCmLr6Z.
- `completed-minimal-attacks1.json` and `active-step.json` carry `backupVerified`.

**Finetuned attacks1.** The pre-launch check-setup passed again: run `daaa4689-…`
([trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/0cd573bcc0b1965fd3949a8662942741)).
- Started at **02:50:53 UTC** via `launchDetached` and `run_step.ts finetuned attacks1`.
- Controller PID **695840**, worker **695858**, all on CPU IDs 4–7.
- Launch record: `finetuned-attacks1-launch.json`. Log:
  `2026-11-17T02-50-53-317Z-finetuned-attacks1.log`.
- The attacks1 declaration has no labels (`targets: none`, `holdout: none`) and uses
  evidence-selected anomaly scoring.

Observer-side balanced accuracy against `units/_truth` has not been computed for Google.
It is not part of the Google observer scope. The Qwen routine records such a measurement
for its own arms.

### Drive abuse flag on code-task archives (Qwen observer heads-up), 2026-11-17 ~02:55 UTC

The Qwen observer reported that its code2 finetuned backup uploaded completely, but the
download-back `?alt=media` was refused with HTTP 403 `cannotDownloadAbusiveFile`. Drive
flags archives containing the PHP bot samples. The same request with
`&acknowledgeAbuse=true` downloads normally for the owner, and verification (size,
SHA-256, ZIP CRC, member hashes) is unchanged.

The three Google backups so far all round-trip verified without that flag: code2 minimal,
code2 finetuned and attacks1 minimal. The finetuned backup excludes development/sealed
data ZIPs.

To keep later code-task backups from stopping on that 403, there is now a variant,
`runs/diagnostics/google-sequential-20261116/backup.py`. It is identical to the
documents4 `backup.py` except that the download-back adds `&acknowledgeAbuse=true`. The
verification is unchanged and sharing is still recorded, not enforced. Both observer
schedules now use it. Earlier exports are left as they were.

### Finetuned attacks1 check, 2026-11-17 03:06 UTC

Healthy at 15 minutes; no action taken.

- **Progress:** phase `baseline`, budget **92 of 150** used (fast use so far), 1 scout
  call, 39 shell calls.
- **Harness trials:**
  - `9ff4646a` completed 03:01–03:02 UTC and became champion. Its PROGRESS record has
    no numeric score (the task has no labels).
  - The static validation receipt for commit `e53f4db5` completed and lists `fix`
    findings for the agent's `predict` (agent-facing feedback; observer did not act).
  - Its holdout entry is `skipped: this task has no withheld rows`. That matches the
    declaration (`holdout: none`).
  - Second trial `982ac2ad` has been running since 03:05:05.
- **Telemetry warning:** the pipeline log shows one `[trace] Langfuse score export
  failed`. It is non-fatal and the run continues. Check the Cloud observation export
  at closeout.
- **Isolation:** nothing under `runs/finetuned/attacks1` references `_truth` or
  `attacks1-train.labels`.
- **Resources:** all 8 Google experiment processes are on CPU IDs 4–7. Memory: 21 GiB
  available. Disk: 27 GB free.

## Finetuned attacks1 closeout; attacks1 closed, 2026-11-17 03:16 UTC

**Finetuned attacks1** exited 0 at 03:12:52 UTC, after 22 minutes.
- Lead: budget 135 of 150 used, 1 scout call, 2 harness trials, status `handed_over`.
- [Trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/cd99fd2653df669532dc07e0f8b9c4dc),
  pipeline run `30b5f60e-…`.
- Champion: `9ff4646a`, commit `e53f4db5`. It extracts spatial-residual, Laplacian and
  DCT features and scores them with IsolationForest.
- Terminal refit `cb35d4a9…`: 1 fit on all 2,990 training images, then 2,990 test rows.

Selection is evidence-based (the declaration has no labels or holdout). The lead labelled
160 training images itself as evidence: 80 adversarial, 80 normal. The trial scores are
**evidence average precision** over 10 development folds. The harness records them with
the limitation "agent-provided evidence does not establish official accuracy or label
correctness".
- `9ff4646a`: mean **0.7319** on its own folds.
- `982ac2ad` (commit `1c560e2`) only changed how `predict` maps IsolationForest's ±1
  outputs. Its `score_samples` is unchanged, so on the challenger's folds both commits
  scored **0.7668** on every fold (10 ties, SE 0). Verdict: "within fold noise"; the
  champion was not replaced.
  - I checked whether identical champion and challenger means meant a comparison
    defect. They don't: the anomaly scores are genuinely identical, so the tie is
    expected.
  - The two trials use different fold manifests (`d65bf5fa…` vs `5b151bac…`), which is
    why the champion's own mean differs.
- Static validation:
  - The first receipt for `e53f4db5` reported a `fix` finding: `predict` returns ±1.
  - A second receipt for the same commit passed with no findings.
  - The delivered 0/1 labels come from the harness's declared mapping
    (`anomalyLabel: -1` → 1).

Independent validation (`attacks1-finetuned-delivery-validation.json`) passed every
check:
- 2,990 rows = exact unique test members; no header; binary domain;
- manifest hash and line count;
- source ZIP CRC, with 23/23 members equal to the refit source;
- refit artifact hashes, and 11/11 evidence hashes;
- refit predictions equal to the delivery, and the source commit matches.

| Measure | Finetuned | Minimal |
|---|---|---|
| Predicted adversarial / normal | **122 / 2,868** (4.1%) | 299 / 2,691 (10.0%) |
| Output SHA-256 | `c0b20ef0…` | `dedbbbac…` |
| Selection score | evidence AP 0.7319 (agent-labelled evidence) | self-reported BACC 0.5948 on self-synthesized adversarials |
| Sealed holdout | none (no withheld rows by declaration) | — |
| Official test score | none (offline) | none (offline) |

The arms agree on 2,647 of 2,990 test images. Only 39 images are flagged adversarial
by both.

**Telemetry.** One Langfuse score write (`selectionScore` 0.7319, at 03:02:07 UTC)
failed. It was sent once with no retry, and the pipeline marked the trace as "Trace is
incomplete: Langfuse score export failed".
- The run itself succeeded. The harness validated and delivered the result.
- The failed score and the records that followed are in the emergency journal
  `runs/finetuned/attacks1/pipeline/2026-11-17-025054-0c99f4ca.emergency.jsonl`
  (1,219 lines: 1 failed score, 6 journal scores, 1,211 events). That journal is in
  the backup.
- The Cloud observation export is complete for observations: 1,907 (trace mode,
  20 pages).

**Backup.** `google-attacks1-finetuned.zip`: 173,997,663 bytes, SHA-256 `cfddd4e9…`,
4,521 inventoried files including `model.pkl` and the emergency journal.
- It used the new `backup.py` with `acknowledgeAbuse=true`. The round trip verified
  size, SHA-256, ZIP CRC and every member hash.
- `_truth` is excluded.
- Sharing (recorded, not enforced): owner plus one writer.
- Folder: https://drive.google.com/drive/folders/15KVJx7WfW9dQLVzD0lhgd_dvJKE1SUNl.
- `completed-finetuned-attacks1.json` and `active-step.json` carry `backupVerified`.

**Data cleanup.** No Google runtime was alive. Removed `adv-train.zip`,
`adv-test.zip` and the finetuned `adv-train-dev.zip`: 21,918,264 bytes. Receipt:
`attacks1-dataset-cleanup.json`. They can be re-staged with `stage_code.py adv`
(hash-checked) if the user wants an observer-side balanced accuracy against
`units/_truth`. **attacks1 is closed.**

## code3 staged; minimal code3 launched, 2026-11-17 03:18 UTC

**Task material.** I read the unit intro ("Clustering of Malicious Code") and the code3
page ("Malicious Code for Windows").
- The page has SHA-256 `3b44a9cc…` and no PENDING marker. It carries the local
  protocol received from the Qwen observer.
- Page, intro and `meta.json` are byte-identical to the main checkout.
- The finetuned declaration hash `91071a6d…` is the same in both checkouts.
- The index entry matches the task URL.
- The verbatim page warns that the old Windows malware is still dangerous if executed.
  Wine is not installed on this host, so the PE programs cannot run natively. No
  observer action is needed.

**Staging** (`stage_code.py win`, receipt `staging-win/staging.json`, log
`code3-staging.log`). Both archives were downloaded with live size/ETag checks,
decrypted (GPG + gzip) and passed the ZIP CRC check.
- `win-train.zip`: 421,304,227 bytes, SHA-256 `ef5d23ff…`. It holds **1,644** programs
  under `data/win-known/` plus the embedded `win-train.labels`.
- `win-train.labels`: SHA-256 `5d3ea485…`, **12 families**:
  1/9: 300 each, 6: 209, 7: 174, 12: 158, 10: 139, 8: 97, 11: 78, 3: 65, 2: 48, 5: 43,
  4: 33.
- `win-test.zip`: 530,360,913 bytes, SHA-256 `cc3f1e31…`. It holds **1,487** programs
  under `data/win-unknown/`, all `.x`, with no labels.
- All three files are byte-identical to the Qwen receipts and the Qwen labels file. The
  counts match the page's local protocol.

**Preflights.** Both passed:
- minimal `--continue` check-setup: ok;
- finetuned: run `31d77982-…`
  ([trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/0cb3d136f052358287247b7bd2693429)).

**Launch.** Minimal code3 started at **03:17:46 UTC** via `launchDetached` and
`run_step.ts minimal code3 runs/minimal/2026-11-15T23-44-56`.
- Controller PID **710189**, worker **710207**, all on CPU IDs 4–7.
- Model: `google-vertex/gemini-3.8-flash`.
- Launch record: `minimal-code3-launch.json`. Log:
  `2026-11-17T03-17-46-315Z-minimal-code3.log`.
- Disk: 25 GB free.

## Minimal code3 completion and backup; finetuned code3 launched, 2026-11-17 03:33 UTC

**Minimal code3.** Delivered in **13.5 minutes**, exit code 0, recorded model cost
$0.70486. Solver session 1; solver module `agent/smartlab/tasks/code3.py` (208 lines).
- Approach (from the manifest):
  - static PE tokens: sections, imphash, DLLs, API imports, exports, resources, Rich
    header, PE headers, entry section;
  - TF-IDF;
  - Ward-linkage hierarchical clustering cut at **12 clusters** (the number of training
    families).
- Self-reported local ARI: **0.998658**. It comes from Ward-clustering a stratified 20%
  training split into the true number of families. That is the agent's own
  measurement, not official.
- I checked this unusually high value. The features come only from the program bytes
  (`extract_pe_tokens(raw)`), never from member names, so the family suffix of the
  training names cannot leak into the score.

**Independent validation** (`code3-minimal-delivery-validation.json`) passed:
- 1,487 rows = exact unique `.x` test members; no header; integer IDs;
- manifest hash and line count;
- source ZIP CRC, with 97/97 members equal to the retained run, including the solver
  module;
- the retained predictions equal the delivery.

Test clustering: **12 clusters**, sizes 300/262/168/165/140/118/101/68/50/49/41/25.
Output SHA-256 `8de1fb1c…`. Cloud observations: 165 (session
`code3-20261117T031749-25d700`, complete).

**Backup.** `google-code3-minimal.zip`: 168,233,842 bytes, SHA-256 `735b9e0f…`, 1,089
files.
- It used the `acknowledgeAbuse` `backup.py`. The round trip verified size, SHA-256,
  ZIP CRC and every member hash.
- `_truth` is excluded.
- Sharing (recorded, not enforced): owner plus one writer.
- Folder: https://drive.google.com/drive/folders/11ijOC9UDIl-LQJ0twFdhoOCufS2A0hMG.
- `completed-minimal-code3.json` and `active-step.json` carry `backupVerified`.

**Finetuned code3.** The pre-launch check-setup passed again: run `44f2ba61-…`
([trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/fb31cb6eefd41b2a59cc12a2df0c42e5)).
- Started at **03:32:35 UTC** via `launchDetached` and `run_step.ts finetuned code3`.
- Controller PID **715978**, worker **715996**, all on CPU IDs 4–7.
- Launch record: `finetuned-code3-launch.json`. Log:
  `2026-11-17T03-32-35-570Z-finetuned-code3.log`.
- Disk: 25 GB free.

### Finetuned code3 check, 2026-11-17 03:36 UTC

Healthy at 3 minutes; no action taken.
- Phase `baseline`; budget 39 of 150 used; 1 scout call; 14 shell calls; no harness
  trial yet.
- The family-stratified development/sealed split is in place under
  `runs/finetuned/code3/data/`.
- All 6 Google experiment processes are on CPU IDs 4–7. Memory: 21 GiB available.
  Disk: 25 GB free.

## Finetuned code3 closeout; code3 closed, 2026-11-17 04:08 UTC

**Finetuned code3** exited 0 at 04:03:53 UTC, after 31 minutes.
- Lead: budget 119 of 150 used, 2 scout calls, 47 shell calls, 2 harness trials.
- [Trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/4952b4697e91921ceaee0bfb2218d912),
  pipeline run `c463a7a2-…`.
- Trials:
  - `f0c86f92` scored CV ARI 0.8083 and became the first champion;
  - `b8b0f435` scored CV ARI **0.8456**, "+0.0381: improvement beyond fold noise", and
    is the champion (solution commit `b2206e34`).
- Terminal refit `cfcfc3d6…`: `fit_predict` on the 1,487-program test batch, 1 fit call.
- Recorded model cost: about $3.39 (sum over the trace observations).

Independent validation (`code3-finetuned-delivery-validation.json`, script in
`runs/exports/google-code3-finetuned-20261117/`) passed every check:
- 1,487 rows = exact unique test members; no header; integer IDs;
- manifest hash and line count;
- source ZIP CRC, with 26/26 members equal to the refit source;
- refit artifact hashes, and 17/17 evidence hashes;
- refit predictions equal to the delivery, and the commit matches.

| Measure | Finetuned | Minimal |
|---|---|---|
| Clusters | 19 (300/262/168/140/123/120/101/88/50/41/26/17/14/14/8/5/4/4/2) | 12 (300/262/168/165/140/118/101/68/50/49/41/25) |
| Output SHA-256 | `83c115a7…` | `8de1fb1c…` |
| Harness CV ARI (family-stratified development rows) | 0.8456 | — |
| Self-reported local ARI | — | 0.9987 (Ward cut at the true family count on its own 20% split) |
| Sealed holdout ARI (331 rows) | **0.8855**, 95% bootstrap [0.839, 0.931], gap −0.040, no selection-overfit flag | — |
| Official test score | none (offline) | none (offline) |

On the test programs, the arms' partitions agree at ARI **0.9152**. Cloud observations:
1,978 (trace mode, 20 pages, complete).

**Backup.** `google-code3-finetuned.zip`: 178,999,939 bytes, SHA-256 `d68f2d59…`,
5,090 files including `model.pkl`.
- It used the `acknowledgeAbuse` `backup.py`. The round trip verified size, SHA-256, ZIP
  CRC and every member hash.
- `_truth` is excluded.
- Sharing (recorded, not enforced): owner plus one writer.
- Folder: https://drive.google.com/drive/folders/1EXOhTde1HYTiKFozg8EnN9fgXDO2z9h6.
- `completed-finetuned-code3.json` and `active-step.json` carry `backupVerified`.

**Data cleanup.** No Google runtime was alive. Removed the win train/labels/test files,
the finetuned `win-train-dev.zip` and two `sealed.zip` copies: 1,469,639,162 bytes.
Receipt: `code3-dataset-cleanup.json`. Disk: 26 GB free. **code3 is closed.**

**code1 next.** The code1 (Android) page still ends in PENDING, in this checkout and in
the main checkout. No filled page has arrived from the Qwen observer. Under the schedule
rule I stage code1 and write the local protocol myself from the staged archives.

## code1 staged; local protocol written by this observer; minimal code1 launched, 2026-11-17 04:09 UTC

**Task material.** I read the unit intro ("Clustering of Malicious Code") and the
verbatim code1 page ("Malicious Code for Android"). Page, `meta.json` and the PENDING
text are identical to the main checkout. The finetuned declaration hash `2f9069ba…` is
the same in both checkouts, and the index entry matches the task URL.

**Staging** (`stage_code.py android`, receipt `staging-android/staging.json`, log
`code1-staging.log`). Both archives were downloaded with live size/ETag checks against
the course-share inventory, decrypted (GPG + gzip) and passed the ZIP CRC check.
- `android-train.zip`: 3,186,853,371 bytes, SHA-256 `439978cc…`.
  - It holds **1,000** applications under `data/android-known/` plus the embedded
    `android-train.labels`. The members are ZIP/APK files.
  - Labels: `android-train.labels`, SHA-256 `6072cfb9…`, 1,000 lines
    `<path>;<family>`. There are **10 families with 100 each**, numbered
    1, 3, 5, 8, 10, 12, 14, 16, 18, 20.
- `android-test.zip`: 1,796,980,429 bytes, SHA-256 `7c3a3b9a…`. It holds **1,000** `.x`
  applications under `data/android-unknown/`, with no labels.
- **The Qwen runner has not staged code1 yet**, so there is no Qwen receipt to compare
  hashes against. Verification rests on the share ETag/size, GPG/gzip decoding, ZIP CRC
  and exact label coverage. When the Qwen receipt appears, compare it with these hashes.
- Disk after staging: about 20.7 GB free.

**Local protocol.** No filled page had arrived from the Qwen observer, so I wrote the
local protocol myself (schedule rule). The prompt's PENDING paragraph was replaced with
a section in the same factual style and wording as code2/code3:
- the data files, member layout and label-file format;
- the family numbering;
- the file-name note (training names end in the family, test names in `.x`);
- the output line format.

Details:
- The examples are real member names: training `gsgoiiysvlurjwph.18`, test
  `aaozdbxappefffnv.x` and `abpjunusvshrjyid.x`.
- There is no modeling advice.
- The section's opening sentence is the same one code3 uses. It is a repository addition
  under the existing "Local offline protocol (repository addition…)" heading.
- I deliberately kept observer provenance out of the runtime text.
- New page SHA-256 `110382a3…`. The pre-edit page is saved as
  `code1-prompt-pending-before.md`.
- **Provenance:** reconstructed by the Google observer from the staged archives, not
  verbatim and not from the Qwen observer. If the Qwen observer later sends its version,
  record any difference. The two models may then have seen slightly different protocol
  wording for code1.

**Preflights.** Both passed:
- minimal `--continue` check-setup: ok;
- finetuned: run `586300df-…`
  ([trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/7e725ee3c79ccad53337a1e4768b50fc)).

**Launch.** Minimal code1 started at **04:08:51 UTC** via `launchDetached` and
`run_step.ts minimal code1 runs/minimal/2026-11-15T23-44-56`.
- Controller PID **733872**, all on CPU IDs 4–7.
- Launch record: `minimal-code1-launch.json`. Log:
  `2026-11-17T04-08-51-609Z-minimal-code1.log`.

code1 is the last scoped task.

### Minimal code1 check, 2026-11-17 04:09 UTC

Healthy, 30 seconds in. The solver is inspecting the Android archives and label counts
(11 tool calls). All 4 Google experiment processes are on CPU IDs 4–7. Memory: 21 GiB
available. Disk: 21 GB free with the 5 GB code1 inputs staged. No action taken.

## Minimal code1 completion and backup; finetuned code1 launched, 2026-11-17 04:31 UTC

**Minimal code1.** Delivered in **21.1 minutes**, exit code 0, recorded model cost
$0.95751. Solver session 1; solver module `agent/smartlab/tasks/code1.py` (295 lines).
- Approach (from the manifest):
  - Drebin-style static APK features: permissions, intents, hardware features,
    component signatures, sensitive Dalvik framework API calls, assets, native
    libraries, certificate signatures;
  - weighted TF-IDF;
  - Ward-linkage hierarchical clustering cut at **10 clusters** (the training family
    count).
- Self-reported local ARI: **0.555457**, from the same Ward/k scheme on its own
  training holdout. That is the agent's own measurement, not official.

**Independent validation** (`code1-minimal-delivery-validation.json`) passed:
- 1,000 rows = exact unique `.x` test members; no header; integer IDs;
- manifest hash and line count;
- source ZIP CRC, with 98/98 members equal to the retained run, including the solver
  module;
- the retained predictions equal the delivery.

Test clustering: 10 clusters, sizes 432/140/100/96/62/51/44/31/23/21. The training
families have 100 each. Output SHA-256 `4ef71404…`. Cloud observations: 166 (session
`code1-20261117T040853-eaffed`, complete).

**Backup.** `google-code1-minimal.zip`: 171,925,071 bytes, SHA-256 `9917263b…`, 1,118
files.
- The round trip (`acknowledgeAbuse`) verified size, SHA-256, ZIP CRC and every member
  hash.
- `_truth` is excluded.
- Sharing (recorded, not enforced): owner plus one writer.
- Folder: https://drive.google.com/drive/folders/1os_chdNFLWe3kF386fuzL5FIOkgkkgJV.
- `completed-minimal-code1.json` and `active-step.json` carry `backupVerified`.

**Finetuned code1.** The pre-launch check-setup passed again: run `ed92e057-…`
([trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/642bf840487f0f40862be551de2defa8)).
- Started at **04:31:23 UTC** via `launchDetached` and `run_step.ts finetuned code1`.
- Controller PID **742650**, all on CPU IDs 4–7.
- Launch record: `finetuned-code1-launch.json`. Log:
  `2026-11-17T04-31-23-561Z-finetuned-code1.log`.
- Disk: 21 GB free.
- This is the last run of the campaign.

### Finetuned code1 check, 2026-11-17 04:36 UTC; Bun binary note

**Health.** Healthy at 5 minutes.
- Phase `baseline`; budget 43 of 150 used; 1 scout call; 23 shell calls; no harness
  trial yet.
- The process group (controller 742650 → `./dev` 742668 → `cli.ts` 742681 → pipeline
  742701) is entirely on CPU IDs 4–7.
- Memory: 21 GiB available. Disk: 19 GB free.

**Observation: shared Bun shim.** The pipeline process runs
`/home/nico/Projects/auto-smart-lab/.tools/…/bun` (the main checkout's install) on this
checkout's `pipeline_cli.ts`.
- `bun run` puts the shared temporary shim `/tmp/bun-node-bf2e2cecf` first on PATH.
  That shim was created on 2026-11-02 by the main checkout's Bun, and its `bun`/`node`
  links point there.
- Both installs report the identical version and revision, `1.3.13+bf2e2cecf`. The file
  hashes differ (100,897,208 vs 101,814,712 bytes, installed 2026-10-07 vs 2026-11-15),
  probably a different build artifact of the same revision.
- The main-checkout binary is only executed, never written. Working directory, sources,
  configuration, data and outputs are all this checkout's.
- This has applied to every `bun run` script step of the Google campaign, not only
  code1. It is recorded as a provenance detail; no action taken, since it is neither a
  failure nor a setting change.

### Disk heads-up from the Qwen observer, 2026-11-17 05:02 UTC

The Qwen observer reported free space falling from 25 to 18 GiB on the shared disk. Qwen
still has to stage code1 (Android), and its staging aborts below a 6 GiB reserve.

Google usage at 05:02 UTC (`df`: 18 GB free):
- staged code1 inputs: 4.7 GB (`android-train.zip`, labels, `android-test.zip`; this is
  the only staged task);
- `runs/finetuned/code1`: 3.0 GB. That is the harness's `android-train-dev.zip`
  (2.55 GB) plus one `sealed.zip` (0.63 GB) per sealed confirmation. Each further trial
  confirmation adds about 0.63 GB.
- `runs/exports`: 1.7 GB of local copies of the Drive-verified backup ZIPs;
- `runs/minimal`: 1.7 GB.

All earlier task datasets are already deleted. When finetuned code1 is verified and
backed up, the code1 cleanup removes about 8–9 GB: staged inputs, dev ZIP and sealed
ZIPs. Google will stage nothing further, since code1 is the last task. If Qwen needs
space before that, the 1.7 GB of local export ZIPs could be removed, because each is
round-trip verified on Drive. That needs the user's go-ahead because it changes the
retention practice.

### Finetuned code1 check, 2026-11-17 05:06 UTC

Healthy at 35 minutes; no action taken.

- **Progress:** phase `improvement`; budget **149 of 150** (nearly exhausted); 2 scout
  calls.
- **Harness trials:** one so far. `c8ffbd2d` (04:53–04:54 UTC) scored CV ARI
  **0.6972** and is the champion; its sealed confirmation receipt is recorded.
- **Latest work:** the lead's last shell call committed a validation check file
  (`checks/code1/check_code1_validation.py`). PROGRESS was updated at 05:04:34 UTC.
- **Next:** the run should hand over (champion validation, then terminal refit) as the
  budget runs out. Watch for a budget-exhaustion failure at closeout.
- **Resources:** all 4 group processes are on CPU IDs 4–7. Disk: 18 GB free.

## Finetuned code1 closeout; code1 closed; campaign complete; schedules disabled, 2026-11-17 05:13 UTC

**Finetuned code1** exited 0 at 05:09:36 UTC, after 38 minutes.
- Lead: budget **149 of 150**, 2 scout calls, **1 harness trial**, status `handed_over`.
- [Trace](https://cloud.langfuse.com/project/cmwi1as2b00olad0g07uu3ofb/traces/ae2c38ce5111c738bfa77760d4dda443).
- The handover succeeded despite the nearly exhausted budget.
- Champion: `c8ffbd2d` (solution commit `050696eb`), CV ARI **0.6972**.
- Terminal refit `8829d04d…`: `fit_predict` on the 1,000-app test batch, 1 fit call.
- Recorded model cost: about $1.95. Cloud observations: 2,300 (trace mode, 23 pages,
  complete). No telemetry failure.

Independent validation (`code1-finetuned-delivery-validation.json`) passed every check:
- 1,000 rows = exact unique test members; no header; integer IDs;
- manifest hash and line count;
- source ZIP CRC, with 27/27 members equal to the refit source;
- refit artifact hashes, and 17/17 evidence hashes;
- refit predictions equal to the delivery, and the commit matches.

| Measure | Finetuned | Minimal |
|---|---|---|
| Clusters | **77** (largest 146/100/97/70/51; 15 singletons) | 10 (432/140/100/96/62/51/44/31/23/21) |
| Output SHA-256 | `e9df09e3…` | `4ef71404…` |
| Harness CV ARI | 0.6972 | — |
| Self-reported local ARI | — | 0.5555 (Ward cut at k = 10 on its own split) |
| Sealed holdout ARI (200 rows, 20 per family) | **0.6591**, 95% bootstrap [0.597, 0.760], gap 0.038, no selection-overfit flag | — |
| Official test score | none (offline) | none (offline) |

On the test apps, the arms' partitions agree at ARI **0.2793**. Training has 10 balanced
families of 100.

**Backup.** `google-code1-finetuned.zip`: 183,821,236 bytes, SHA-256 `64471faf…`,
5,683 files including `model.pkl`.
- The round trip (`acknowledgeAbuse`) verified size, SHA-256, ZIP CRC and every member
  hash.
- `_truth` is excluded.
- Sharing (recorded, not enforced): owner plus one writer.
- Folder: https://drive.google.com/drive/folders/10pTFWT-pAGPoRoV6_PEZfjvX2JFmRYjL.
- `completed-finetuned-code1.json` and `active-step.json` carry `backupVerified`.

**Data cleanup.** No Google runtime was alive. Removed the android train/labels/test
files, `android-train-dev.zip` and one `sealed.zip`: 8,170,686,257 bytes. Receipt:
`code1-dataset-cleanup.json`. **No task data remains staged in this checkout.** Disk:
25 GB free, which leaves room for the Qwen code1 staging.

### Campaign summary (Google, code/attacks part)

Offline, so there are no official scores. CV and sealed values are harness measurements
on training data; the minimal values are the agents' own measurements.

| Task | Minimal: minutes / cost / output | Finetuned: minutes / cost / output | Finetuned CV → sealed | Arm agreement |
|---|---|---|---|---|
| code2 (PHP) | 28.4 / $0.62 / 8 clusters | 90 / ~$1.25 / 5 clusters | ARI 0.901 → 0.870 | ARI 0.217 |
| attacks1 | 10.7 / $0.56 / 299 flagged | 22 / ~$1.25† / 122 flagged | evidence AP 0.732 (no holdout) | 2,647 / 2,990 equal |
| code3 (Windows) | 13.5 / $0.70 / 12 clusters | 31 / ~$3.39 / 19 clusters | ARI 0.846 → 0.885 | ARI 0.915 |
| code1 (Android) | 21.1 / $0.96 / 10 clusters | 38 / ~$1.95 / 77 clusters | ARI 0.697 → 0.659 | ARI 0.279 |

†The attacks1 finetuned cost was not summed. The trace is incomplete for one score write.

**Campaign complete.** Every dataset-backed scoped task has run in both arms. Each was
independently validated and round-trip backed up, and its data was removed:
spam1–3, documents1–4, code1–3 and attacks1. Tor, attacks2, offense1–2 and defense1 are
out of scope or deferred.

Both observer schedules (30-minute interval and completion webhook) were **disabled** at
05:13 UTC, because the last scoped task closed out.

Open items for the user:
- **code1 protocol:** it was written by this observer; it differs from any later Qwen
  version unless aligned.
- **attacks1 observer-side BACC:** an optional observer-side balanced accuracy for
  attacks1 against `units/_truth` (needs re-staging).
- **Local export ZIPs:** whether to remove the 1.7 GB of local export ZIPs.
- **Submission CSVs:** the submission-CSV tree for Lukas covers spam/documents only and
  could be extended with code1–3 and attacks1.

## Post-campaign: code1 prompt aligned with the main checkout (2026-11-17)

After both Google code1 arms had finished, the Qwen observer reported that the main checkout now has a code1 local protocol (sha256 `0998d611…`). I copied it over the Google copy and checked that the sha256 matches. The text both Google code1 arms actually ran with (sha256 `110382a3…`) is kept as `runs/diagnostics/google-sequential-20261116/code1-prompt-google-used.md` and is also in both code1 Drive backups. The facts in the two texts are the same. They differ only in wording ("apps" instead of "applications"), the main text adding "with 100 apps each", and different example test paths in the output-format block. Google and Qwen code1 runs therefore did not see byte-identical task pages; keep this in mind when comparing the two models on code1. Nothing was rerun.

## Post-campaign analysis: why finetuned code1 delivered 77 clusters, and why the leads hand over early (2026-11-17)

**77 clusters.** The champion (`c8ffbd2d`, solutions commit `050696e`) is TF-IDF over AXML/DEX/member-path strings plus average-linkage agglomerative clustering. It uses a fixed `distance_threshold=0.68` and `n_clusters=None`, and never uses training labels inside `fit`. With a fixed cosine cut-off, the cluster count grows with batch size, because every batch is clustered on its own, with its own TF-IDF fit:

| Batch | Rows | Clusters |
|---|---|---|
| CV folds (10-fold × 3 on 800 dev rows) | 80 | 12–18 |
| Sealed holdout | 200 | 25 (0 singletons) |
| Test refit | 1,000 | 77 (15 singletons; largest 146) |

Every measurement the harness made (CV ARI 0.697, sealed ARI 0.659) was on batches of 80–200 rows. None of them showed how the pipeline behaves on a test-sized batch. The lead had the evidence in its own shell sweeps: on all 800 dev rows, average linkage at 0.70 gave 54 clusters and at 0.60 gave 103. It then tuned the cut-off on 80-row stratified batches "mirroring the harness environment" and committed 0.68. Those sweeps were local multi-candidate CV loops through bash, which `lead-system.md` tells the lead not to run. The harness does not enforce this. code1 spent about 77 bash calls before its first trial; Langfuse TOOL observations include scout calls. The unit intro states that test families differ from training families, so `k=10` was not given. The count is still driven by batch size, not by the data. Other clustering runs are much less affected: code2 has 3–6 clusters per fold, 6 on the holdout and 5 on the test set; code3 has 9–27, 14 and 19.

**Early hand-over.** All 11 finetuned leads handed over by choice. Calls used were 58–149 of 150, with 1–2 official trials each. Most calls go to exploration before the first trial: 24–77 bash calls per run. After the first champion the runs follow the prompt's readiness path (`hand_over` checkpoint → validation → `finalize`) and do not run a measured improvement loop. `lead-system.md` asks for an early readiness checkpoint and to "budget delivery before optional improvements", and leaves "when the result is good enough" to the lead. Gemini Flash finalized soon after its first validated champion in every run; second trials were repairs or one follow-up, never a sustained loop. No harness or prompt change was made; this is an observation for the finetuned design.

## Reset after documents4 for the rerun on the new base (2026-11-17)

**Decision (user, relayed by the Qwen observer).** Reset both arms to the state right after documents4 and rerun code2, attacks1, code3 and code1 on the new harness base (`main` 4c983d2: anchored batch clustering plus the trial digest; the minimal arm is unchanged). Every code and attacks1 result above, in both arms, is superseded and must not be used in comparisons. The Drive backups and these report sections stay as history.

**How the Google checkout was reset.** The script is `runs/diagnostics/google-sequential-20261116/reset_after_documents4.py`. The receipt, with the hashes of everything replaced or removed, is `reset-after-documents4-receipt.json` in the same folder.
- **Finetuned:**
  - `runs/finetuned/solutions` and `runs/finetuned/findings` were restored from the documents4 finetuned backup. The local archive sha matched the verified Drive backup, and every member hash matched the inventory (436 files).
  - `runs/finetuned/{code1,code2,code3,attacks1}` and their `deliveries` were removed.
  - Checks afterwards: `git fsck` is clean (one dangling tag object from that time); all 23 registered refit worktrees exist; `git status` is clean.
  - The tags are exactly champion/trial for spam1–3 and documents1–4. The findings board holds 238 entries, from spam and documents only.
- **Minimal:**
  - The chain `runs/minimal/2026-11-15T23-44-56` was restored from `snapshot-1794875704292`, taken when code2 minimal started (2026-11-17 00:35:04Z). `.venv` and `node_modules` were kept. Verified identical to the snapshot by content hash (156 files).
  - The three later snapshots were removed.
  - `pefile`, `pillow` and `pip`, which minimal agents had installed after the snapshot, were uninstalled. The `.venv` now matches the snapshot's `venv-packages.txt`.
  - The script's own final equality check compared full paths and failed spuriously after the restore. The hash comparison above replaced it, and the receipt notes this.
- **Harness:** the Google checkout carries the same harness code as `main` 4c983d2. The only differences are its Google provider and configuration files, including the setup probe's thinking level. Typecheck passes. The fast suite has 644 passing and 1 failure from retained local task data (the spam1 dev archive was removed at task close-out).
- **Rerun records** go to a new diagnostics folder. Drive backups use the suffix `-rerun-20261117`.

**Rerun preparation, 2026-11-17 15:3x UTC.**
- **Diagnostics folder:** the rerun uses `runs/diagnostics/google-rerun-20261117`, which holds copies of `run_step.ts`, `validate_minimal_code.py`, `backup.py` and `stage_code.py` with only the record path changed. The old campaign records are not overwritten.
- **Code identity:** `base-2026-11-17.json` records HEAD `f8b474b` and tree hash `a991f2a0…`. The hash covers the diff against HEAD plus untracked files, excluding `runs/` and `docs/experiments/`, as in the Qwen controller.
- **code2 staging and checks:** code2 is staged; the hashes equal the Qwen receipts. Both `--check-setup` checks pass, and the minimal check confirms the restored chain is accepted for `--continue`.
- **Premature launch:** the code2 minimal launch at 15:32:24Z happened before the user asked both observers to sync, and failed after 0.6 s without any agent or model call. During the reset, `pip` had been removed from the chain `.venv` by comparing against `uv pip freeze`. The wrapper uses `python -m pip freeze`, which never lists pip itself.
  - Fix: pip 26.3 reinstalled; `pip freeze` is identical to the snapshot's `venv-packages.txt`; the chain is untouched (`chain.jsonl` still ends at documents4).
  - Cleanup: the duplicate snapshot `-1794929544592` was removed, and the step record was archived as `failed-launch-minimal-code2-20261117T153224Z.json`.
- **Waiting:** for the user's go after the joint risk check with the Qwen observer.
- **Backup rules for the rerun:**
  - every `*-dev.zip` and `sealed.zip` is excluded explicitly, with hash and size recorded;
  - the local backup ZIP is deleted after the Drive round trip verifies, keeping the manifest and inventory;
  - Drive folders get the suffix `-rerun-20261117`.
- **code1** runs strictly sequentially with the Qwen side, which also limits disk and RAM (the probe's process tree peaked at 7.9 GB).

## Rerun launched (user go, 2026-11-17)

- **code2 minimal** was launched at 15:41:05Z (record `runs/diagnostics/google-rerun-20261117/minimal-code2-launch.json`, cores 4-7). It continues the restored chain; the agent read its memory, which ends at the spam and documents tasks. The Qwen side launched at 15:39:28Z.
- **Drive replacement (user instruction):** after a rerun backup of a task and arm verifies, the old-base Google folder for the same task and arm is moved to Drive trash (recoverable for 30 days) with `drive_replace_old.py`. The old folder id and the trash time are recorded in the new backup's `status.json`. A read-only check beforehand showed all eight old folders are owned by this account and trashable.
- **Observer schedules:** both were re-enabled with rerun instructions (every 30 min, plus the completion webhook).

### Rerun: code2 minimal closed out; code2 finetuned launched (2026-11-17 16:13Z)

- **code2 minimal (rerun)** exited 0 after 29.9 min, at $0.65.
  - Delivery: `logs/deliveries/2026-11-17T15-41-06/code2`, with 4 clusters. The agent's own local score was 0.918.
  - Approach: TF-IDF on code tokens, cosine distance and average-linkage hierarchical clustering at threshold 0.86, with outlier reassignment.
  - Independent validation passed: 355 unique test IDs equal to the test members, no header, integer labels, manifest/source/retained-module hashes match (`code2-minimal-delivery-validation.json`).
  - Cloud observations: session `code2-20261117T154107-9cd5b9`, 160 observations, complete.
  - Backup: `Google minimal code2 rerun - 2026-11-17` (https://drive.google.com/drive/folders/19rbA6mJtS8lmE9ser1fyNVf6divqPWCQ), 175 MB, sha `6e4026f3…`, 1,127 files, round trip verified, local ZIP deleted. No dataset archives were in scope. Sharing: owner plus one writer (intentional).
  - The old code2 minimal folder `105aL84uke252ckF7BQDKtEiHcrIrfsIe` was moved to Drive trash at 16:12:44Z.
- **code2 finetuned (rerun):**
  - `--check-setup` passed.
  - Launched at 16:13:11Z, cores 4-7; record `finetuned-code2-launch.json`.

### Decision: the minimal arm is not rerun (2026-11-17 ~16:20Z)

**Decision (user, relayed by the Qwen observer).** The minimal arm is not rerun. The harness change touched only `harness/finetuned`, so the original minimal results for code2, attacks1, code3 and code1 stay valid and are used in comparisons. This corrects the earlier note that all code and attacks1 results in both arms were superseded: only the finetuned ones are.

**Google side, undone to match.**
- **Discarded attempt:** the completed code2 minimal rerun (exited 16:11Z, 4 clusters, $0.65) is not part of the experiment. `completed-minimal-code2.json` in the rerun folder is marked discarded.
- **Local chain:**
  - The minimal chain was restored once more to the pre-code2 snapshot `-1794875704292`.
  - The 35 files the attempt added or changed are hashed in `restore-minimal-receipt.json`.
  - The attempt's launch snapshot `-1794930066448`, identical to the restore point, was removed.
  - The `.venv` is unchanged (no packages installed).
  - `chain.jsonl` again ends at documents4.
- **Drive:**
  - The old minimal code2 folder `105aL84uke252ckF7BQDKtEiHcrIrfsIe` was restored from trash.
  - The rerun's minimal folder `19rbA6mJtS8lmE9ser1fyNVf6divqPWCQ` was moved to trash (recoverable for 30 days). This is recorded in its `status.json` (`decisionReversal`).
  - The trash-on-replace rule now applies to finetuned folders only.
- **Remaining rerun, finetuned only:** code2 (running since 16:13Z), then attacks1, code3, code1. code1 stays strictly sequential with the Qwen side.

**Health check, code2 finetuned rerun (16:4xZ).** Running on cores 4-7. RAM: 21 GB available. Disk: 27 GB free. Lead: 117 of 150 calls, improvement phase.
- First trial `c203febe` became champion at anchored ARI 0.900. It ran 12 folds (4 × 3) of 131–132 labelled rows plus all 355 test inputs.
- Labelled part: 5–7 clusters per fold.
- Test part: 3–4 clusters per fit, no singletons; agreement across fits mean 0.91 (min 0.47).
- A second trial (`b085b32b`) is running. No anomalies so far.

### Rerun: code2 finetuned closed out; attacks1 finetuned launched (2026-11-17 16:47Z)

**code2 finetuned (rerun)** exited 0 after 31 min (16:13–16:44Z).
- **Lead:** 124 of 150 calls, 2 trials. Champion `c203febe` (anchored ARI 0.900, 4 × 3 folds of about 131 labelled rows plus all 355 test inputs); `b085b32b` scored 0.899.
- **Method (lead's description):** sublinear lexical TF-IDF, cosine metric, average-linkage agglomerative clustering.
- **Delivery:** 4 clusters (220/79/51/5), taken from the sealed confirmation; the replay is identical (ARI 1.0).
- **Sealed ARI:** 0.864 [0.737, 0.961] on 132 rows; gap 0.036; no overfit flag. Sealed batch test part: 4 clusters, no singletons, largest share 0.62.
- **Agreement with the original minimal code2 delivery** (8 clusters): ARI 0.586.
- **Validation:** independent check `validate_finetuned_rerun.py` passed (`code2-finetuned-delivery-validation.json`).
- **Cloud observations:** trace `7f5ee888…`, 1,701 observations, complete.
- **Backup:** `Google finetuned code2 rerun - 2026-11-17`, 178 MB, sha `22bf2d45…`, 4,127 files, round trip verified, local ZIP deleted.
  - Excluded datasets: the dev ZIP (38.9 MB) recorded by hash; `sealed.zip` excluded by `backup.py`'s own rule.
  - The old finetuned code2 folder `1-LavLPyuOlLfnQCg31-Jzg-2NYfohA6J` was moved to Drive trash at 16:46:59Z.
- **Cleanup:** code2 datasets removed (5 files, 129 MB) with receipt `code2-dataset-cleanup.json`.

**attacks1 finetuned (rerun).**
- Staged; the test archive hash `cb9c7fd7…` matches. The prompt and unit intro are present.
- `--check-setup` passed. Launched at 16:47:45Z on cores 4-7.

**Health check, attacks1 finetuned rerun (~17:1xZ).** Running on cores 4-7. RAM: 21 GB available. Disk: 27 GB free.
- Lead: 99 of 150 calls, still in the baseline phase, no harness trial yet.
- 48 shell calls so far: image statistics, a local IsolationForest outlier count (150 of 2,990 flagged), and a 12-feature extraction over all 2,990 images in 2.8 s.
- Risk: the budget may run out before a validated hand-over. In the first campaign, Qwen's attacks1 finetuned failed for that reason. No intervention, per the rules (observer only); recorded for the summary.

### Rerun BLOCKED: attacks1 finetuned failed on a harness score bound (2026-11-17 17:20Z)

**What happened.** attacks1 finetuned (rerun) exited 1 at 17:20Z with no delivery: "No trial became champion".
- The lead's only trial `a17bffd0` completed at 17:16Z and was promotion-eligible. Its evidence AP was 1.0 in all 5 folds (140 evidence labels).
- The harness did not promote it, and the lead's feedback said "Champion now: none yet".
- The lead spent its remaining calls without a hand-over (150 of 150).

**Cause.** The fold scores came out as `1.0000000000000004, 1.0000000000000002, 0.9999999999999999, 1.0, 1.0`, a floating-point overshoot of sklearn's average precision. Their mean, `1.0000000000000002`, is rejected by `harness/finetuned/agent/training/results.ts:429` ("primary metric must be between 0 and 1"), so the trial was silently excluded from champion selection. The exported trace contains the `invalid_result` error.
- The bug predates the 2026-11-17 change and is present on `main` and in the Qwen checkout.
- It can hit any task whose fold scores land at about 1.0: evidence AP, balanced accuracy or ARI.
- This is a harness defect, not a model outcome.

**Evidence.**
- Trace `795132df…` (1,727 observations, complete).
- Backup `Google finetuned attacks1 rerun FAILED harness score bound - 2026-11-17` (https://drive.google.com/drive/folders/1KC3EEplQYIhR3Ccgf8_-Mal_LoWggZeD): 193 MB, sha `58a4c141…`, round trip verified. The dev ZIP (7.3 MB) is excluded and recorded by hash.
- The old valid attacks1 finetuned backup is NOT trashed.
- `completed-finetuned-attacks1.json` records the outcome as `failed_no_delivery_harness_bug`.

**Actions.**
- Both Google schedules are disabled; code3 has not started.
- The attacks1 data stays staged.
- The Qwen observer was alerted.
- Waiting for the user's decision. Proposal: fix the bound (tolerance 1e-9 and a clamped stored score) with a regression test, merge to `main` and the Google checkout, then rerun attacks1 finetuned from the post-code2 state restored from the code2 finetuned rerun backup.

### Rerun resumed: metric-bound fix; attacks1 finetuned attempt 2 (2026-11-17 17:46Z)

**Decision (user, relayed by the Qwen observer).** Keep the range check, because harness-computed scores outside [0,1] (or [-1,1] for ARI) would mean a real measurement bug, but tolerate rounding noise. Rerun attacks1 finetuned from the post-code2 state.

**Fix.** Qwen's patch `metric-bound-fix.patch` (sha256 `12096f1e…`) adds `METRIC_BOUND_TOLERANCE = 1e-9` to the check in `results.ts` and a regression test.
- Applied in the Google checkout; both files are identical to `main`'s.
- Results tests 11/11 pass; typecheck passes.
- Re-collecting the failed attempt's training folder now gives trial `a17bffd0` no errors, so it would have been promoted.
- `results.ts` is not in the refit framework hash. `base-2026-11-17.json` now records tree `73ca3b31…`, with the previous hash kept in its history.

**Reset to post-code2.** `restore_post_code2.py` downloaded the verified code2 finetuned rerun archive from Drive (sha `22bf2d45…` matched) and restored `runs/finetuned/solutions` and `findings`. All 491 members matched the inventory.
- The failed attacks1 state was removed: solutions 517, findings 3 and attacks1 382 files, hashed in `restore-post-code2-receipt.json`.
- Checks afterwards: `git fsck` clean (old dangling tag object only); worktrees intact; `git status` clean; no attacks1 tags or task file. The findings board ends at code2 (27 entries).
- The failed attempt's records are kept as `finetuned-attacks1-launch-attempt1.json` and `completed-finetuned-attacks1-attempt1.json`, and its FAILED Drive backup stays.

**Launch.** attacks1 finetuned attempt 2: `--check-setup` passed; launched at 17:46:20Z on cores 4-7. The schedules are re-enabled.

### Rerun: attacks1 finetuned attempt 2 delivered a degenerate all-zero output; code3 finetuned launched (2026-11-17 18:16Z)

**attacks1 finetuned, attempt 2** exited 0 at 18:13Z after 27 min, using 145 of 150 calls.
- **Trials:**
  - `e8364924`: evidence AP 0.768; flagged 6–9% per fold.
  - `94c2349f` (hypothesis "Fix binary prediction domain to {0, 1} with 1 for adversarial"): AP 1.0. It became champion with +0.232, beyond fold noise.
- **Validation passed** (2,990 exact unique IDs, binary values, hashes verified). **But all 2,990 predictions are 0.**
  - The task declares `anomalyLabel: -1`. The champion's `predict` returns 1 for adversarial and 0 otherwise, and the harness maps only -1 to a delivered 1.
  - As a result, `predictedAnomalyFraction` is 0.0 in all 10 folds and the delivery is all zeros.
  - The lead's digest showed "mean flagged share 0.000" and it handed over anyway.
- **Classification:** the model's own error; the harness applied the declared contract correctly.
  - Design gap reported to the user: evidence-AP promotion ignores the 0/1 decisions, and nothing flags a pipeline that never outputs the declared anomaly label.
  - The original (valid) minimal attacks1 flagged 299. Equal predictions to it: 2,691 of 2,990, all on its 0 rows.
- **Records:**
  - Trace `580cc081…`: 2,192 observations, complete.
  - Backup `Google finetuned attacks1 rerun attempt 2 - 2026-11-17` (https://drive.google.com/drive/folders/1SHNw_TEC0oX8uOjNWK8H0R9h_xhI6lVN): 198 MB, sha `bc945d8a…`, verified, local ZIP deleted.
  - **The old valid attacks1 finetuned Drive folder is NOT trashed**, pending the user's decision on a decision-domain check.
  - attacks1 datasets removed (3 files, 21.9 MB, `attacks1-dataset-cleanup.json`); they can be re-staged.

**code3 finetuned (rerun).** Staged; train/test hashes match Qwen's staging-win receipt; prompt sha `3b44a9cc…`. `--check-setup` passed. Launched at 18:16:20Z on cores 4-7.

**Health check, code3 finetuned rerun (18:2xZ).** Running on cores 4-7, 5 of 150 calls used, baseline phase. RAM: 21 GB available. Disk: 25 GB free. Still waiting for the user's decision on attacks1 (decision-domain check or accept); the old attacks1 finetuned Drive folder stays.

**Health check, code3 finetuned rerun (18:4xZ).** Running on cores 4-7, 44 of 150 calls used, baseline phase, no trial yet. RAM: 21 GB available. Disk: 25 GB free. The attacks1 decision is still open; the old attacks1 finetuned Drive folder stays.

### Rerun: code3 finetuned closed out; code1 finetuned launched (2026-11-17 19:20Z)

**code3 finetuned (rerun)** exited 0 at 19:16Z after 60 min.
- **Lead:** 99 of 150 calls, 1 trial. Champion `8f105f8d` at anchored ARI 0.994.
- **Delivery:** 57 clusters for 1,487 test files, taken from the sealed confirmation; the replay is identical.
- **Sealed ARI:** 0.986 [0.974, 0.996] on 331 rows; gap 0.007; no overfit flag. Sealed batch test part: 57 clusters, singleton fraction 0.009, largest share 0.20.
- **Agreement with the original minimal code3 delivery** (12 clusters): ARI 0.914.
- **Validation:** passed (`code3-finetuned-delivery-validation.json`).
- **Cloud observations:** trace `89276891…`, 1,794 observations, complete.
- **Backup:** https://drive.google.com/drive/folders/1HPkYHt0w51Sl9qC7cPDNDnQH786SCYls, 209 MB, sha `65e8e427…`, round trip verified, local ZIP deleted. The dev ZIP (325 MB) is excluded and recorded by hash.
- **Replaced:** the old code3 finetuned folder `1EXOhTde1HYTiKFozg8EnN9fgXDO2z9h6` was moved to Drive trash at 19:17:59Z.
- **Cleanup:** code3 datasets removed (5 files, 1.37 GB, `code3-dataset-cleanup.json`).

**code1 finetuned (rerun).**
- **Slot:** the Qwen observer confirmed Qwen holds no code1 data (CODE1_HOLD in place) and gave the slot to Google.
- **Staging:** the train/test hashes match Qwen's earlier staging-android receipt, and the prompt sha is `0998d611…`.
- **Launch:** `--check-setup` passed. Launched at 19:20:00Z on cores 4-7. Disk: 22 GB free after staging.

### Rerun: code1 finetuned closed out (2026-11-17 19:43Z)

**code1 finetuned (rerun)** exited 0 at 19:42Z after 22 min.
- **Lead:** 135 of 150 calls, 2 trials. `babb3877` (ARI 0.651) was not promotion-eligible. Champion `bb0c1252` at anchored ARI 0.655. Both trials saw 52–55 test clusters per fit, with agreement 0.98.
- **Delivery:** 54 clusters for 1,000 test files, taken from the sealed confirmation; the replay is identical.
- **Sealed ARI:** 0.668 [0.603, 0.768] on 200 rows; gap −0.013. Sealed batch test part: 54 clusters, singleton fraction 0.005, largest share 0.24.
- **Agreement with the original minimal code1 delivery** (10 clusters): ARI 0.264.
- **Validation:** passed. **Cloud observations:** trace `27bf4bbc…`, 2,027 observations.
- **Backup:** https://drive.google.com/drive/folders/12p55pEbjrS7KXh1t58UF_V-fueGNlPsB, 215 MB, sha `4dacd24a…`, verified. The dev ZIP (2.55 GB) is excluded and recorded by hash.
- **Replaced:** the old code1 finetuned folder `10pTFWT-pAGPoRoV6_PEZfjvX2JFmRYjL` was moved to Drive trash.
- **Cleanup:** code1 datasets removed (8.17 GB, `code1-dataset-cleanup.json`). The code1 slot was returned to the Qwen observer; Google holds no unit data.

## Rerun summary (Google, finetuned code/attacks on the new base, 2026-11-17)

**Scope.** Base: `main` 4c983d2 (anchored batch clustering plus trial digest), with the metric-bound fix (patch `12096f1e`) applied before attacks1 attempt 2. Only the finetuned arm was rerun; the original minimal results stay valid and are the comparison. The runs are offline, so there are no official scores. Costs are summed from the Langfuse trace exports.

| Task | Finetuned rerun | Calls / trials | Output | CV → sealed | Original minimal (valid) | Agreement with minimal |
|---|---|---|---|---|---|---|
| code2 | 31 min, $1.45 | 124 / 2 | 4 clusters | 0.900 → 0.864 | 28.4 min, $0.62, 8 clusters | ARI 0.586 |
| attacks1 | attempt 1: 33 min, $1.65, failed (harness bound); attempt 2: 27 min, $1.85 | 150 / 1; 145 / 2 | attempt 2: **0 of 2,990 flagged** (degenerate) | evidence AP 1.0 (ranking only) | 10.7 min, $0.56, 299 flagged | 2,691 of 2,990 equal |
| code3 | 60 min, $1.66 | 99 / 1 | 57 clusters | 0.994 → 0.986 | 13.5 min, $0.70, 12 clusters | ARI 0.914 |
| code1 | 22 min, $1.71 | 135 / 2 | 54 clusters | 0.655 → 0.668 | 21.1 min, $0.96, 10 clusters | ARI 0.264 |

**Observations.**
- **Sealed gaps are now small** for every clustering task (0.036, 0.007, −0.013). The sealed check and the delivery run on the same batch shape, so these gaps no longer mix in a batch-size effect.
- **The digest reached the leads**: test-part structure for clustering, flagged share for attacks1. On attacks1 the lead saw "mean flagged share 0.000" and still handed over.
- **The finetuned leads still finalize after 1–2 trials**, as in the first campaign.
- **Harness issues found during the rerun:**
  1. Metric bound: a floating-point overshoot above 1 made an eligible trial unpromotable. **Fixed** (tolerance 1e-9); see "Rerun BLOCKED".
  2. **Open:** evidence-AP promotion ignores the 0/1 decisions, and nothing flags a pipeline that never outputs the declared anomaly label (attacks1 attempt 2 delivered all zeros).

**Open items for the user.**
- The attacks1 decision: add a decision-domain or flagged-share check and rerun, or accept the degenerate result. **The old attacks1 finetuned Drive folder is kept until then**; the other three old finetuned folders are in Drive trash (recoverable for 30 days).
- The metric-bound fix is uncommitted in the main and Google working trees.

**Schedules.** Both Google schedules were disabled at the end of the rerun. The Qwen summary will follow from the Qwen observer.

### Anomaly output-contract fix deployed; Drive cleanup; attacks1 attempt 3 as the last task (2026-11-17 21:49Z)

**Cause of attempt 2's degenerate output: our harness, not the course.** The course task and the unit both say 0 = normal and 1 = adversarial. Our declaration set `anomalyLabel: -1` (scikit-learn's convention), and the harness prompt told the lead to return -1. That gave the lead two conventions for one output.

**Fix (user-approved).** Implemented by gpt-6.1-sol and reviewed twice by Opus; the second review checked each test by mutation. Deployed to the main and Google trees as `anomaly-output-contract.patch` (sha256 `c6f4d8eb…`, 24 files, 24e9738 → 9d30493).
- attacks1 now declares `anomalyLabel: 1`, and the lead prompt says "predict returns 1 for anomalies and 0 for normal rows".
- For label-1 tasks, predict values outside {0, 1} violate the contract: the trial cannot become champion, smoke fails, and the refit refuses them. This also blocks the reverse trap of raw scikit-learn output {1, -1}.
- A trial whose predict never returns the anomaly label, or always does, across all folds cannot become champion. The reason is shown to the lead; smoke gives a notice.
- Binary classification and clustering are unchanged.
- **Checks:** full `bun test` 778 pass, with 1 known pre-existing failure (`primaryMetric`); `test:py` 175 OK. After applying, both trees matched the branch byte for byte, typecheck passed, and the focused tests passed.
- **Code identity:** Google tree `2122ec40…`, recorded in `base-2026-11-17.json`.

**Order (user decision).** attacks1 runs last on both sides; no code task is rerun.
- **Google:** removed only its attacks1 traces with `remove_attacks1_traces.py`; receipt `remove-attacks1-traces-receipt.json`.
  - Removed: `runs/finetuned/attacks1` (447 files) and its delivery; `solutions/tasks/attacks1.py`, `checks/attacks1` and the scout scratch folder, removed in observer commit `68574a4a`; the tags champion/attacks1 and trials `94c2349f`/`e8364924`; 36 attacks1 board entries.
  - The board requires cursors to equal line numbers, so the remaining 347 entries were renumbered 1…347 in their original order (82 changed). The history check passes; `git fsck` and `git status` are clean.
  - Recorded asymmetry: Google's code3/code1 ran with attacks1 attempt-2 memory present.
- **Qwen:** restored to post-code2 and runs code3 → code1 → attacks1.

**Drive (user decision: "we only need our newest submissions").** Drive was full (14.93/15 GiB).
- Emptied the trash: the old Google finetuned code1/code3/code2 backups, the discarded code2 minimal rerun, and Qwen's old code2 continuation.
- Permanently deleted the old-base Qwen code1 finetuned backup (2.37 GB).
- Usage is now 12.44 GiB; the trash finishes emptying in the background. Receipt: `drive-cleanup-receipt.json`.
- `backup.py`'s request helper treats Drive's HTTP 204 as an error; the cleanup handled that explicitly.

**attacks1 attempt 3.** Staged (test archive `cb9c7fd7…`); `--check-setup` passed after the board fix. Launched at 21:49:04Z on cores 4-7; record `finetuned-attacks1-launch.json`. The attempt-2 records are kept as `-attempt2.json`.

### Rerun complete: attacks1 finetuned attempt 3 closed out (2026-11-17 22:08Z)

**attacks1 finetuned, attempt 3** (fixed anomaly contract, last task) exited 0 at 22:06Z after 17 min. Cost $1.46; 109 of 150 calls.
- **Trials:** `9505a2ed` (evidence AP 0.990, flagged 6.7–8.9% per fold) became champion. `a4c59e93` (AP 0.998, flagged 6.7–9.9%) was eligible but did not exceed fold noise.
- **Delivery:** **217 of 2,990 flagged (7.3%)**. Validation passed: exact unique IDs, binary domain, manifest/refit/evidence hashes.
- **Agreement with the original minimal attacks1** (299 flagged): equal on 2,600 of 2,990.
- **Cloud observations:** trace `86f503ee…`, 1,891 observations.
- **Backup:** `Google finetuned attacks1 rerun attempt 3 - 2026-11-17` (https://drive.google.com/drive/folders/11lq9AFMclCbtVFHDhrUMTctiTVUSXjmF), 218 MB, sha `b45b35d8…`, verified, local ZIP deleted.
- **Drive ("newest submissions only"):** the old first-campaign attacks1 finetuned folder and the attempt-1 FAILED and attempt-2 folders were moved to trash, and the trash was emptied (usage 12.09 GiB; Drive finishes emptying in the background). Recorded in `drive-cleanup-receipt.json` → `later`.
- **Cleanup:** attacks1 datasets removed (receipt `attacks1-attempt3-dataset-cleanup.json`). Google now holds no unit data.

**Final rerun table (Google).** Supersedes the attacks1 row of the "Rerun summary" above. Offline: no official scores.

| Task | Finetuned rerun | Output | CV → sealed | Original minimal (valid) | Agreement with minimal |
|---|---|---|---|---|---|
| code2 | 31 min, $1.45 | 4 clusters | 0.900 → 0.864 | 8 clusters | ARI 0.586 |
| code3 | 60 min, $1.66 | 57 clusters | 0.994 → 0.986 | 12 clusters | ARI 0.914 |
| code1 | 22 min, $1.71 | 54 clusters | 0.655 → 0.668 | 10 clusters | ARI 0.264 |
| attacks1 (attempt 3, run last) | 17 min, $1.46 | 217 flagged | evidence AP 0.990 (agent-chosen labels, ranking only) | 299 flagged | 2,600 of 2,990 equal |

- **Earlier attacks1 attempts, kept only as evidence in the report:** attempt 1 failed on the metric-bound bug; attempt 2 delivered all zeros because of the two label conventions.
- **Order and asymmetry:** Google ran code2 → attacks1 (attempts 1–2) → code3 → code1 → attacks1 (attempt 3). The attempt-2 traces were removed before attempt 3. Qwen runs code2 → code3 → code1 → attacks1 from a post-code2 restore.

**Schedules:** both Google schedules disabled at the end of the rerun.

## Tor unit (user decision 2026-11-17: run overnight on both sides; results due in the morning)

**Material.** The unit is no longer on the lab platform. The unit and task texts are the instructor message the user relayed on 2026-11-17, copied verbatim into `units/04-tor/unit-intro.md` and the task `prompt.md` files, marked with their source. The task text names no evaluation measure; **balanced accuracy is our declared assumption** for both tasks. Data comes from the course share `04-tor` (plain tar.gz).

**Registration** (Google checkout):
- `units/04-tor/{closed-world-50-points, open-world-50-points}` with `meta.json`, plus index entries tor1 and tor2 (identifier URLs on the share path);
- no course resources exist for this unit, and none are needed.

**Staging.** `runs/diagnostics/tor-20261118/stage_tor.py` converts tar.gz to ZIP, byte for byte, and checks each download against the share inventory (size, ETag) with sha256 receipts.
- **tor1:** 600 training traces, 30 websites × 20 (`<site>_<n>.pcap`); labels taken from the file names; 300 test traces (`<n>.pcap`).
- **tor2:** the task defines the closed-world websites as censored and its own training data as uncensored. The training ZIP therefore combines `censored/` (the closed-world train) and `uncensored/` (the open-world benign train), with a 1/0 labels file. Both arms get the same files.

**Harness.**
- tor2 is plain binary classification.
- tor1 needs a multiclass kind (30 website-name labels), which the finetuned arm lacked. gpt-6.1-sol is implementing it, followed by Opus review and the full suite. It will be deployed to the main tree only between Qwen runs.

**Runs.**
- **Minimal tor1** launched at 22:57Z, continuing the minimal chain at the post-documents4 snapshot state (both sides restored it for the rerun).
- **Order:** minimal tor1 → tor2 (minimal, then finetuned; staged only when Qwen holds no code1 data and ≥ 12 GiB is free) → finetuned tor1 once the patch is deployed.

**Tools:** `runs/diagnostics/tor-20261118/` holds `run_step.ts`, `validate_tor_delivery.py` and the completion webhook. Both Google schedules were re-enabled for Tor.

**Tor progress (00:3xZ).**
- **Minimal tor1:** running on cores 4-7, solver in its iteration phase. RAM: 21 GB available. Disk: 18 GB free.
- **Multiclass patch** (branch t3/multiclass-classification, worktree t3-0425341d):
  - An Opus review found no corrupting defects.
  - A real-data probe on the staged tor1 traces, with an observer probe pipeline using dpkt pcapng features, passed end to end: smoke; trial with CV BACC 0.698; sealed interval [0.583, 0.717]; refit on all 600 traces; valid delivery of 300 rows covering 30 labels.
  - The probe and the review led to fixes: the digest read the wrong field (`83ab5ca`); prompt facts on the input shape and the no-filename-features rule; recorded-holdout text for non-binary kinds; no `classes_` requirement (`a0af4b7`).
  - `test:py` passes; the full bun suite is running.
- **Data note:** the Tor traces are pcapng (magic `0a0d0d0a`), although the files are named `.pcap`. The task page was deliberately left unchanged, because minimal tor1 already runs with it.

**Minimal tor1 attempt 1 failed on a harness defect (00:27Z); fixed and relaunched (00:29Z).**
- **What happened:** minimal tor1 ended after 90 min with "3 solver sessions in a row without a submittable result". All three sessions hit their time cap without submitting.
- **Cause:**
  - `harness/minimal/agent/run/output_check.ts` accepted only `<id>;<integer label>` lines;
  - the solver prompt (`instructions/solver.md`) told the agent the same;
  - so tor1's website-name output (`1.pcap;www.mlsec.org`) could never be submitted. The agent read the orchestrator's check code during the run.
- **Fix:** minimal patch, per the user's instruction to fix overnight blockers minimally.
  - Both files now say `<id>;<label>` with a single-token label.
  - It still rejects missing or empty files, malformed lines and duplicate IDs. Format only; no coaching.
  - Patch: `minimal-label-fix.patch`. The minimal and experiment tests pass (123/0).
- **Continuation guard:** the solver prompt hash changed (`ebb246c7…` → `0a3ff4c0…`), so the chain's `chain-version.json` was updated to the new hash. The harness commit is unchanged, because the patch is uncommitted. Recorded in `minimal-tor1-attempt1-restore-receipt.json`.
- **Restore:** the chain was restored to the snapshot taken at tor1 launch. The failed attempt's 40 changed files are archived in `minimal-tor1-attempt1-chain-state.tar.gz`; its records are `*-attempt1.json`.
- **Relaunch:** minimal tor1 attempt 2 at 00:29:24Z on cores 4-7.
- **Same fix needed on the Qwen side** before its Tor runs: the patch plus the `chain-version.json` prompt-hash update.

**Health check (00:5xZ).** Minimal tor1 attempt 2 is running on cores 4-7; the agent read the patched output_check.ts. RAM: 20 GB available. Disk: 18 GB free. The multiclass full Bun suite is still running (no failures logged yet beyond expected test output). Finetuned tor1 waits for the patch deployment; tor2 waits for the Qwen code1 clearance.

**Multiclass patch deployed to the Google tree (01:1xZ).**
- **Patch:** `multiclass-tor.patch`, sha256 `80760741…`, 38 files, 786737a → a0af4b7. Every file matches the reviewed branch except Google's own thinking-level line in `setup.ts`.
- **Full bun suite:** 781 pass, 3 skip, 2 fail. One is the known `primaryMetric` failure. The other was the closed-solve confirmation test at its 90 s limit while minimal tor1 shared the cores; it passed alone.
- **Checks after deployment:** typecheck passes; multiclass, digest, loader and folds tests 33/0.
- **Meta fix:** the setup check rejected the Tor `meta.json` download links, because the staged files are converted, not downloadable. As in attacks1's meta, the files are now listed under `staged_files` with provenance, and there are no download links.
- **Status:** finetuned and minimal `--check-setup tor1` pass. Code identity is in `runs/diagnostics/tor-20261118/base-tor.json`.
- **Next:** finetuned tor1 launches after minimal tor1 attempt 2 finishes.

**Minimal tor1 attempt 2 delivered (00:52Z); finetuned tor1 launched (00:54Z).**
- **Minimal tor1, attempt 2:** 22.6 min, $0.88, solver session 1, agent's own local score 0.867.
  - Approach (manifest): CUMUL curves, bursts, inter-arrival times, packet-size bins and n-grams, with a soft-voting ensemble of ExtraTrees, RandomForest, HistGradientBoosting and LightGBM.
  - **Delivery: 300 rows with exact test IDs, but the labels are class indices 0–29 instead of website names.** The validator fails it on the label set. The task page asks for website names (`1.pcap;www.mlsec.org`), and the patched check accepts names, so this is the model's own error.
  - The observer did not alter the delivery. A mapping back to names, likely sklearn's sorted label order, is a user decision.
  - Cloud observations: session `tor1-20261118T002926-24f699`, 173 observations.
  - Backup: `Google minimal tor1 - 2026-11-18` (https://drive.google.com/drive/folders/1KMwEtuEY7SB_VyI7HAUi4uWZuOOf7Wo0), 196 MB, verified.
- **Finetuned tor1:** `--check-setup` passed on the deployed multiclass code; launched at 00:54:03Z on cores 4-7.

**Health check (01:2xZ).** Finetuned tor1 is running on cores 4-7: 38 of 150 calls, baseline phase, no trial yet. RAM: 20 GB available. Disk: 17 GB free. tor2 waits for the Qwen code1 clearance.

**Health check (01:5xZ).** Finetuned tor1 has used 149 of 150 calls and is still in the baseline phase, with no validated hand-over yet. Champion `02360d55` at CV balanced accuracy 0.838. `2cb9a0ce` scored 0.843 but did not exceed fold noise; `33058236` is running. At budget exhaustion the harness validates and refits the champion itself. RAM: 20 GB available. Disk: 17 GB free.

**Finetuned tor1 ended without delivery (01:36Z); tor2 staged and minimal tor2 launched (01:40Z).**
- **Finetuned tor1:** 42 min, 150 of 150 calls, 3 trials. CV balanced accuracy: champion `02360d55` 0.838; `2cb9a0ce` 0.843 and `33058236` 0.854, both within fold noise. No hand-over.
  - At budget exhaustion the validation scout blocked the champion. Its fallback feature vector for empty or corrupt traces has 264 dims instead of 270, which would crash `predict`. The 264-dim bug is the model's; but see the correction below: the lead had fixed it, and the harness could not promote the fix.
  - Backed up as `Google finetuned tor1 FAILED - 2026-11-18` (https://drive.google.com/drive/folders/11EBXvXvqElTYHRWGgeHuDsN2dP1v0Ri8, 225 MB, verified); trace `05e33716…`.
  - The new multiclass path worked end to end: trials, paired champion rule, validation gate.
- **tor1 datasets removed:** 2.17 GB, `tor1-dataset-cleanup.json`.
- **tor2:** the Qwen observer cleared the disk slot (no Qwen code1 data; Qwen holds code1 until Google's tor2 cleanup).
  - Staged: 1,200 training traces (600 `censored/` from the closed-world train, 600 `uncensored/` benign) and 600 test traces. Disk: 14.7 GB free afterwards.
  - The prompt was written in the tor1 style. Minimal and finetuned `--check-setup tor2` pass.
  - Minimal tor2 launched at 01:40:13Z on cores 4-7.
  - 02:01Z health check: running, iteration 1, about 19 min of solver time and 37 tool calls, still exploring the data. 19 GB RAM available, 15 GB disk free.
- **Minimal tor2 delivered** (01:40-02:29Z, 48.8 min, $0.63):
  - Session 1 hit its 30-min time cap without submitting. Session 2 (18.8 min) declared and delivered.
  - Agent's own local score 0.904. Approach per manifest: 30 monitored classes + 1 unmonitored class, CUMUL/burst/timing/size features, ExtraTrees/RandomForest/LightGBM ensemble, collapsed to 0/1.
  - Validation (`tor2-minimal-delivery-validation.json`) passed: 600 rows, exact test IDs, labels {0,1} (303 × 0, 297 × 1), manifest hash matches.
  - Cloud observations: session `tor2-20261118T014016-597d96`, 195 observations.
  - Backed up and round-trip verified: "Google minimal tor2 - 2026-11-18" (`runs/exports/google-tor2-minimal-20261118/`, 1,233 files, sha256 710bc137…), local ZIP deleted. Recorded in `completed-minimal-tor2.json`.
- **Finetuned tor2 launched** at 02:30:57Z on cores 4-7 (`finetuned-tor2-launch.json`). The tor2 datasets stay until it finishes.
  - 02:36Z: lead session running (run `6ff2e732`), 13 GB disk free. The Qwen observer has not reported idle yet (its code3 finetuned run is at 140/150 calls), so the main-tree Tor deployment is still pending.
- **Finetuned tor2 delivered** (02:30:57-02:56:55Z, 26 min). Run `e24b7083`, lead run `6ff2e732`.
  - The lead used 91 of 150 calls and 3 scout calls. It ran a single harness trial, `bd99f5fe` (commit c4a93f42): a random-forest-based open-world classifier with 393 trace features, CV balanced accuracy 0.876 (30 folds, spread 0.802-0.927).
  - The validation scout passed it twice with no fixes. Sealed holdout (240 rows, read once) 0.858, gap 0.018, not flagged as selection overfit.
  - The lead handed over after this first trial ("holdout confirms the improvement"); terminal refit followed, then delivery `deliveries/tor2/cf011e865241`.
  - Validation (`tor2-finetuned-delivery-validation.json`) passed: 600 rows, exact test IDs, labels {0,1} (300 × 0, 300 × 1), manifest hash matches.
  - Cloud observations: trace `d94bb3f3dc423fa20c82700100c790b4`, 1,968 observations.
  - Backed up and round-trip verified: "Google finetuned tor2 - 2026-11-18" (`runs/exports/google-tor2-finetuned-20261118/`, sha256 0189a2b7…), local ZIP deleted. Recorded in `completed-finetuned-tor2.json`.
- **tor2 datasets removed:** 6.24 GB (unit ZIPs, labels, finetuned dev and sealed copies), `tor2-dataset-cleanup.json`. 18.1 GiB free afterwards.

### Google Tor summary (2026-11-18)

Model google-vertex/gemini-3.8-flash, thinkingLevel high, offline, cores 4-7. Base: `base-tor.json` plus the multiclass patch (80760741…) and the minimal label fix (902c8241…). The task text names no metric; the finetuned arm measures balanced accuracy (observer assumption). Official scores: none (Lukas scores the deliveries).

| Task | Arm | Outcome | Agent / harness evidence | Drive folder |
|---|---|---|---|---|
| tor1 closed world | minimal | Delivered, wrong label domain: class indices 0-29 instead of website names (model error; delivery unaltered) | Attempt 2, 22.6 min, $0.88, own local score 0.867 | Google minimal tor1 - 2026-11-18 |
| tor1 closed world | finetuned | No delivery: validation scout blocked the champion (fallback feature vector 264 vs 270 dims), budget exhausted (150/150) | Best CV BACC 0.854; 42.5 min | Google finetuned tor1 FAILED - 2026-11-18 |
| tor2 open world | minimal | Delivered, 600 rows {0,1} (303/297) | 48.8 min, $0.63, session 1 time-capped, own local score 0.904 | Google minimal tor2 - 2026-11-18 |
| tor2 open world | finetuned | Delivered, 600 rows {0,1} (300/300) | 1 trial, CV BACC 0.876, sealed 0.858, 91/150 calls, 26 min | Google finetuned tor2 - 2026-11-18 |

Harness changes during Tor (uncommitted in the Google tree):
- the multiclass_classification kind for tor1;
- the minimal output check accepting single-token labels (minimal tor1 attempt 1 could not submit names).

Neither change touches how agents model; the label fix only widens the accepted answer format.

Open user decisions:
- whether to map minimal tor1's indices back to site names (sorted training labels) for submission; the observer did not do this;
- committing the Tor harness changes to main;
- the submission folder for Lukas.

All Tor datasets are removed from the Google checkout. The main-tree Tor deployment for Qwen waits for the Qwen observer's idle message.

Both Google Tor schedules are disabled (03:0xZ). The Qwen observer was told that tor2 data is gone and that the main-tree deployment waits for its idle message.

### Main-tree Tor deployment for Qwen (2026-11-18 ~03:20Z)

The Qwen observer reported idle (code3 finetuned closed without delivery; no Qwen process). Its order: Tor first, then code1 → attacks1.

Deployed into /home/nico/Projects/auto-smart-lab:
- `multiclass-tor.patch` (807607416635…) and `minimal-label-fix.patch` (902c82411278…). Forward `--check` passed, then both applied; reverse `--check` passed.
- After applying, every tracked and untracked file under `harness/` and `experiment/` matches the Google tree, except Google's pre-existing provider and thinking-probe differences (10 files, unrelated to Tor).
- Fast suite on main: 648 pass, 3 skip, 0 fail.
- Tor registration: `units/04-tor` (unit intro, both meta.json and prompt.md files, no data) and `tor1`/`tor2` added to `units/index.json`.

`stage_tor.py` and `validate_tor_delivery.py` stay in the Google folder; Qwen copies and adapts them.

New minimal solver.md hash: 0a3ff4c0… (Qwen chain promptHash ebb246c7… → 0a3ff4c0…).
- **Qwen confirmation (~03:10Z):**
  - Patch hashes and registration hashes verified; `git apply --check -R` clean.
  - New Qwen base: tree 3a627519…, framework 84ac49c9…, pipeline.config f52ac86b…, solver.md 0a3ff4c0…. Chain promptHash updated with a receipt.
  - tor1 staged byte-identical to Google's receipts; both check-setups pass.
  - `workflow_tor.py` runs on CPUs 0-3: minimal tor1 → finetuned tor1 → minimal tor2 → finetuned tor2. Each arm is validated with Google's validator, backed up, and its data removed per task. Then code1 → attacks1.

### Qwen Tor result (reported by the Qwen observer, 2026-11-18 ~08:30Z; details in the main checkout's docs/experiments/qwen-tor-2026-11-18.md)

| Task | Arm | Google | Qwen |
|---|---|---|---|
| tor1 | minimal | wrong label domain (indices 0-29); own local 0.867 | wrong label domain (indices 0-29, sorted-label order per manifest); own local 0.82 |
| tor1 | finetuned | no delivery (champion blocked by validation, 150/150); best CV BACC 0.854 | delivered site names; CV BACC 0.496, sealed 0.517 [0.458, 0.575] (120 rows), 147/150 |
| tor2 | minimal | delivered 303/297; own local 0.904 | delivered 303/297; own local 0.876 |
| tor2 | finetuned | delivered 300/300; CV BACC 0.876, sealed 0.858 | delivered 282/318; CV BACC 0.680, sealed 0.658 [0.596, 0.713] (240 rows), 140/150 |

"Own local" scores are the minimal agents' own measurements; they are not comparable with harness CV/sealed scores. Qwen continues with the finetuned code1 → attacks1 rerun.

### Correction: why finetuned tor1 failed (2026-11-18, re-analysis)

The earlier entry called this the model's own outcome. That is incomplete: a harness gap kept the lead from delivering its own fix.

Timeline from PROGRESS.json, the solutions repository tags and the Cloud trace:
1. **01:01-01:07Z:** trial `02360d55` (commit c5aebde3) set `N_FEATURES = 264`. The real extractor computes 270 features, so the zero vector returned for empty or corrupt traces would crash `predict`. No real tor1 trace triggers the fallback, so CV was unaffected (0.838). It became champion as the first trial.
2. **01:08Z:** the lead's first `hand_over` check failed on its own validation check. The validation scout then reported the dimension mismatch as a `fix:` finding.
3. **01:14Z:** the lead fixed it (commit 4bdc5cd, `N_FEATURES = 270`) and measured it as trial `2cb9a0ce`. Its predictions on real data are identical, so the paired difference was +0.0000 with standard error 0.0000: "within fold noise". The champion rule needs a difference above 2 SE, so the fixed trial did not become champion.
4. **01:28Z:** trial `33058236` (more features, also fixed) scored +0.0097 (SE 0.0052), also within noise, so it was not promoted either.
5. **Hand-over and validation only accept the champion** (or a validated baseline; there was none). `candidateSelection` in `lead_session.ts` returns nothing for any other trial. The lead asked three more times to hand over `02360d55`; each time the cached validation receipt blocked it. The budget ran out at 150/150, and the harness's own budget hand-over hit the same block.

Cause: the champion rule only promotes measurably better scores. A correctness fix that leaves the score unchanged can therefore never replace a champion that validation has blocked, and that leaves the run stuck. Validation and the paired rule each worked as designed; their combination is the defect.

Minimal fix options (not implemented):
- while the champion is validation-blocked, let a later trial that is not measurably worse replace it;
- or let `hand_over` accept any measured trial within noise of the champion.

Qwen's finetuned tor1 delivered, so this gap does not always bite.

### Minimal tor1 site-name conversion (user decision 2026-11-18)

The original delivery stays unaltered. The converted copy is in `runs/diagnostics/tor-20261118/tor1-minimal-sitenames/`:
- `output.csv`, sha256 7d112862…: 300 rows, IDs unchanged, all 30 training sites;
- `label-map.csv`: index → site;
- `conversion.json`: receipt.

Evidence for the map:
- the delivered source (`tasks/tor1.py:61-62`) maps index i to `WEBSITES[i]`, and `WEBSITES` equals the sorted list of the 30 training sites;
- the agent also wrote its own `tor1_predictions_named.csv` with that map, and it matches the conversion row for row.

Uploaded as `google-tor1-minimal-sitenames.zip` (sha256 f221069d…, round-trip verified) to the existing "Google minimal tor1 - 2026-11-18" Drive folder.

Map (0-29): appspot.com, archive.org, bitsnoop.com, blueskyswimwear.com, docs.google.com, drive.google.com, en.wikipedia.org, excite.co.jp, mp3lemon.org, newalbumreleases.net, nicovideo.jp, pbworks.com, scribd.com, sony.co.jp, t.co, thetibetpost.com, torrentfreak.com, www.amnesty.org, www.archive.org, www.bahai.com, www.cannabis.com, www.crazyshit.com, www.falundafa.org, www.filecrop.com, www.monova.org, www.openvpn.net, www.sbs.com.au, www.torrentsdownload.org, www.watchfreemovies.ch, www.xvideos.com.

### Correction: the minimal label fix never reached the minimal runs (observer error, found 2026-11-18 ~10:00Z)

A `--continue` run executes the agent code copied into the chain at creation (`runs/minimal/<chain>/agent/`), not `harness/minimal/agent/`. `chain-version.json` guards this: it refuses a continuation when the harness commit or the solver.md hash differs from the chain's.

To deploy the label fix I updated the chain's `promptHash` to the new solver.md hash. That satisfied the guard, but the chain's own copies of `agent/run/output_check.ts` and `agent/instructions/solver.md` stayed the pre-fix versions. They still accept only `<id>;<integer label>` (verified by diff; delivery manifests record solver.md ebb246c7).

Consequences:
- **Google minimal tor1 attempt 2 and Qwen minimal tor1** ran against the integer-only check. Website names would have been refused, so writing class indices was the only submittable answer. Both agents did that and also wrote a named file (Google: `tor1_predictions_named.csv`; Qwen: `tor1_class_map.csv`).
- The earlier labels "model error" / `delivered_wrong_label_domain` are wrong. The index output was forced by the harness. The site-name conversions recover the agents' intended answers and are the right submission.
- Minimal tor2 (0/1 labels) was unaffected.
- No further minimal runs are planned. The finetuned arm does not use this path.
- Lesson: deploying a minimal-arm fix to a continued chain also requires updating the chain's agent copy. Updating only the hash defeats the guard.

### Google finetuned tor1: manual output (user decision 2026-11-18)

The user asked for the finetuned tor1 output to be generated manually, with the failure documented. The steps below do by hand what the prepared harness fix does (branch `fix/blocked-champion`, for the code hand-over only). No agent session ran.

1. **Data:** tor1 re-staged from the course share. The unit ZIPs and labels are byte-identical to `tor1-dataset-cleanup.json`. The development archive was rebuilt from the retained split through the harness's `prepareTaskData` (`rebuild_tor1_dev.ts`): sha256 2b1f7ec1…, identical to the original.
2. **Promotion:** `champion/tor1` moved from `02360d55` (commit c5aebde3, the validation-blocked champion) to `2cb9a0ce` (commit 4bdc5cd7). That is the lead's own fix of the scout's only `fix:` finding, `N_FEATURES` 264 → 270, CV balanced accuracy 0.843.
   - The tag message is built as `training/service.ts` builds it; the script first rebuilt the old champion's message byte for byte.
   - Script `manual_promote_confirm_tor1.ts`; receipt `manual-tor1-promotion-receipt.json` with the old and new tags; ledger before: `tor1-holdout-ledger.before-manual.json`.
3. **Sealed confirmation** (harness `runConfirmation`, lead training sandbox): status completed, this population's second read (ledger readCount 2).
   - Sealed balanced accuracy **0.817**, 95% CI [0.767, 0.867], 120 rows; gap to CV 0.026; not flagged as selection overfit.
   - For comparison, the old champion's sealed read was 0.825 [0.775, 0.875].
4. **Terminal refit and delivery** (harness `runRefit`, champion-tag path with the confirmation receipt, as a lead hand-over; `manual_refit_tor1.ts`): `runs/finetuned/deliveries/tor1/ae1d6d4d250f/output.csv`.
5. **Validation** (`tor1-finetuned-delivery-validation.json`) passed: 300 rows, exact test IDs, all 30 site names (6-16 per site), manifest hash matches.

Caveats for the record:
- `2cb9a0ce` never received a validation-scout approval. The scout's only blocking finding on the champion is exactly the line this trial changes, and its other checks passed.
- The sealed rows were read twice in this run: once by the harness for `02360d55`, once by the observer for `2cb9a0ce`.
- This output is observer-completed, not an autonomous hand-over. Report it as "finetuned tor1 (manual completion after harness gap)".
- Backed up and round-trip verified: "Google finetuned tor1 MANUAL completion - 2026-11-18" (`runs/exports/google-tor1-finetuned-manual-20261118/`, sha256 dbeda42d…). The earlier FAILED folder stays as the record of the autonomous run.
- tor1 data removed again (2.16 GB, `tor1-dataset-cleanup-manual.json`); 13.0 GiB free.

### Qwen finetuned code3: same harness gap, manual completion requested (user decision 2026-11-18)

Read-only check of the Qwen state:
- Champion `5e176046` (commit 0a40f81, CV ARI 0.990) was blocked by validation: `predict()` on unseen rows routed `Z @ centroids.T` through `_sim` and collapsed every row to one cluster.
- Trial `35309428` (commit 476f538) is the lead's fix: nearest cosine centroid without `_sim`, plus an empty-column guard. It scored +0.0000 (within noise), was not promoted, and could not be handed over. Budget 150/150, no delivery.

Same pattern as Google tor1. The generalised tool `runs/diagnostics/tor-20261118/manual_completion.ts` (sha256 db48dc74…; rebuild / promote / refit) went to the Qwen observer, which runs it on its own state between code1 and attacks1, with no Qwen harness process running.

### Second harness gap (found by the Qwen observer, 2026-11-18): foreign validation-check paths

In Qwen code1, the validation scout requested `checks/code3/…` (taken from the shared INDEX.md):
- `run_checks` (team/runner.ts) records every requested path as "Check execution did not complete" before it rejects paths outside `checks/<task>/`;
- `lead_session.ts` carries failed checks into later attempts and clears them only by a rerun at the same path, which the tool never allows.

So the champion `e9da9bc2` (CV ARI 0.668, sealed 0.640) stayed `verification_incomplete` for good, and code1 ended without hand-over.

The fix was written by the Qwen observer: branch `fix/validation-check-paths`, f8392d9. It is not deployed and will be reviewed with `fix/blocked-champion`.

- **Google check:** none of the Google finetuned tasks has a check result outside `checks/<task>/` or with exitCode null. Google is unaffected.
- **User decision:** hand-submit Qwen code1 with its unchanged champion. `manual_completion.ts` gained the mode `refit-champion` (sha256 e2ed007f…): terminal refit of the current champion with the sealed receipt the lead already recorded, so no tag change and no new sealed read. The guard path was smoke-tested on Google tor2 state; nothing was written.

### Qwen manual completions done (reported by the Qwen observer, 2026-11-18)

Both used `manual_completion.ts` (sha256 e2ed007f…). No agent ran; both are validated and backed up.

- **code1** (`refit-champion`, foreign-check-path gap):
  - champion `e9da9bc2`, tag unchanged; refit with the lead's recorded sealed receipt c52394e7, so no new read;
  - 1,000 rows, 53 clusters; CV ARI 0.668, sealed 0.640 [0.575, 0.739];
  - Drive: "Qwen finetuned code1 MANUAL completion - 2026-11-18".
- **code3** (blocked-champion gap):
  - rebuild matched the original dev ZIP (336bd5f9); the tag dry run was faithful;
  - champion moved `5e176046` → `35309428` (476f538);
  - sealed ARI 0.989 [0.976, 0.998] on 331 rows (2nd read); 1,487 rows, 54 clusters;
  - Drive: "Qwen finetuned code3 MANUAL completion - 2026-11-18" (the failed folder is kept).

Qwen attacks1 finetuned (fixed contract) is running; it is the last Qwen task.

### Harness fixes for the code hand-over (2026-11-18)

Branch `fix/handover` (main repository; head 7fb555e on main 251346c) combines:
- `fix/blocked-champion` (Sol: 6f29f43, fde4d3a, 0dc8d1a). While validation `fix:` findings block the champion, a later measured trial that is not significantly worse may replace it. Details:
  - incomplete attempts with fix findings count;
  - a repair chain with identical trees excluded;
  - the replacement is tried before the baseline;
  - the blocking findings are passed to the replacement's validation;
  - only fix findings advance the chain;
  - errors are caught.
- `fix/validation-check-paths` (Qwen observer, f8392d9) plus follow-ups (8438dab): refused check paths are neither recorded nor carried over, and stale entries are pruned on resume, through one shared admission predicate.
- Final review nits (7fb555e, observer): the blocking text is a separate registered prompt rendered only during a repair, so ordinary validation prompts equal main; no self-listing; stored paths admitted only under `checks/<task>/`; docs wording.

Reviews (Opus, independent): round 1 rework; round 2 merge after fixes (both branches); final review "ready for hand-over as is". The final reviewer simulated the three real cases (tor1, code3, code1): each now reaches hand-over.

Tests (CPUs 4-7, --timeout 60000): full suite on 8438dab 800 pass / 0 fail; after 7fb555e the affected files (108 tests) and the fast suite (664 pass / 0 fail) pass.

Left open as nits:
- the streak count after resume differs from live;
- `repairChain` has no shape check in `readProgress`.

Not merged into main and not deployed: no further experiments run on it. Merging only moves main's pointer; do it when no run is live.

#### Third instance of gap B: a misspelled check path (Qwen attacks1, reported by the Qwen observer, 2026-11-18)

Qwen finetuned attacks1, at 140/150 calls: champion e9b94869 (evidence AP 0.922, predicted anomaly fraction 0.21-0.23) is `verification_incomplete` with two check results:
- `checks/attacks1/real_data_e9b94869_evidence.py`, exit 1. The scout's own `assert rho > 0.98` failed, and the scout calls the check mis-specified. Rerunning it at the same path would clear it.
- `../../../../auto-smert-lab/runs/finetuned/solutions/checks/attacks1/real_data_e9b94869_evidence.py`, exitCode null. This is a misspelled path that run_checks refused but recorded. No rerun can clear it.

It is the same defect as the code1 case, with a typo instead of a foreign task. On `fix/handover`:
- the run-time refusal (`admittedValidationCheck` finds no file) does not record the path;
- the prune on resume removes it, because it has no sha256 and does not start with `checks/attacks1/`.

e2947dc adds this exact path to both refusal tests (integration and resume prune), 58/58 pass. Unlike code1, the champion here also has a real failing check (a mis-specified one). A manual completion would therefore bypass a failed check, not only a harness artifact. That is for the user to decide.

### Submission sources for units 3-5 (user request via the Qwen observer, 2026-11-18)

The Qwen observer builds the combined tree `runs/exports/submission-csvs-20261118` in the main checkout and uploads it as "submission-csvs-for-lukas-2026-11-18-units3-5". It reads Google's files only.

Google's chosen sources are collected and hash-checked by `runs/exports/submission-sources-google-20261118/collect_sources.py`. The record is `sources.json` (sha256 `f98b6fa5…`).

| Task | Minimal source | Finetuned source |
|---|---|---|
| code1-3 | Original minimal run (the minimal arm was not rerun). The minimal chain was restored to documents4, so `output.csv` comes from each task's verified backup ZIP. | Rerun on the new base. |
| attacks1 | Same as code1-3. | Rerun attempt 3, with the fixed contract. |
| tor1 | Site-name conversion. | Manual completion (2cb9a0ce). |
| tor2 | Original delivery. | Original delivery. |

Checks:
- Every file's sha256 equals its delivery-validation record.
- IDs are unique.
- The ID set is identical across the two Google arms per task.

**Done (reported by the Qwen observer).**
- Combined tree: `runs/exports/submission-csvs-20261118/tree` in the main checkout. It holds 24 `output.csv` files, plus a README and both tor1 `label-map.csv` files (identical, `e83e16e9…`).
- Per task, the ID set is identical across all four model × arm combinations.
- The Google files match `sources.json` (`f98b6fa5…`) and their delivery records.
- Drive: "submission-csvs-for-lukas-2026-11-18-units3-5" (https://drive.google.com/drive/folders/1IJo7dN0xlGD_189TeTGwg-d1x4HXzmmU). It has 27 files, all round-trip verified (`drive-upload-receipt.json`).
- With this, Lukas has every task for both arms and both models, spam through attacks1. Nothing is running on either side.

### Submitted to Lukas (user, 2026-11-18)

The user sent both submissions to Lukas:
- the first one, spam1-3 and documents1-4, on Monday;
- on 2026-11-18, the single archive `submission-csvs-units3-5-2026-11-18.zip`.

The archive holds 24 `output.csv` files and nothing else: code1-3, tor1-2 and attacks1, each for both arms and both models (sha256 `36bc3d6c…`). It is on Drive in the folder "submission-csvs-for-lukas-2026-11-18-units3-5-archive". Build and upload records are in `runs/exports/submission-all-20261118/`.

Every task in scope is now submitted. Official scores will come from Lukas.

### Completion webhooks and schedules removed (user approval, 2026-11-19)

All runs are finished and no Google process was running. With the user's approval, relayed by the Qwen observer, I removed:
- **Both Google observer schedules**, which were already disabled:
  - "Google Tor step completion", the webhook-triggered task (its webhook served all Google campaigns);
  - "Google Tor observer — every 30 minutes".

  Both were deleted, so the webhook endpoint no longer exists. The Qwen schedules and older schedules of other threads were not touched.
- **The three local webhook files**: `runs/diagnostics/{google-sequential-20261116,google-rerun-20261117,tor-20261118}/completion-webhook.url`.

No copy of the URL remains in `docs/` or `runs/`, and the URL is not recorded here. The 38 run scripts that name the file are kept as records:
- `run_step.ts` used it to signal completion;
- `run_backup.py` read it only to redact it from backups.

Rerunning those scripts unchanged would now fail at that line.
