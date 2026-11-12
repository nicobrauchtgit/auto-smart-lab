# Stream D implementation and review handoff, 2026-11-12

D stays on `v2/stream-d-lead`; it is not merged into `v2-clean-slate`.
Independent blocking-only review is still required. This implementation agent
started no subagents, paid task runs, uploads or pushes.

## Preserved history and integration

- `e236f1f`: snapshot of all supplied staged/unstaged D work except the
  setup-generated `harness/finetuned/agent/runtime/python/changes.jsonl`.
- `c4e97af`: merge of committed A (`bd472a4`) into that snapshot. D's old
  solve runner deletion is preserved; A's safe recovery reads and private
  shell-log root were ported into the new lead runner.
- A later passed its fresh full suite and was merged into the parent at
  `28e62adefc75c11c5771390ba89617d362d09eb2`. Its review scope, local setup fix,
  initial fixture race and exact checks are in
  [the A integration record](v2-integration-2026-11-12.md).
- `ce83e62`: merge of parent `53d673d` into D, including A's atomic attack
  fixture fixes. No conflicts or unfinished D changes were discarded.
- `1a2ea79`: lead entry, migration of old solver consumers, durable admission
  accounting and validated handover.
- `c337fcc`, `6e3d0f3`: runtime docs, review gate and corrected next-run scope.
- `d03660f`: prompt explicitly permits local debugging while reserving
  authoritative trial predictions/measurements for the harness.
- `a2b0e3f`: accepted handover revokes later calls already admitted in the
  same model message, with a regression. This is the final code revision.

Local prerequisites in D: existing individual unit directory links were
retained, zip/unzip links point to the working local tools, and spam course
resources are actual untracked copies, never relaxed loader checks. Generated
assets are not committed. `changes.jsonl` remains dirty and is excluded from
all implementation commits in both A and D; the parent checkout is clean.

## Implemented behavior

The finetuned pipeline entry and `lead-stage` standalone command share one
instrumented lead stage and whole-chain preflight, including scouts, training,
confirmation and terminal refit. The old solve stage/CLI/prompts are retired.
The lead gets explicit task text with its unit introduction, harness training
and smoke tools, blocking scouts and supervised bash. Selected instructions
stay in the typed prompt registry; automatic AGENTS/CLAUDE loading remains off.

Default budget is 80 tool calls, with counters on results and a finish turn.
Admission is persisted before execution. PROGRESS retains the original run,
training root and used calls across interruption, and is supplied after
compaction alongside the retained solutions history and scout findings.
Recovery tests cover the same root/budget, protected recovery receipts,
no repeated trial charge, and exclusion of private scout transcript/output.

Trial news includes fold scores/spread, paired noise verdict, champion, cost,
non-improvement streak and calls left. Healthy progress causes no push. Only
the confirmation service's counted Ladder release reaches the lead; raw
holdout records and labels stay outside agent mounts.

`hand_over` validates a measured champion snapshot. Defects, failed/stopped/
empty validation or missing labelled findings block refit, including repeated
requests and budget-end fallback. Budget-end fallback waits for running work,
uses that same validation rule, and invokes deterministic terminal refit.
Success requires refit validation, never merely a finished agent session.

## Checks and review status

Before the final change, focused lead/context/scout checks passed 45 tests;
`/tmp/stream-d-focused-final.log`. The handover admission regression and lead
checks then passed 19 tests; `/tmp/stream-d-handover-final.log`.

Development failures were fixed rather than skipped: old solver callers and
assertions were migrated to lead APIs; a git/training test hit its existing
5 s timeout during concurrent A/full and D/fast testing. Its focused file
passed 8 tests (`/tmp/stream-d-git-focused.log`) and the final suites ran
serially. An earlier full D run was interrupted (exit 130) for `a2b0e3f`,
not counted as full-suite evidence; its log is
`/tmp/stream-d-full-before-handover-fix.log`.

Final checks on code revision `a2b0e3f`:

- `./dev bun run test:fast`: 535 pass, 2 skip, 0 fail; 537 tests across
  72 files, 106.31 s. `/tmp/stream-d-fast-serial-final.log`.
- `./dev bun run typecheck`: passed. `/tmp/stream-d-typecheck-final.log`.
- Full `./dev bun test`: **661 pass, 2 skip, 0 fail**; 663 tests across
  91 files, 907.60 s. `/tmp/stream-d-full-final.log`. The two skips are Darwin
  libproc checks on Linux.
- `git diff --check`: passed. No minimal-arm files were changed by D.

Review status: A's runtime security commits have the independent no-blocker
reviews reported by the parent; D has not had its required independent
blocking-only review. The green checks do not replace that review. This
handoff adds documentation only after testing final code `a2b0e3f`.

## Concrete limits and next action

No paid lead run has exercised the v2 latency, accuracy, reader-reuse or
machine-protection integration targets. Scout validation catches only what
it observes; its verdict cache is process-local, so interruption before
acceptance can repeat validation. Trial summaries are durable in PROGRESS
and authoritative trial records; automatic result-kind findings-journal
appends are not implemented. Clustering sealed confirmation and label-free
handover retain the documented P7c limitations. Supervision's documented
host-shell/refit privileges and Linux/Darwin differences remain.

