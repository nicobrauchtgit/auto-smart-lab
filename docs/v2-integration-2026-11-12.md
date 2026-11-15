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

## D integration, 2026-11-12

D integrated into canonical `v2-clean-slate` with
`git -c commit.gpgsign=false merge --no-edit b38a1532aa5bbe88a25f6405a7413d6432168520`.
This was a fast-forward to `b38a1532aa5bbe88a25f6405a7413d6432168520`,
preserving D's complete history and existing worktree. Final D code is
`cd452ffede8affca75aee2f187e699d990e8b34e`. The parent reports a fresh
independent blocking re-review CLEAR, with 119 focused tests passing, covering
source/materialized preflight separation, the real SDK sequential handover
barrier and recovered completion/champion reconciliation. That clearance
supersedes the pending-review statements in the historical D handoff.
No additional review or child agent was commissioned here. D's pre-existing
dirty `harness/finetuned/agent/runtime/python/changes.jsonl` remains in its
worktree, excluded from integration.

Canonical integration validation is in progress: full `./dev bun test`, log
`/tmp/v2-integration-d-full.log`; typecheck and production setup gates follow.
No production run has been launched by this integration step yet.

Canonical suite found a pre-existing parallel-fold fixture race in
`training/validation_measurements.test.ts`: every diagnostic hook overwrote
one shared `.perturbed.zip`. The retained failed result at
`/tmp/validation-measurements-6kjWNi/training/b396291d-2fae-458b-95ff-83637645d9aa/trial-result.json`
records a missing member from another fold's validation population. The
fixture now uses a unique UUID archive per invocation, retaining every
runtime check and assertion. This is a test-only integration fix; no runtime
code or minimal-arm files changed. The initial full attempt was interrupted
with exit 130 after that failure, not counted as green evidence.

Focused `./dev bun test harness/finetuned/agent/training/validation_measurements.test.ts`:
2 pass, 0 fail, 13.31 s (`/tmp/v2-integration-d-diagnostics.log`).
`./dev bun run typecheck`: passed (`/tmp/v2-integration-d-typecheck.log`).
Fresh full-suite log: `/tmp/v2-integration-d-full-final.log` (running).

### Final integrated gate and fresh unit 1 launch

Final tested runtime/test revision: `fb404afd20a1383dd83482639120e95c95185e33`
(D integration plus the test-only ZIP race fix). Fresh canonical
`./dev bun test`: **666 pass, 2 skip, 0 fail**, 668 tests across 91 files,
7,620 assertions, **924.84 s**, exit 0. Log:
`/tmp/v2-integration-d-full-final.log`. Typecheck exit 0 as recorded above.
The two skips are Darwin libproc checks on Linux. No material runtime fix
was needed; the fixture fix does not change the independently reviewed D code.

All authorized production whole-chain setup commands passed, exit 0:

- `./dev bun run experiment -- --arm minimal --check-setup`.
- `./dev bun run experiment -- --arm finetuned spam1 --check-setup`,
  run `c6a34da6-5eb9-48c7-b63b-c7acafb758f3`.
- `./dev bun run experiment -- --arm finetuned spam2 --check-setup`,
  run `c493db36-3383-4030-83ef-42cd106615a3`.
- `./dev bun run experiment -- --arm finetuned spam3 --check-setup`,
  run `919b5d29-d1ae-4066-b408-e6fd0b9154fc`.

Each finetuned command reported success, setup checks passed, no stages
executed, with a Langfuse trace. Logs and exit receipts are copied into
`runs/launches/2026-11-12T02-28-14Z-v2-unit1/preflight-<arm-or-task>.{log,exit}`.
No local prerequisite repair was needed for these integrated gates.

