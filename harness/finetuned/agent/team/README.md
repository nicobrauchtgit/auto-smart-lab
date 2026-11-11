# Blocking scouts

`createScouts` exposes `scout({role, question, refs})` and its lead-facing Pi
tool. Multiple roles run sequentially and return only final bullet text. The
backend has its own observed context; neither tool events nor intermediate
assistant messages are forwarded. Repeats receive the journal, task text and
unit introduction through the run's immutable prompt snapshot.

`createScoutRunner` adapts the existing instrumented session runner and
isolated filesystem tools. The controller supplies a sandbox containing only
permitted development inputs, profile, course resources and the shared tree.
Its cwd must have a dedicated `research/` folder (under the shared solutions
research area); only that folder is writable for the data scout. Ideas has
read-only tools and the existing scoped search extension, limited to three
searches. The runner uses the shared preflight before starting its session.
Call `scoutRequirements(role)` when declaring the encompassing lead stage's
whole-chain setup requirements. Role calls are serial because the legacy
session runner/search extension still temporarily mutate process.env; stream B
owns session environment integration. Do not run this runner concurrently
with another legacy runSession in the same process.

`ScoutBudget` counts admitted calls, including tool errors, appends a counter
to each result, and blocks excess calls with finish-up feedback. The service
normalizes the final reply to bullets; an empty reply yields an explicit
no-evidence bullet. Exhaustion is not an artifact validation failure.

`appendFindings` serializes and flushes appends with a separate kernel flock
(waiting with cancellation; released on process exit). Reads report a partial
tail, and the next writer removes only that tail under the lock. Complete
malformed records fail. Scout entries are attributed observations/ideas, never
harness-measured results. Structured request refs and recognized inline file,
profile and URL citations are retained. Paged status/stale-ref resolution and
harness result/resolution append adapters remain integration work.

Validation is deliberately unavailable until stream B's immutable trial
snapshot/check adapter is merged. The service refuses the role by default;
the provided runner refuses it unconditionally. A future adapter must bind
`VALIDATION_SOURCE_ROOT` and `VALIDATION_EXPERIMENT_ID`, verify import origins,
run checks against read-only snapshot source, and never fall back to live code
(expert-team.md section 3). The prompt and role contract are present, not an
implemented executable validation service.

Live paid budget probe (one scout at a time):

```
./dev bun harness/finetuned/agent/team/budget_probe.ts spam1 data 10
```

Allowed evaluation tasks are spam1, spam2, spam3 and code2, budgets 10/20.
Code2 has a local probe-only declaration from its supplied task text; it does
not change pipeline.config.json. Scouts inspect corpus bytes/text, never run
corpus programs. Outputs and per-probe journals live under
runs/finetuned/scout-dry-run/. Live telemetry uses Langfuse and shared run and
invocation IDs. This probe does not promote, train, refit or submit anything.

Checks:

```
./dev bun test harness/finetuned/agent/team harness/finetuned/agent/subagents harness/finetuned/agent/prompts
./dev bun run typecheck
```
