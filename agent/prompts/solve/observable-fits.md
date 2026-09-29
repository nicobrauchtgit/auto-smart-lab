## Observe harness-owned fits

The experiment tools are the only source of authoritative training evidence.
Use them as an active control loop, not as a fire-and-forget command:

1. Create or revise the pipeline and choose the CV design and experiment scope.
2. Call `experiment_start` with the pipeline factory, parameters, hypothesis,
   CV request, and scope. Do not supply a seed; the harness owns entropy.
3. Call `experiment_status` to inspect lifecycle and resource state. Call
   `experiment_output` with a byte cursor to read new bounded output without
   replaying the log into context.
4. Interpret completed-fold measurements, warnings, configured versus completed
   work, elapsed cost, and any convergence signals before deciding what to do.
5. Call `experiment_stop` with a concrete reason and observations when further
   work cannot answer the hypothesis economically. Completed diagnostics remain
   available, but an interrupted run cannot promote a model.
6. Revise the agent-owned code or request broader validation only when the
   evidence supports that decision.

### Start with a pilot

A pilot should deliberately reduce work in a way appropriate to the estimator,
for example with fewer rows or folds. It checks that the authored pipeline is
viable and estimates cost; it is not promotion evidence. Move to a complete
promotion-scope run only after the candidate and validation design are stable.
If you skip pilot scope, record the reason in the experiment hypothesis.

You choose the model, features, hyperparameters, CV semantics, and the timing of
starts, observations, stops, and expansions. The harness materializes your fold
design with harness-owned seeds, launches and supervises every fit, preserves
the fold manifest, and writes all authoritative OOF predictions and metrics.
Changing CV configuration creates a different comparison cohort.

### Read real evidence; do not manufacture telemetry

Some estimators expose iterative convergence output and some are silent until a
fit or fold completes. Silence is not permission to invent progress or replace
the chosen estimator merely to make it chatty. Use status for process lifecycle
and resources, and output for the actual messages and completed work the harness
has captured. A local direct fit may help debug construction, but its score is
not evidence and must not be copied into harness artifacts.

Keep output reads bounded and advance the returned cursor. Avoid tight polling:
check when a lifecycle notification arrives or when enough time has passed for
the next meaningful unit of work. Stop deliberately when warnings, convergence,
cost, or completed-fold results settle the hypothesis; otherwise allow the
harness to finish and use its recorded result for the next decision.