Fresh-run boundary: moved old `spam1/`, `spam2/`, `solutions/`, `knowledge/`
reversibly into
`runs/archives/2026-11-12T02-28-14Z-pre-v2-unit1-finetuned/`.
No destructive reset was used. Existing deliveries and `scout-dry-run/`
remain in place. Both archived linked solutions worktrees were repaired
with `git worktree repair`; original and repaired lists and exact moves are
in the launch directory (`old-worktrees.txt`, `archived-worktrees.txt`,
`archive.json`). All prior run evidence and nested solutions history survive;
no old progress/solutions were reused as new evidence. D's worktree journal
is still excluded and unchanged (SHA-256
`03f471c7afd858dcc5bc231c2708bfd14b40bdd92c15b5ed0978c6ed8e1f299c`).

A detached durable controller started **2026-11-12T02:28:26.307589Z**,
PID/session leader **395189**. Controller files and receipts:

- `runs/launches/2026-11-12T02-28-14Z-v2-unit1/controller.py` and `controller.log`.
- `status.json`: atomic running/queued state, commands, child PIDs, timestamps,
  runtime code SHA, model/config hash and boundaries.
- `launch.json`, `checks.json`, per-task `<arm>-<task>-receipt.json` when a task
  exits, and `exit.json` when the controller exits.

Safe sequential plan: **finetuned spam1 -> spam2 -> spam3, then minimal
spam1 -> spam2 -> spam3**. The host has 6 CPUs and 15 GiB RAM; both arms can
consume all CPUs, and minimal has no finetuned-style memory supervision or
shared cross-arm resource cap. Concurrent arms could oversubscribe the host.
The minimal arm is therefore **queued, no PID or fresh run location yet**;
its eventual fresh location is recorded in `status.json`. This is the
explicitly authorized sequential-arm fallback, not a completed minimal launch.

Finetuned spam1 child command PID **395204**, pipeline process **395313**,
started **2026-11-12T02:28:26.382465Z** with
`./dev bun run experiment -- --arm finetuned spam1`. Log:
`runs/launches/2026-11-12T02-28-14Z-v2-unit1/finetuned-spam1.log`.
Fresh lead run/invocation ID: `19576477-1b60-4fd6-a5e5-57a3455c9331`,
lead started **2026-11-12T02:28:53.152Z**. Its durable progress is
`runs/finetuned/spam1/lead/PROGRESS.json`; training/run roots remain under
`runs/finetuned/`. At resumed handoff inspection around **03:34 UTC**, it was
running with two trials and 66/80 calls used. This is startup/run-state
evidence, not a completed quality result. The controller remained alive.

Finetuned advances only on exit 0, successful pipeline outcome and harness
`handed_over` progress with a delivery. Minimal's existing batch driver can
continue on task failure, so the external controller uses its unchanged
entry points for one task at a time in one fresh jailed run, reusing that
NEW run for spam2/3 with `--reset none`. It advances only after exit 0 and a
`delivered` result with matching task, source archive and output hash. The
first task is launched through `./dev bun run experiment -- --arm minimal
--only spam1`; later tasks use the controller adapter `minimal-task.ts` and
`runMinimal`, preserving the same whole-process jail and shared configuration.
No minimal-arm code or prompts were changed/coached. Any failed gate stops
later tasks and writes failure receipts; no task or stopped old batch is
restarted automatically.

Configured runtime for both arms remains **offline**, MythLLM
`qwen3.8-flash-next-a5b`, shared configuration SHA-256
`93cde05836634967cfdf9b2bc0cec3cba82f2e6181e86ac5fc28e1ab4eb60a17`.
The runtime code SHA captured at launch is `fb404afd20a1383dd83482639120e95c95185e33`.
No uploads, submissions, pushes or code2 launch. No monitoring was scheduled
by this implementation agent; the parent owns the requested 10-minute checks.

### Finetuned terminal failure and independent minimal continuation

