# Unit 2 DOCX setup, 2026-11-15

DOCX (`documents1`, Unit 2 task 1) is staged for the two sequential offline
arm runs. No experiment, agent session, fitting, prediction, submission or
upload was started. PDF, RTF and the mixed bonus are not staged or registered.
This supersedes the missing-input findings in the
[readiness assessment](unit2-readiness-2026-11-14.md) for DOCX only.

## Inputs and provenance

The password-protected course share's `02-maldoc/` folder supplied
`docx-train.zip.gz.gpg` and `docx-test.zip.gz.gpg`. Read-only HTTPS downloads
verified TLS, refused redirects, and matched the previously inventoried byte
counts and ETags. GPG 2.4.9 was already installed in the Nix store; it ran
through `./dev` with a project-local diagnostic home and no profile install.
Passwords were supplied through private secret files outside runtime mounts.

The first archive passphrase failed with GPG exit 2, `Bad session key`.
The replacement succeeded, reusing the verified encrypted training download.
Decryption streamed through gzip into ZIPs on disk. GPG integrity, gzip decoding
and all ZIP CRC checks passed. Encrypted transfer copies were removed only
after successful validation; no whole-corpus extraction was performed.

| Input | ZIP bytes | Samples | SHA-256 |
| --- | ---: | ---: | --- |
| `docx-train.zip` | 1,032,995,813 | 6,301 | `b754d1f332bed5136ef4174edc6ffeb797b334a28b0a6c9cb63ee6ad9d17d844` |
| `docx-test.zip` | 394,957,208 | 2,969 | `2d14ebee60809b5c0702b256dd47374447477e3aadd51140e5a0947a3515d9dd` |
| `docx-train.labels` | 245,739 | 6,301 records | `e1ef0f29b2b76c718eb1850a5e8ce4d07f638eb9a428b39d8cab573f17f87cea` |

The labels file is an exact copy of the original embedded ZIP member. Its IDs
cover the training samples exactly, and targets agree with the original `.0`
and `.1` suffixes. The training ZIP has 6,302 members including that label file;
the existing sample reader excludes the byte-identical embedded labels member.
All test sample IDs end in neutral `.x`. Inspection found unique, disjoint
train/test IDs and both training classes. Declared-data inspection passed with
6,301 training rows and 2,969 test rows. No document was executed or opened in
an Office/PDF application, and no external detection service was used.

Shared inputs are under
`units/02-maldoc/malicious-code-in-docx-documents/data/`. The unit hash uses the
fetcher's existing sorted-path/NUL/file-SHA-256/NUL algorithm over those three
files. Aggregate `eed2d487c137cd0a769f4ff9c014d255a51e61b2a425aee9cb0165870f8382a9`
is recorded in `unit-data-hashes.json` and local `.data-hash.json`. This is the
currently staged **DOCX subset**, not a claim to have the entire documents unit;
staging another format must extend the inventory and change the aggregate.

## Task material and interface

Shared `unit-intro.md` retains the archived course's educational paragraph,
excluding navigation and obsolete VM credentials. DOCX `meta.json` retains its
original title, URL and short ID, with explicit `unit_slug: 02-maldoc` and
`task_number: 1`. `units/index.json` now includes `documents1`.

The individual archived task page contains no full description. Shared
`prompt.md` explicitly identifies itself as a factual reconstruction from the
unit overview and task metadata. It includes benign/malicious semantics,
malware-handling and external-detector prohibitions, exact archive-member IDs,
and the existing offline `id;prediction`/no-header delivery convention. That ID
convention is supported by the historical minimal Unit 2 record; the unavailable
original task page has not been independently reverified. There are no added
modeling suggestions. Both arms receive the same restored material. No Unit 2
slides were available or invented.

`pipeline.config.json` adds `documents1` using the existing ZIP-member binary
classification primitive: explicit targets, inductive execution, stratified
sealed holdout and deterministic full-training refit. Development balanced
accuracy is a local declared choice, explicitly distinguished in the shared
prompt from the unverified official course metric. No runtime implementation
or minimal solver instruction changed.

## Checks and next execution

- Actual task selection resolves `unit 2 task 1` to `documents1`; its production
  declaration parses and actual input inspection passes.
- Minimal source-continuation setup passed for
  `runs/minimal/2026-11-11T08-29-56`. This static check verifies tools, sandbox,
  configuration/key presence and compatible retained source; it does not probe
  the provider or inspect the task corpus. The controller inspected the shared
  corpus separately as described above.
- Finetuned production `--no-fetch --check-setup documents1` passed, including
  the configured provider and Cloud telemetry probes. Pipeline
  `cf38011f-8808-4a77-b499-a79dc4fafd4a`; [Langfuse trace](https://cloud.langfuse.com/project/cmumh75f5014jad0dx0f2gn0w/traces/7116edc173b9bce4258ba00904727ff9).
  No stages executed and no task runtime workspace was created.
- Focused configuration/task-resolution tests: 13 passed, no failures.
- `./dev bun run test:fast`: 595 passed, 2 platform skips, no failures
  (597 tests, 76 files, 194.83 seconds). Typecheck and whitespace checks passed.
  The full suite was not run; no merge is performed and it remains required
  before merging.

Both planned runs retain their own source as selected in
[the experiment contract](../experiment.md#starting-clean-and-continuing-source).
Minimal will use `--source-from runs/minimal/2026-11-11T08-29-56 --only documents1`;
finetuned retains `runs/finetuned/solutions/` and will select `documents1` with
`--no-fetch`. Shared configuration remains offline MythLLM
`qwen3.8-flash-next-a5b`. No reset, cross-arm source transfer or experiment
launch is part of this setup.

About 6 GiB disk and 14 GiB available RAM remain after staging. Finetuned's
existing preparation guard requires about 2.24 GB free for this training ZIP;
its additional development ZIP is at most approximately 1.03 GB. Sequential
execution fits those preparation estimates while retaining a 2 GiB controller
reserve. Model/scratch growth remains runtime-dependent and must be monitored;
this is not evidence of successful model execution. Existing sandboxes share
host networking and do not provide malware detonation isolation. The staged
task is for static document analysis under the course's handling rules.

All previous runs, deliveries, archives, source and journals remain local.
No previously proposed cleanup was applied. Receipts, bounded download/decode
script, integrity/hashes, failed-passphrase diagnostics and preflight logs are
retained under `runs/diagnostics/unit2-docx-setup-20261115/` and excluded from
Git. Unit data and secret files are also excluded from the commit.
