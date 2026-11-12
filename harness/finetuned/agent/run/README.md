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

`hand_over` validates the champion snapshot once per live invocation. A fix,
failed/stopped/empty validation, or reply without labelled findings prevents
refit. Repeated calls cannot bypass that decision. At budget end (also idle
or failed lead sessions), the controller waits for running trials and applies
the same validation rule before deterministic terminal refit. Cancelled runs
retain progress for resumption. Success requires refit artifact validation.

Limits: no paid v2 task integration gate has run. Wall-time/accuracy targets
are unmeasured. Validation detects only defects it observes; a completed
scout is not proof of model correctness. Its cached verdict is process-local,
so a restart before hand-over acceptance may repeat validation. Clustering
confirmation and label-free hand-over retain the P7c limitations. Host shells
and terminal refit retain the documented privileges; filesystem isolation is
not a network policy. PROGRESS is the lead's durable trial summary; measured
trial results are not automatically appended as result-kind findings yet.