The original controller ended **failed**, exit **1**, at
**2026-11-12T04:44:15.783610Z**. Finetuned spam1 exhausted its **80 calls**
with champion validation still blocked by an open defect; it was not handed
over and no later task started. Three harness trials completed; champion
CV was **0.995944**. The first trial took about **8m03s** and passed; the
batch ran about **2h15m** before the failed handover. Those measurements do
not establish a validated delivery or instructor score.

The parent's concrete log/PROGRESS/findings inspection reported a **static
code finding**: `lib/emails.py` silently substitutes empty bytes when reads
fail. The scout's targeted I/O probe **failed to import `lib`**, so that probe
did not demonstrate the faulty read behavior dynamically. Preserve that
evidence distinction. There was no machine-risk stop; the original controller
and finetuned processes had exited before minimal started. The failed status,
exit and task receipts, solutions, findings and worktree journals remain
unchanged. No finetuned restart, repair, validation bypass or spam2/3 launch
was performed.

The independently authorized minimal unit 1 batch started detached at
**2026-11-12T04:48:16Z**, controller PID/session leader **471526**. Its plan
is **minimal spam1 -> spam2 -> spam3**, stopping on any failed delivery gate.
The fresh run location is `runs/minimal/2026-11-12T04-48-17/`.
The first command uses the standard experiment entry; subsequent tasks use
an unchanged copy of the original `minimal-task.ts` adapter calling
`runMinimal` with `--reset none` in that same new run. The whole arm process
remains jailed; no finetuned code or findings are passed to it. There are no
minimal-arm code, prompt or coaching changes.

Launch directory:
`runs/launches/2026-11-12T04-47-34Z-v2-unit1-minimal/`.
It contains `controller.py`, `minimal-task.ts`, `metadata.json`, `launch.json`,
`preflight.json`, `preflight-minimal.log`, atomic `status.json`,
`controller.log`, and `minimal-spam1.log` (later task logs when started).
Per-task `minimal-<task>-receipt.json` and final `exit.json` are written on
completion. Metadata links the original failed batch and records hashes of
its original files. The only addition in the original launch folder is
`minimal-continuation.json`, pointing the parent's monitor to this launch.
No run-state file is tracked in git.

Advancement requires process exit 0, a `delivered` summary row for the selected
task with exit 0, matching manifest task, a source archive, and matching output
SHA-256, as in the original controller. The controller also rejects changes
to the shared configuration before starting any task. Runtime remains offline
MythLLM `qwen3.8-flash-next-a5b`, configuration SHA-256
`93cde05836634967cfdf9b2bc0cec3cba82f2e6181e86ac5fc28e1ab4eb60a17`.
Code SHA at this launch: `496263a0e1fda1b54c2610a3dfcd2cf2d762e3be`.

Bounded preflight (`./dev bun run experiment -- --arm minimal --check-setup`,
60-second limit) passed, exit 0. Boundary verification
`./dev bun test experiment/minimal.test.ts`: **15 pass, 0 fail**.
Initial observation confirmed controller session detachment, fresh run creation,
spam1 session start, configured model resolution, and first tool calls. This
is startup evidence only; no minimal task completion is claimed. The parent
retains its existing 10-minute monitor, schedule
`scheduled-task:9dcf8a4c-b341-4f8d-90b4-04ddac5479fd`; this implementation
agent created no schedule and did not wait for modeling results. No uploads,
pushes, model substitution or withheld-label inspection occurred.

Development check `./dev bun run test:fast` encountered a state-dependent
failure at `harness/finetuned/agent/pipeline/run_pipeline.test.ts:288`:
`fresh pipeline and standalone check-setup pass scout source checks before
TaskData exists` expects `readTaskData('spam1')` to be undefined, but the
preserved measured spam1 run already has TaskData. The suite was interrupted
after that recorded failure (exit 130); it is not green evidence. Log:
`/tmp/minimal-continuation-test-fast.log`. No run data was removed or tests
changed to satisfy that assumption. Minimal preflight and the 15 boundary
tests passed independently, as recorded above.
