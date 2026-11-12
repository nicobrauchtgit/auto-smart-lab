# Lead execution

`lead_session.ts` is the finetuned entry point. `pipeline/stages/lead.ts`
uses the shared executor, preflight and Langfuse reporter. `lead-stage` runs
that same path standalone. The lead controls harness trials (`trial_smoke`
included), asynchronous scouts and supervised shell tools. Scout requests return
a consultation ID immediately; final-bullet inbox news wakes the lead. Pending
consultations keep an idle lead waiting and are cancelled on finalized hand-over
or session end (including budget exhaustion). Synchronous hand-over validation
bypasses the background session cap. Pending consultations are not recovered
after a process restart; durable findings and call counts remain. Terminal refit runs
inside the lead stage after validation; standalone refit remains registered.
The solve stage and solve CLI are retired.

Task text includes the unit introduction through TaskData. Module prompts
live in the prompt registry; `prompts/lead.ts` assembles the opening. Automatic
repository/ancestor context stays disabled in the shared resource loader.
Scouts keep their own sessions and return only sourced final bullets.

The controller stores `runs/finetuned/<task>/lead/PROGRESS.json` outside writable
agent mounts. It retains the original run/training root, dataset identity,
trials/hypotheses, champion, released Ladder feedback, session identities and
budget. Default lead budget is 80 calls. Each admission persists before tool
execution, including rejected/unknown tool calls; replacement sessions keep
the same budget object. Compaction receives fresh progress with the existing
findings journal and solutions history available through scouts and tools.
Interrupted processes resume the recorded training service, whose recovery
preserves trial budget units and completed folds. Progress is fail-closed on
corruption, wrong task or changed dataset. Recovery reads A's protected
`.supervision` receipts and refuses legacy worker-writable recovery files.

Trial completion delivers per-fold scores/spread, the paired noise verdict,
champion, cost, non-improvement streak and budget. Healthy trial progress
causes no push. New champions receive only the confirmation service's Ladder
release (rounded score when significant); private holdout artifacts are never
mounted for lead/scouts. Every query is recorded by confirmation.

`hand_over({reason, finalize?: boolean})` defaults to a nonterminal readiness
checkpoint. It reuses the existing completed eligible champion measurement and
verified immutable trial snapshot: it creates no trial, charges no trial unit,
queries no Ladder and performs no terminal refit. The exact `hand_over` control
call is free for the lead, including at its call limit; ordinary scouts keep
their budgets. Unknown tools and malformed other calls still count.

The first completed validation with labelled `ok`/`advice` evidence and no `fix`
records the working baseline's experiment, commit and validation receipt in
PROGRESS, emits `lead_baseline_validated`, and changes the goal from baseline
to improvement. The same lead session continues. Later candidates use existing
promotion rules; failed challengers never erase baseline evidence. Resume and
compaction convey phase, baseline and current champion without scout transcripts
or private sealed scores. A checkpoint is not a delivered or submitted result.

Validation receipts persist by experiment/source/tree, development data,
validation prompt snapshot, execution boundary and task-check content hashes.
Completed defects also persist until that identity changes; unavailable,
failed, stopped and empty validation can retry. Repeated unchanged successful
checkpoints reuse the receipt, including across restart, without another scout.
Every request still verifies eligible measurement and snapshot identity before
using a receipt; a missing snapshot is never permanently cached as unavailable.

`hand_over({reason, finalize: true})` validates by the same path, then ends tool
use (including later mutations in a real parallel batch). Only after the session
ends does the harness run deterministic all-training-data refit and test
prediction. Budget/idle/session-failure end also waits for trials and uses the
same evidence gate. Unresolved defects never receive an override. Cancellation
retains progress; delivered success still requires final refit artifact gates.

Correction to the earlier label-safety claim: refit does not inherently expose
labels to an agent. Safety depends on actual artifact and access boundaries.
This checkpoint changes neither training populations nor withheld-label
visibility; it needs no baseline refit. Terminal refit uses all training rows,
never test labels, under the existing controller boundaries.

Limits: no paid task run has exercised this checkpoint revision. Earlier v2
baseline runs failed their delivery/time gates; their evidence remains in
`docs/experiments/v2-unit1-2026-11-12.md`. This revision's wall-time/accuracy
targets are unmeasured. Validation detects only defects it observes; a completed scout
is not proof of model correctness. Clustering
confirmation and label-free hand-over retain the P7c limitations. Host shells
and terminal refit retain the documented privileges; filesystem isolation is
not a network policy. PROGRESS is the lead's durable trial summary; measured
trial results are not automatically appended as result-kind findings yet.

## Isolated development checks (2026-11-12)

On base `81a9a44`, full `./dev bun test` completed with 672 passed,
2 existing libproc skips, no failures (91 files, 919.93 s). It started before
final receipt-identity hardening and the extra unmeasured-champion regression;
final focused checks and the fast suite cover those changes. Run the full
suite again on the reviewed merge candidate before merging. Final isolated
`./dev bun run test:fast`: 546 passed, 2 skipped, no failures (72 files,
105.95 s). Final lead regressions: 15 passed, no failures. The separate
prompt/session-resource/experiment-boundary check passed 140 tests with
2 existing skips.

Focused checks include real Pi parallel checkpoint/finalization at the 80-call
limit, reused call IDs, transient validation retry, persistent baseline phase,
no checkpoint Ladder queries/refit, frozen-source access through symlinked
state, sealed/live-state exclusion, prompt isolation and experiment boundaries.
Typecheck and whitespace checks pass. No paid task trial or upload was run;
model-quality and P7c limits above remain. Initial environment-preparation
failures were superseded after repairing the private Python snapshot; one
concurrent fast rerun hit an existing five-second git-test timeout.

Local test logs are under `/dev/shm/t3-a3e7e840/`; toolchain, Node and Python
copies are private to this worktree, with course files copied and individual
unit directories linked and used only as read-only test inputs. No canonical dependencies or
prior trial evidence were changed. Generated Python manager audit records are
excluded from the commit.

Independent review of `1d3ff9b` found a blocking free-call admission bypass:
a malformed hand_over rejected by Pi could donate its unused admission to a
different tool with the same call ID. Admissions now bind both the ID and
tool name. Real Pi parallel/sequential regressions cover rejection followed
by a blocked mutation and a valid free checkpoint. Parent's focused budget
and lead tests pass 28/28; the independent repro now reports zero mutations
at 80/80 on both SDK paths. Typecheck and whitespace checks pass.

The review's full suite on `1d3ff9b` had 668 pass, 2 skip, 5 disk-prerequisite
failures; rerunning affected files with RAM-backed TMPDIR passed 7/7. This is
not a green full-suite result. Fresh independent review and a serial full
suite with private TMPDIR remain required on the admission-fix commit before
integration. No paid run or merge has followed these fixes.

Final independent re-review of `8c66442a17b1463296909013ae774278ee715e27`
found no blockers. On that exact revision, a serial full suite using private
RAM-backed TMPDIR passed **675 tests, 2 existing libproc skips, zero failures**
across 91 files in 890.01 seconds; no reruns were needed. Typecheck and diff
checks passed. The original real-SDK bypass probe reports zero mutations in
both modes at 80/80. Logs remain under
`/dev/shm/t3-a3e7e840/review-8c66442-v135Cb/` and are volatile across reboot.

After that review and green full suite, canonical `v2-clean-slate` was
fast-forwarded unsigned from `81a9a44` to `8c66442` on 2026-11-12. This
supersedes the earlier pending-review/full-suite statements above. No paid
task run, upload or push followed integration; the checkpoint workflow's
model behavior and latency remain unmeasured.
