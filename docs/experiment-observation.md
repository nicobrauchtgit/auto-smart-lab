# Observing-agent experiment protocol

This is the procedure for an observing/coding agent receiving a request such as
"run Unit 2 tasks 1–3 with minimal and finetuned." The observer owns execution
bookkeeping, observation, reports, dataset closeout and its own context lifecycle.
The harness owns agent execution, measurements and artifact validation. These
instructions stay outside the arms' runtime prompts and workspaces.

## Resolve the request once

Before launching, save the request and ordered run list under the series'
existing `runs/launches/<series>/` observation directory. Use `observation.json`
for the ledger and `HANDOFF.md` for a short continuation note. Reuse the same
ledger after interruptions and compaction.

Resolve unit/task numbers through repository task metadata, then record:

- Exact task IDs and requested arms, checkout, configured provider/model and
  online/offline setting. Use the current checkout's configured model unless
  the user names another; do not implicitly run other models or checkouts.
- Source commit and working-tree changes, configuration/prompt hashes and the
  exact command/arguments for each run. Record credential variable names only.
- Each arm's configured budget, seed/fold policy where harness-owned, and
  fresh/continuation state. Agent-designed CV and pipelines remain agent choices.
- Per-run state (`pending`, `running`, `terminal` or `blocked`), run/invocation
  IDs, workspace, logs/trace links, timestamps, actual outcome and report path.
- Cleanup state, restoration references and context-compaction state.

Keep the recorded conditions throughout the batch. Treat user-requested changes
as a recorded protocol revision so results from different conditions stay
identifiable. After an interruption, reconcile existing controllers, run IDs and
logs before launching any pending row; a missing observer update is not evidence
that the experiment never started.

Defaults when the request supplies only units/tasks and arms:

1. Use the requested task order; otherwise use unit/task metadata order.
2. Run one task at a time. Within a task, run minimal then finetuned when both
   are requested. Run sequentially across checkouts/models too.
3. Continue each arm's own source and learning within the experiment series
   identified by the active queue and observation ledger. Minimal uses that
   series' recorded `--continue` run; finetuned retains its own state and solutions.
   With no compatible recorded series, start a new series using the documented
   arm defaults and record its starting state. Do not pick unrelated historical
   runs by timestamp or copy learning between models to manufacture continuity.
4. Use configured budgets and required setup checks. Preserve the declared
   differences between arms. Add no observer-imposed time cutoff, extra attempt,
   model override, reset or configuration change.
5. Complete the requested run list under each arm's configured attempt policy.
   Record task-specific terminal failures and continue the remaining independent
   runs. Stop further launches on user cancellation, a shared prerequisite failure,
   exhausted shared quota/budget or an unresolved controller/machine-protection
   condition. Record every unstarted row and its blocker. Add no ad-hoc retry of
   a failed row. User-specified order, repeat mode, budget and failure policy
   override these defaults and are recorded explicitly.

A new independent repeat requires its own recorded fresh-state policy. Never
copy one arm's learning into the other. Keep each checkout's board and run state
separate. Dataset preparation/readiness belongs to the user or assigned setup
workflow; the observer does not fetch or repair inputs on its own. Required
runtime preflight still runs, and a failure is reported as a blocker.

## Launch and observe

Use the repository's `./dev bun run experiment -- --arm ...` entry points and
the documented continuation arguments in [experiment.md](experiment.md).
Invoke one task per observation step so every task/arm/model execution has a
closeout and compaction boundary. Shared dataset cleanup still waits for the
task's last requested consumer.
Record the command and durable run identity before treating a launch as active.

Read bounded status, progress and telemetry updates. Keep full logs and transcripts
on disk/in Langfuse and retain pointers in context. Monitor the existing controller
and machine-protection outcomes. Observe tool decisions, resource/budget use,
errors, recovery, validation and delivery without steering model design or fixing
the runtime mid-run. Operator questions and interventions require the user's
instruction and must be recorded with their answers/effects.

A finished agent session or exit code alone is not verified delivery. Check the
harness result and artifact records. Keep local diagnostic fits, development CV,
released confirmation feedback, validation and official scores distinct. Record
failed or incomplete verification truthfully. Offline delivery does not authorize
submission. Preserve the arm boundaries throughout observation.

## Write the task report

The observing agent writes or updates `docs/experiments/<task>-<date>.md` after
the requested task executions finish, fail or are stopped. Include the series,
model or attempt in the filename when necessary to avoid overwriting another
observation. The pipeline produces authoritative records and telemetry; these
narrative Markdown reports are observer-authored.

Use [the task-report template](experiments/_template.md) for consistent coverage.

Record the request/conditions, source and configuration identity, arm-specific
continuation state, run IDs/trace links and elapsed time. Describe the observed
decisions, tool/budget use, measured results, actual validation/delivery outcome,
limitations and remaining work. Cite retained receipts/artifacts for claims.
Keep observer inference separate from recorded facts and leave unavailable
scores unknown. Add the report/outcome to the ledger and update the active queue
in `docs/cleanup-plan.md` when it changes the current state.

Write the report and preserve the evidence before cleaning up datasets or
compacting. A terminal failure also receives a report; remaining runs stay pending
or blocked instead of being silently skipped or relaunched.

## Remove task datasets after use

After every requested consumer of the task's data has finished and artifacts have
been checked, remove disposable dataset archives, extracted samples, run-local
dataset copies and regeneratable data/feature caches. This is the user's standing
closeout instruction; no extra confirmation is needed for these identified files.
Inspect task-specific paths and active consumers before deleting. Shared inputs
stay until all requested arms/models that need them finish; record deferred
cleanup if another consumer, retry or continuation still needs the bytes.

Preserve task metadata/prompts, dataset identities and hashes, origin/restoration
references, split/manifest records, authoritative measurements/predictions,
validation/recovery receipts, source commits/snapshots, final delivery bundles,
findings and reports. Keep unique input bytes when no restoration source is
recorded, and explain the deferred cleanup. Keep raw datasets out of new result
backups when they can be restored separately.

Record the exact deleted paths, their hashes/identities, bytes reclaimed and any
deferred paths/reasons in the ledger and task report. Note which future replay
or integrity checks require restoring dataset bytes. Keep the original outcome
and disclose removed inputs; future verification that needs those inputs must
restore them. Do not reset run state or delete evidence to reclaim dataset space.

## Compact the observer before the next execution

After each task/arm/model execution, including a failed/stopped attempt, update
`HANDOFF.md` with the ledger/report locations, checkout/branch/model, completed
run IDs, next pending task/arm, remaining configured budget where shared, blockers,
cleanup status and restoration references. Point to full evidence instead of
copying transcripts or dataset contents into the handoff.

Then use the observing client's native context-compaction action before starting
the next execution. Record that it actually happened. The next context reads the short
handoff and ledger, consults reports as needed and continues only pending work.
This compacts the observer; each arm retains its own configured session/memory
behavior and source continuity.

Compaction requires client support. If no agent-callable action is available,
persist the handoff, mark compaction pending and hand back for client-side
compaction. Do not claim a summary file compacted the conversation or start a new
thread automatically. Instructions define the procedure; this document adds no
automatic compaction or dataset-deletion hook to the runtime.
