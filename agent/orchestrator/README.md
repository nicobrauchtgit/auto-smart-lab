# Goal-directed orchestration

`npm run orchestrate -- unit 1 task 1 --goal 1` resolves the canonical task and
starts a Pi decision agent. It selects actions; no configured stage chain is
run under an orchestrator label. Enable/disable available modules in
`pipeline.config.json`. The default scheduler stays `configured`; setting
`scheduling: "agent"` routes the generic pipeline API to this controller with
submission disabled. Explicit `orchestrate` invocation authorizes deterministic
submission under its immutable policy. `--no-submit` exposes local modules only,
`--max-submissions 0..3` reduces the absolute cap, and `--check-setup` checks the
whole available chain without agent sessions, fits or task uploads. Setup model
access uses the existing tiny explicit provider probe.

`--resume <run-id>` reopens the same immutable task/config/prompt snapshot and
remaining budgets. Configuration/task changes refuse effects; restart with a new
run for changed configuration. A resume cannot increase the cap, change the goal,
or turn submission on/off. All counters and the wall deadline survive restart.

The coordinator stores checksummed `state.json` at
`runs/<task>/pipeline/<run-id>/`. Its append-only journal is inside the same atomic,
fsynced snapshot transaction as authoritative state, so action acceptance cannot
tear from the journal. Kernel-backed run and task-workspace locks serialize
writers and expire on host-process death, not inactivity. Corrupt/oversized state
fails closed before effects. This is cooperative local durability, not protection
against someone who can rewrite all harness files and recompute their hashes.

Only controller tools are exposed: `pipeline_status`, `task_configure`, `stage_start`,
`stage_status`, `stage_feedback`, `stage_cancel`, `artifact_inspect`,
`pipeline_wait`, `pipeline_finish`. All mutations require action ID, expected
revision and rationale. `task_configure` declares the task configuration
(harness parts, validated against the task files) before the first stage; the
task's `pipeline.config.json` entry is shown as a suggestion only. Identical action retries return their durable receipt;
conflicting IDs/stale revisions refuse. Accounting reservations persist in the
journal without advancing the decision revision carried by the guarded tool call.
Workspace/evidence/action transitions advance it. One mutating stage is active at
a time. Stage invocation IDs are reserved before dispatch and passed to the shared
executor. A guidance note is immutable per invocation; live feedback uses existing
bounded receipt journals. Completion summarizes actual executor validation,
measurements and provenance separately from worker prose.

The trusted artifact catalog retains content-addressed snapshots; model arguments
name IDs, never arbitrary filesystem paths. Upstream source hashes are rechecked
before dispatch. Producer success plus validation is required. Artifact details
are bounded, row labels/predictions/model pickles are not controller tools, and
full reports remain outside the session. Status exposes bounded pages of significant
notifications and delivered cursors; acknowledgment is durable. Terminal events
are retained until acknowledgment. `pipeline_wait` waits for actual changes and
never starts periodic model polling. Prompt snapshots are serialized and restored
without loading mutable authored files. Every physical session uses the existing
observer, narrow allowlist, disabled ambient context/extensions, and fresh
controller state through the logical session handoff.

Official attempt scores and the official best remain separate from development
metrics and advisory readiness. Remote attempts already consumed reduce the total
three-attempt cap. Unknown local reservations also consume budget. Pending/unknown
outcomes block further effects and reconcile through the registered executor
`mode: "reconcile"` path, which has no upload fallback. The same durable work ID
supplies the per-submission policy action identity; root controller ownership is
retained separately. Read-only recovery/access checks precede unrelated model
preflight. Already achieved targets/exhausted caps stop without a model session.
When more work is needed, all dynamically available prerequisites—including later
submission—are checked before the first decision agent. No-submit/disabled submit
requires no submission credentials.

A frozen identity never reopens development. New source or fixed parameters must
earn fresh harness validation. Terminal champions are retained as historical
measurements, omitted from development comparison reruns and new selection. A new
candidate's standalone measurement does **not** assert a paired improvement over
the terminal champion. Refit binds supplied selected evidence to the authoritative
champion tag. Configured chain execution does not upload even when submit is
enabled; evaluation remains advisory.

Host restart marks lost Pi research/solve/evaluate sessions interrupted. A lost
solver requires the next solve invocation to reconcile existing training through
its existing durable harness-root ownership/recovery path; other workspace stages
are refused until that happens. A new physical model session does not pretend to
reattach lost model state. Refit uses the existing freeze/worker recovery path.
Submission uses GET-only ledger reconciliation; absent intents remain unknown and
never dispatch a new POST. Cancellation aborts owned handles and waits for them to
settle. Worker recovery/refit launch caps remain their existing independent limits.

Current limitations: diagnostic delegation is intentionally unavailable—the
existing generic child manager has broad worker tools and only in-memory child
ownership. No durable diagnostic adapter, distributed coordinator, provider-side
model-request reconciliation, sealed-score disclosure, mandatory three uploads,
or guarantee of reaching score 1 is implemented. Trial accounting conservatively
reserves each solve invocation's entire allowed trial allocation; unused slots
are not refunded. Budgets guard physical sessions, provider requests, tool calls,
stages, trial allocations, retries and a persisted wall deadline. Provider retries
inside one SDK HTTP request are not separately observable billable units. State
contains immutable artifact lineage and bounded summaries, not a separate universal
candidate registry; authoritative candidate/freeze integrity remains in the existing
training/refit/submission contracts.

Task-wide submission accounting is read on **every** new/resumed autonomous run
through `readSubmissionAccounting`, before any modelling setup or agent decision.
It validates/reconciles all intents in the account/task ledger, including prior
runs, and preserves missing-remote unknown reservations. A new run cannot reset
those reservations. Resume submission inputs use the durable catalog metadata;
original refit/source files may be removed after upload without preventing
GET-only intent reconciliation. Regular submission execution still verifies its
original upstream artifact hashes and frozen candidate bundle.