After independent blocking-only review, merge D and retain the green-suite
gate. The parent's next authorized task is **unit 1 on both harnesses**,
monitored every **10 minutes**. This supersedes the original finetuned-only
immediate gate. No paid runs were started here, and uploads remain unauthorized.

## Blocking-review fixes after `c0b6f5f` (2026-11-12)

The fresh independent blocking review of `c0b6f5f` found three blockers. Code
commit `cd452ffede8affca75aee2f187e699d990e8b34e` addresses them; the earlier
"final code revision" and green-suite claims above are historical evidence,
not review clearance for this revision. D remains unmerged, based on parent
`53d673d`. A fresh independent blocking re-review is still required.

- **P1, fresh preflight:** scout prompt/source checks no longer read persisted
  TaskData before the lead prepares it. They validate the task prompt, nonempty
  unit introduction, journal destination and typed prompt rendering. Whole-chain
  task/archive/dependency checks remain. Lead explicitly declares data-profile
  preparation prerequisites. Every production scout runner now requires explicit
  materialized task/profile paths; a separate `scout-materialized-inputs` check
  validates those after preparation, without reusing the source-check cache ID.
  Regressions exercise local prerequisites on spam1–3, fresh pipeline execution
  and standalone setup-only execution without creating TaskData, plus missing
  profile/introduction/journal failures before a scout session.
- **P1, handover ordering:** `hand_over` declares Pi's `executionMode:
  "sequential"`. In the installed SDK, a sequential tool makes its entire
  assistant-message batch execute in order, including admission hooks. Accepted
  handover therefore clears later admissions before they are consumed. A real
  scripted Pi session uses the actual lead handover tool followed by training
  and file mutation calls: neither later tool executes, refit runs once, all
  three emitted calls stay charged and every result carries the 3-of-80 counter.
- **P2, completed recovery:** harness-training readiness replays finalized,
  nonrunning recovered trials through the completion callback, deduplicating
  equivalent notifications within the owner. Lead persists a feedback receipt
  with each terminal status, waits for recovery feedback before building its
  opening context and reconciles the authoritative champion tag. A later resumed
  trial with a changed status can still produce new feedback. Repeated lead
  resume preserves the call budget, trial row, noise verdict and counted Ladder
  summary without repeated completion news or confirmation. No raw holdout
  score or scout transcript enters that context. A real tiny-training restart
  regression covers terminal discovery, repeated readiness/resume and refusal
  to spend another trial budget unit.

The supplied `/tmp/stream-d-parallel-review.ts` and
`/tmp/stream-d-recovery-review.ts` were inspected. Their failure mechanisms are
covered by repository regressions; the ad hoc parallel fixture itself does not
use the production handover tool and must declare the scheduling barrier to
represent the fixed behavior. No paid runs, real-label probes, uploads, pushes,
merges or child agents were used. The pre-existing dirty Python changes journal
was preserved and excluded from the code commit.

Validation results for this revision are recorded below after serial execution.

Checks on final code `cd452ff` (no concurrent test suites):

- Focused recovery/lead/setup/scout checks initially passed **51 tests** in
  155.52 s (`/tmp/stream-d-blockers-focused.log`). Additional lead and local
  setup checks passed **24 tests** in 4.84 s
  (`/tmp/stream-d-blockers-focused-final.log`); fresh executor/standalone
  preflight checks passed **12 tests** in 789 ms
  (`/tmp/stream-d-blockers-preflight.log`). These focused runs preceded final
  test-only strengthening; the final suites below include all regressions.
- Final `./dev bun run test:fast`: **539 pass, 2 skip, 0 fail**, 541 tests
  across 72 files, 107.25 s (`/tmp/stream-d-blockers-fast-final.log`).
- Then `./dev bun run typecheck`: passed
  (`/tmp/stream-d-blockers-typecheck-final.log`).
- Then full `./dev bun test`: **666 pass, 2 skip, 0 fail**, 668 tests across
  91 files, 918.74 s (`/tmp/stream-d-blockers-full-final.log`). The skips
  are Darwin libproc tests on Linux.
- `git diff --check`: passed. No minimal-arm changes. Only the supplied dirty
  runtime Python journal remains outside the implementation/documentation
  commits.

A development-only test fixture initially threw while constructing the scout
facade, before its intended cancellation assertion; the fixture was corrected
and rerun. An initial fast run also passed (539/2/0, 107.57 s); the final fast
run above follows the last test/interface edits. Neither earlier run replaces
final-suite evidence. Source-preflight integration tests substitute an inert
stage body and scope requirements to local scout checks; they do not claim
live provider/Langfuse access or an end-to-end paid lead run.

**Review status:** all three reported blockers have implementation fixes and
regressions; no fresh independent blocking re-review has run on `cd452ff`.
Parent integration must wait for that re-review. No merge, launch or push was
performed. P7c, missing automatic result-kind findings-journal appends and the
process-local validation verdict cache remain limitations, as do the absence
of paid latency/quality measurements and the existing host/platform boundary
limits documented above.
