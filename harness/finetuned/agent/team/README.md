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

## Inputs

Scouts get what stream B's `TaskData` provides, nothing else. The opening
message carries `task.md` as B writes it (the unit introduction, then the task
text: one copy, no separate introduction). `stageScoutInputs` (`workspace.ts`)
copies `task.md` and `profile.json` (row count, target summary, sample source)
into the task's scout folder, `solutions/scratch/scouts/<task>/` (ignored
scratch space, `scoutWorkspace` in run/sandbox.ts), stages the unit's course
resources into its `resources/`, and lists the development archive, the
development manifest and the test archive for the data prompt. The prompts name
only files that exist there; a unit without course material says so.

`createScoutRunner` adapts the observed subagent session factory and isolated
filesystem tools. Its `sandbox(role, trial?)` builds every call's sandbox anew,
`expertSandbox(data, role, python, trial)` in production; nothing is bound when
the runner is created. Pass `prepare: runner.prepare` to `createScouts` so all
requested roles are preflighted before any starts. `scoutToolset` narrows that
sandbox: every mount read-only, plus
- data: its `research/` writable (expertSandbox mounts it and makes the scout
  folder its cwd);
- ideas: nothing writable; read-only file tools and stream B's
  `webSearchExtension`, at most three searches per session, logged to its own
  `research/web-search-<id>.jsonl` (written by the harness, never containing
  the key);
- validation: see below.
The runner uses the shared preflight before starting its session; pass
`scoutPaths` when the journal, unit introduction, task text or profile are not
the task defaults, and `setup` to share passed checks with an earlier
preflight. Call `scoutRequirements(role)` when declaring the encompassing lead
stage's whole-chain setup requirements. Role calls are serial. Child
environments and search counters/logs are session-local; no scout changes
process.env.

`ScoutBudget` counts every tool call at the assistant message that emits it,
before Pi resolves the tool or validates arguments, so unknown tools and
invalid arguments use budget too. Every call occurrence counts: calls that
reuse a tool-call ID, within one message or across turns, are separate calls.
Calls within the budget are admitted; later ones are blocked with finish-up
feedback. Each admission is consumed by exactly one execution and expires at
the next assistant message, so executions never exceed admitted calls (Pi
prepares calls in message order on its sequential and parallel paths alike).
Earlier versions admitted by ID, so a reused ID could execute more than once
for one counted call; the budget probes in budget-results.md ran on such a
version. Every tool result,
including Pi's own rejections, carries the counter. After the budget is spent
the scout gets one more tool-call turn; tool calls in any later turn are
removed from the message, which ends the loop with the text it wrote. Model
turns are bounded by budget plus two the same way.

`guardScoutSession` detects stuck sessions (no session event for
`team.scoutGuard.stallMs`, or running past `wallMs`) and aborts them without
waiting for them to settle; it is not a work budget. `runScoutSession` then
terminates a stopped session instead of closing it: the Pi session is disposed
and its observer released without waiting for the prompt, and every tool
execution is aborted through a signal the runner owns and awaited (bounded).
A scout's bash is the supervised agent shell (`run/agent_shell.ts`), bound to
the scout's session, so supervisor findings such as `stalled` reach the scout
and its calls count against the budget like any other. An aborted bash call
stops its tree through the supervisor (SIGTERM, a grace period, SIGKILL, the
sandbox launcher last); the sandbox's PID namespace ends whatever a call
started when its command ends, and the child's `close()` and `terminate()`
also close its shells, so no process of the scout's bash tool survives. The
other sandboxed tools SIGKILL their bubblewrap worker. `scout_session_end`
records the cleanup. The lead then gets a
stop line. The service normalizes the final reply to bullets (bulleted or
numbered items with their indented continuation lines); an empty reply yields
an explicit no-evidence line. Error, stop and no-evidence lines are harness
text: they are not journaled, and `report()` returns each role's status
(completed, empty, stopped, failed) with its count of scout-written bullets.
Exhaustion is not an artifact validation failure.

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
supersession events. Missing/changed local files and check hashes are stale.
Experiment and commit-bound refs resolve through stream B's
`resolveTrialSnapshot` (`trials.ts`, over the task's training roots
`<task>/solve/training/*/`, and git for `{file, line, commit}`): resolved when
the snapshot or the file line at that commit is verified, stale when the record
exists but its source is missing or changed, unresolved (`unresolvedRefs`)
when there is no record to check. Resolving may restore an absent snapshot
worktree under its trial directory, once per reader. The lead's request refs
reach the scout with that status. Harness result appends require an
authoritative measurement adapter; agent-written result entries are refused.

## Validation

A validation call names exactly one measured trial (`{experiment}`, or
`{check, experiment}` refs to the same trial); the service refuses others
before any scout starts. For each call the service resolves that experiment
with stream B's resolver; if the snapshot cannot be resolved the role fails
("snapshot unavailable") and no session starts: live code is never a fallback.
The runner builds the call's sandbox with `expertSandbox(..., "validation",
trial)` (snapshot mounted read-only, `VALIDATION_SOURCE_ROOT` and
`VALIDATION_EXPERIMENT_ID` set). The scout's view hides the live solutions tree
except `checks/` (only `checks/<task>/` writable) and this trial's check logs;
its cwd is the snapshot's `solutions/`. Its shell calls keep their output in
`scratch/validation/<experiment>/shell-calls/` (read-only to the scout,
ignored by git), never in `checks/<task>/`, which trial commits would include. `run_checks` runs stream B's
`runTrialChecks` on that snapshot (fresh interpreter, snapshot first on the
import path, live import origins refused) and records each check's hash.

Bullets start with `ok`, `fix` or `advice` and are journaled as `fact`,
`defect` and `idea`, each with the trial's `{experiment}` ref, commit-bound
refs for cited snapshot lines and `{check, experiment, sha256}` refs for cited
checks it ran. Unlabelled bullets are returned but not journaled. Reading
labels from archive member names is the task's label delivery, never a defect
(shared fact and validation prompt).

Live paid budget probe (one scout at a time):

```
./dev bun harness/finetuned/agent/team/budget_probe.ts spam1 data 10
./dev bun harness/finetuned/agent/team/budget_probe.ts spam1 validation 10 <experiment-id>
```

Allowed evaluation tasks are spam1, spam2, spam3 and code2, budgets 10/20.
Code2 has a local probe-only declaration from its supplied task text; it does
not change pipeline.config.json. The probe uses (or prepares) stream B's task
data and stages scouts exactly as above; a data/ideas probe moves an earlier
probe's `research/` into its own output folder first, so it starts clean.
Scouts inspect corpus bytes/text, never run corpus programs. The probe runs the
shared preflight (task.md with the unit introduction, profile and journal
destination) before staging anything, and records itself as stage
`scout-probe`. Only a scout that completed with bullets is a
successful probe; a failed, guard-stopped or empty scout records that outcome
(`pipeline_run_end`, `summary.json` status) and exits nonzero, and its harness
line is not counted as a bullet. Outputs and per-probe journals live under
runs/finetuned/scout-dry-run/. Live telemetry uses Langfuse and shared run and
invocation IDs. This probe does not promote, train, refit or submit anything.

Checks:

```
./dev bun test harness/finetuned/agent/team harness/finetuned/agent/subagents harness/finetuned/agent/prompts
./dev bun run typecheck
```
