# DOCX retry with 150 lead calls, 2026-11-15

The user requested one fresh finetuned `documents1` run with a 150-call
allowance, restoring the source baseline from before the first DOCX iteration.
Minimal is not rerun. The completed first iteration remains preserved.

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
Outcome will be recorded after the authorized retry completes.


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
