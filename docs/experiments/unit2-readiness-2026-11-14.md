# Unit 2 readiness and proposed cleanup, 2026-11-14

Requested scope: assess the second unit on both arms, running one arm at a time,
and report preparation and proposed deletions before applying them. No model
experiment, dataset download, deletion, task registration or runtime change was
authorized by this assessment or performed. One `--help` invocation unexpectedly
created an unused minimal workspace/venv, described below; no agent session ran.

## Finding

**Not ready to launch Unit 2 yet.** It is Malicious Code in Documents:

- `documents1`: DOCX, 35 points.
- `documents2`: PDF, 35 points.
- `documents3`: RTF, 30 points.
- `documents4`: mixed-format bonus, 20 points.

The task IDs/order come from archived local metadata. The live `units/` tree has
no documents unit, and `units/index.json` has only spam IDs. Archived task pages
are empty submission-form shells, not complete task instructions. The archived
unit introduction supplies summaries, training semantics (0 benign, 1 malicious)
and the prohibition on external detection services. Reconstruct only factual
task/protocol information, excluding obsolete VM credentials and page navigation;
confirm prediction IDs/format and distinguish a chosen development metric from an
unverified official metric. Supply any new course resources equally to both arms.

The course-share password was supplied securely and read-only WebDAV access was
verified on 2026-11-15 (local date). The live `02-maldoc` listing contains eight
encrypted archives totaling **4,192,156,084 bytes**, with DOCX train/test totaling
1,303,997,448 bytes. The mixed training ciphertext is only 346 bytes; the older
inventory described empty training, but its contents still require decryption
to confirm. Receipt: `runs/diagnostics/unit2-share-inventory-20261114T232757Z.json`.
No sample files were downloaded. Password values were neither logged nor added
to the project; the document-archive decryption passphrase is still outstanding.

## Actual checks and preparation needed

`./dev bun run experiment -- --arm minimal --check-setup` passed its existing
local setup checks. That check verifies tools, packages, sandbox availability and
provider configuration/key presence; it does not prove Unit 2 data readiness or
issue a live model request.

`./dev bun run experiment -- --arm finetuned --no-fetch --check-setup documents1`
failed at task resolution: no local documents1 task. This is a concrete missing
input, before any agent/model session. Finetuned's task declarations currently
cover only spam1–3; its binary-classification primitive exists and does not need
a new model-design abstraction for DOCX/PDF/RTF.

Before launching:

1. Share access and current file sizes are verified. Securely obtain the
   document-archive decryption passphrase and establish downloaded input hashes.
2. Stage/decrypt the first format on disk without retaining unnecessary
   encrypted and decrypted duplicates or extracting the whole corpus. `gpg` is
   currently unavailable and needs an approved project-local execution path.
   `zip`/`unzip` are available through `./dev`; the first check outside that
   environment would misleadingly report them missing.
3. Inspect archive integrity, directory structure, expanded sizes, training
   label encoding/coverage and test IDs using static reads. Do not execute
   samples or open them with Office/PDF applications; the documents are real
   malicious samples. No external scanner/upload service is permitted by the
   supplied unit instructions.
4. Add shared local prompts, unit/task metadata and task index entries; give the
   unit an explicit number/slug and tasks an explicit order. Keep modeling advice
   out of minimal. Register matching factual finetuned task declarations with
   train/test paths, binary labels, inductive execution, split, development
   metric and output contract. Validate these before starting an agent.
5. Resolve the mixed bonus separately: the last inventory says its training
   archive is empty. Establish whether/how earlier-format training inputs and
   detectors are reused, rather than inventing a normal empty-data supervised
   run. Start with the three standalone formats if this remains unresolved.
6. Establish the malware parsing and network policy. Existing bubblewrap tools
   isolate filesystem/user/PID access but deliberately use `--share-net`; this
   is not a network-isolated malware detonation environment. The runtime needs
   a verified static-analysis boundary, not an assumption that mounting files
   read-only prevents execution or exfiltration.
7. Run task-specific setup for each arm, then use the same hashed task inputs
   and configured offline MythLLM model, sequentially with no overlap. Record
   the reset/reuse protocol. **Decision on 2026-11-15:** retain each arm's own
   generated Python source across units, without carrying old task state or
   sharing between arms. Minimal uses
   `--source-from runs/minimal/2026-11-11T08-29-56`; its setup check accepts the
   three prior spam modules. Finetuned keeps `runs/finetuned/solutions/`, including
   its reused raw-sample reader. Preserve existing run evidence; no reset or
   deletion is needed. See the source-continuation contract in `docs/experiment.md`.

A shared model/telemetry-only production preflight using existing spam3 **passed**:
pipeline `64cf0434-5caf-489c-9ab1-3e182843d614`, setup checks passed, no stages
executed. Its log is in the timestamped `unit2-readiness` launch folder.
This result must not be substituted for a documents-task preflight.

## Space and backups

At audit start: approximately **7.4 GiB disk free**, **14 GiB RAM available**,
with no pipeline/agent run active. The current Drive backup was fetched again
and its SHA-256 reverified successfully. It includes the six saved finetuned
deliveries and experiment reports, **not** minimal exports or raw run histories.

The two local exported/restored ZIP copies occupy only **2,056,890 bytes**.
Deleting them will not create meaningful room for a multi-gigabyte documents
unit. Even sequential arms need shared input archives plus finetuned's copied
development ZIP, model/output/scratch space and a reserve. Encrypted transfer
sizes alone do not establish the peak disk or memory requirement. Prefer one
document format at a time, shared by the two sequential arm runs; compute the
actual peak after archive inventory. Do not approve staging the entire unit on
the current free-space figure alone.

## Proposed deletions — none applied

1. Backed-up ZIP:
   `runs/exports/2026-11-14T18-54-11Z-experiment-results/experiment-results.zip`
   (1,028,445 bytes).
2. Verified download duplicate:
   `runs/exports/2026-11-14T18-54-11Z-experiment-results/restore-check/experiment-results.zip`
   (1,028,445 bytes).
3. Redownloadable CLI installer archives, preserving the installed CLI,
   credentials, installation receipt and backup receipts:
   `.tools/downloads/google-cloud-cli-593.0.0-linux-x86_64.tar.gz`
   (94,726,966 bytes) and
   `.tools/downloads/google-cloud-cli-linux-x86_64.tar.gz`
   (94,726,958 bytes).
4. The unused workspace created by `minimal --help`:
   `runs/minimal/2026-11-14T20-00-00/`. The wrapper prepares a run and venv before
   forwarding `--help`; it printed help and exited without an agent or model
   experiment. Most environment files are hardlinked to caches/other locations;
   apparent size is about 1 GB, but estimated reclaimable file blocks are only
   **8,232,960 bytes**. Check again that it contains no subsequent run evidence
   before deleting it.

Total estimated file-space recovery: about **190.5 MiB**, including installer
archives and the unused workspace, plus minor directory overhead. Only the ZIP
pair itself frees about **1.96 MiB**.

Preserve all original delivery directories/source ZIPs, units' source archives,
historical run archives, scout/lead/training records, journals and
`runtime/python/changes.jsonl`. Keep the minimal-unit1 export ZIPs: they are not
in the verified Drive backup. Do not remove the old minimal run's 495 MB scratch
or environment as if their apparent size were disposable evidence-free space;
broader cleanup needs its own verified backup/inventory first.

No deletions or experiments have been started. After the preparation is agreed,
perform the reviewed cleanup, stage one format, rerun its checks, then launch the
first arm. Do not treat this assessment as a passed multi-task integration gate.
