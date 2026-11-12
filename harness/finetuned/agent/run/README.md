# Lead execution

`lead_session.ts` is the finetuned entry point. `pipeline/stages/lead.ts`
uses the shared executor, preflight and Langfuse reporter. `lead-stage` runs
that same path standalone. The lead controls harness trials (`trial_smoke`
included), blocking scouts and supervised shell tools. Terminal refit runs
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

Limits: no paid v2 task integration gate has run. Wall-time/accuracy targets
are unmeasured. Validation detects only defects it observes; a completed scout
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
