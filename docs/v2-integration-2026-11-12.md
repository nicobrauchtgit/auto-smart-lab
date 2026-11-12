# Stream A integration, 2026-11-12

A is integrated into `v2-clean-slate` by unsigned merge
`28e62adefc75c11c5771390ba89617d362d09eb2`, from A head `d8b9035`.
The reviewed security commits are `2f3eced` and `bd472a4`; the parent task
reported independent blocking-only reviews with no blockers. No new review
was commissioned by this implementation agent.

Local setup: replaced only the untracked `resources/01-spam/` PDF/text
symlinks with regular copies from the canonical parent checkout. The loader's
regular-file requirement is unchanged. Unit directory and zip/unzip links
remain local setup, not committed assets. `changes.jsonl` remains uncommitted.

Checks on A:

- `./dev bun test harness/finetuned/agent/context`: 13 pass, 0 fail,
  `/tmp/stream-a-context-fixed.log`.
- First full `./dev bun test`: 671 pass, 2 skip, 1 fail, 954.42 s,
  `/tmp/stream-a-full-fixed.log`. The attack fixture's separate rm/ln commands
  raced a legitimate supervisor state rewrite, producing `ln: File exists`.
- `0d868f3` changes only that fixture to plant symlinks with atomic rename;
  `d8b9035` uses portable `mv -f`. Runtime security checks/assertions stay intact.
  The original runtime security review does not cover these later test-only commits.
- `./dev bun test harness/finetuned/agent/context harness/finetuned/agent/experiments/log_symlinks.test.ts`:
  17 pass, 0 fail, `/tmp/stream-a-focused-final.log`.
- Fresh full `./dev bun test`: **672 pass, 2 skip, 0 fail**, 674 tests across
  94 files, 925.98 s, `/tmp/stream-a-full-final.log`. The two skips are Darwin
  libproc checks on Linux. This green run preceded the parent merge.

Stream D is not merged. Its existing unfinished work was preserved in
`e236f1f` before merging A. Independent blocking-only review must follow D's
implementation and validation. No paid runs or uploads have started. After
reviewed/merged D and a green suite, the parent owns unit 1 on both harnesses,
with monitoring every 10 minutes; this supersedes the immediate finetuned-only gate.
