# Blocking scouts

`createScouts` exposes `scout({role, question, refs})` and its lead-facing Pi
tool. Lead input is validated before any scout starts: the tool schema rejects
extra keys (`additionalProperties: false`), and the service checks the same
shape for programmatic calls, with a clear error. Multiple roles run
sequentially and return only final bullet text. If a later role fails, the
earlier roles' bullets are still returned (and journaled), followed by an
error line for the failed role. The backend has its own observed context;
neither tool events nor intermediate assistant messages are forwarded.

Every role gets the shared scout instruction (`team.shared`), which states the
task fact that training member names end in their label and test names end in
`.x`: label delivery, not leakage, not a feature and not a defect. A repeat
call's opening carries a bounded view of earlier entries: same run and dataset
fingerprint, not superseded, the newest 12 (the contract's page size) with at
most 200 characters each, and the count of older entries not shown.

`createScoutRunner` adapts the existing observed subagent session factory and
isolated filesystem tools. The controller supplies a sandbox containing only
permitted development inputs, profile, course resources and the shared tree.
Pass `prepare: runner.prepare` to `createScouts` so all requested roles are
preflighted before any starts. Create each scout cwd under `solutions/scratch/scouts/` in the shared tree,
so its research scripts stay outside production module checks. Its cwd must
have a dedicated `research/` folder (under the shared solutions research
area). `scoutToolset` builds the view: every controller mount read-only, plus a
writable `research/` for the data scout only. Ideas has the read-only file
tools and the scoped search extension, limited to three searches. The runner
uses the shared preflight before starting its session; pass `scoutPaths` when
the journal or unit introduction are not the task defaults, and `setup` to
share passed checks with an earlier preflight. Call `scoutRequirements(role)`
when declaring the encompassing lead stage's whole-chain setup requirements.
Role calls are serial. Child environments and search counters/logs are
session-local; no scout changes process.env.

`ScoutBudget` counts every tool call at the assistant message that emits it,
before Pi resolves the tool or validates arguments, so unknown tools and
invalid arguments use budget too. Calls within the budget are admitted; later
ones are blocked with finish-up feedback. Every tool result, including Pi's own
rejections, carries the counter. After the budget is spent the scout gets one
more tool-call turn; tool calls in any later turn are removed from the message,
which ends the loop with the text it wrote. Model turns are bounded by budget
plus two the same way. `guardScoutSession` detects stuck sessions (no session
event for `team.scoutGuard.stallMs`, or running past `wallMs`), aborts them
and returns without waiting for them to settle; the lead then gets a stop
bullet. It is not a work budget. The service normalizes the final reply to
bullets (bulleted or numbered items with their indented continuation lines);
an empty reply yields an explicit no-evidence bullet. Exhaustion is not an
artifact validation failure.

`appendFindings` serializes and flushes appends with a separate kernel flock
(waiting with cancellation; released on process exit). Reads report a partial
tail, and the next writer removes only that tail under the lock. Complete
malformed records fail. Scouts append through `appendValidFindings`: valid
bullets are journaled, rejected ones are reported to the lead with their
reason, and one bad record never discards the others. Scout entries are
attributed observations/ideas, never harness-measured results. Each entry
carries only the refs its own bullet cites; lead request refs are context for
the scout, not copied onto bullets. Citations become refs only when they are
contract-valid (a file citation `out.txt:0` stays text); file and profile
paths resolve against the scout's own folder and are stored relative to the
state root. The contract exports in `findings.ts` provide paged reads, status
(its cursor resumes after the last entry returned) and author-only
supersession events. Missing/changed local files and check hashes are stale;
experiment and commit-bound refs are reported as `pendingRefs` until stream
B's snapshot resolver is wired. Harness result appends require an
authoritative measurement adapter; agent-written result entries are refused.

Validation is deliberately unavailable until stream B's immutable trial
snapshot/check adapter is merged. The lead's tool schema offers only data and
ideas, and its description says validation is not available. The service
refuses the role by default; the provided runner refuses it unconditionally. A
future adapter must bind `VALIDATION_SOURCE_ROOT` and
`VALIDATION_EXPERIMENT_ID`, verify import origins, run checks against
read-only snapshot source, and never fall back to live code (expert-team.md
section 3). The prompt and role contract are present, not an implemented
executable validation service.

Live paid budget probe (one scout at a time):

```
./dev bun harness/finetuned/agent/team/budget_probe.ts spam1 data 10
```

Allowed evaluation tasks are spam1, spam2, spam3 and code2, budgets 10/20.
Code2 has a local probe-only declaration from its supplied task text; it does
not change pipeline.config.json. Scouts inspect corpus bytes/text, never run
corpus programs. The probe runs the shared preflight (including the unit
introduction and its journal destination) before staging anything, and records
itself as stage `scout-probe`. Outputs and per-probe journals live under
runs/finetuned/scout-dry-run/. Live telemetry uses Langfuse and shared run and
invocation IDs. This probe does not promote, train, refit or submit anything.

Checks:

```
./dev bun test harness/finetuned/agent/team harness/finetuned/agent/subagents harness/finetuned/agent/prompts
./dev bun run typecheck
```
