# Harness settings

Edit `harness/finetuned/harness.config.json` for active harness tuning
(`agent/harness/config.ts` imports it from there; it is not at the repository
root): data-profile limits, solve defaults, fold recommendations, session/context
limits, supervision sampling and finding thresholds, and subagent limits.
Values are validated, copied, and frozen when the process starts. Restart the
runner after changing them; an active run continues using its original
settings. v2 replaces the `research` and `solve` keys with one `team` block and adds a `supervision` block
([expert-team-v2.md section 5](../../docs/expert-team-v2.md#5-budget-and-hand-over)),
when P6/P7 land.

`pipeline.config.json` selects stages and declares tasks. The model and
providers live in the root `experiment.config.json`, shared by both arms
([configuration reference](../../docs/configuration.md)). Stage `options`
are optional explicit overrides, not duplicated defaults. API callers and test
fixtures can also override settings. The resolved pipeline trace contains both
`harness` defaults and effective stage options, and its configuration fingerprint
covers both. Session, solve, and supervisor events record their settings too,
including effective supervisor limits after overrides.

The supervisor sends no routine progress notifications: it wakes the agent on
news only (exit, diagnostics and the findings in
[the supervision README](../experiments/README.md)); the agent can request status
through its tools at any time. `supervision.sampleIntervalMs` controls process
measurement, not model calls.

Agent-designed estimator hyperparameters and CV choices remain per-trial inputs
in `request.json`, `invocation.json`, and the measured fold manifest. They are not
prescribed globally by the harness. Chosen model context/output limits are
captured with session configuration.

Observability goes to Langfuse Cloud ([telemetry](../../docs/telemetry.md)).
Prompt snapshots contain full rendered system and opening prompts as well as
their hashes; handoff prompts and answers are observed session messages.
