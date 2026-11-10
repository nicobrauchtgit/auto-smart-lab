# Harness settings

Edit `harness.config.json` at the repository root for active harness tuning:
research limits, solve defaults, fold recommendations, session/context limits,
experiment notification and sampling intervals, and subagent limits. Values are
validated, copied, and frozen when the process starts. Restart the runner after
changing them; an active run continues using its original settings.

`pipeline.config.json` selects stages and models/providers. Its stage `options`
are optional explicit overrides, not duplicated defaults. API callers and test
fixtures can also override settings. The resolved pipeline trace contains both
`harness` defaults and effective stage options, and its configuration fingerprint
covers both. Session, solve, and supervisor events record their settings too,
including effective supervisor limits after overrides.

For a 30-second versus 15-second routine notification experiment, change
`solve.experimentUpdateIntervalSeconds`. This is a minimum interval between
routine progress notifications, not a timer forcing fold inspection. Diagnostics,
exits, and other urgent updates can arrive sooner; the agent can request status
through its tools at any time. Keep `supervisor.sampleIntervalMs` separate: it
controls process measurement, not model calls. The generic supervisor's 5-second
default is retained for standalone experiment scopes; solve explicitly applies
its own notification setting.

Agent-designed estimator hyperparameters and CV choices remain per-trial inputs
in `request.json`, `invocation.json`, and the measured fold manifest. They are not
prescribed globally by the harness. Model/provider configuration remains in
`pipeline.config.json`; chosen model context/output limits are captured with
session configuration. Legacy pre-migration solve/evaluation policies and
protocol constants are outside this active harness configuration.

Langfuse export has not been installed. These snapshots are recorded in our
existing event stream, ready for a Langfuse adapter to attach to each run.
Prompt snapshots already contain full rendered system and opening prompts as
well as their hashes; handoff prompts and answers are observed session messages.
