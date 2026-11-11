# Supervision (stream A)

`ExperimentSupervisor` samples trial process trees on Linux (`/proc`) and
Darwin (libproc). `harness.config.json` has one validated `supervision` block.
CPU is a percentage of one core and includes reaped children's time
(`cutime`/`cstime`), so a loop of short subprocesses is not idle. RSS and Linux
I/O counters cover the process group plus descendants that left it (`setsid`)
while their parent lives. One `/proc` scan per tick serves the group sample,
the machine-protection refresh and the liveness check; I/O is read only for
members. Sampling is free. Healthy progress never wakes an agent; completion
and each kind of finding do. Explicit status/output requests remain available.

Findings, each reported once per process lifetime:

- **stuck**: no output at idle CPU past the adaptive gap threshold.
- **stale**: busy CPU with no output is what fitting looks like, so silence
  alone is no evidence. Stale needs a rhythm the call set itself (at least
  three output gaps spread over at least `minStallMs`) and then busy silence
  beyond `stallGapMultiple` times its longest gap. A trial fitting one fold
  silently, or a script that printed a start-up burst, is never stale.
- **time-wasting**: elapsed time beyond `overrunMultiple` times the projection
  for comparable work and beyond `overrunMinMs`. Shell calls are projected
  from the median of at least three earlier runs of the same command in the
  same directory. Trials are projected from the wall time of an earlier
  cleanly completed trial in the same training service that did the same work
  (request without its hypothesis). Without such history there is no
  projection and nothing is reported about time.
- **runaway memory**: warned while available RAM above the protection reserve
  is no larger than the process's own RSS, so the warning comes before machine
  protection stops anything. `memoryCeilingBytes` overrides this.
- **flooding**: trial output beyond `outputCapBytes`.

Each report includes CPU, RSS, elapsed time, the last output lines (exit
reports carry the lines the run ended with) and the complete log path. Every
agent-facing note is a prompt in `agent/prompts/experiments/` (`note-*`,
`machine-at-risk`, `shell-*`), rendered from the run's snapshot; the reference
is recorded with the `experiment_update` event.

`MachineProtection` is shared across supervisors **in one harness process**.
Below the RAM reserve it immediately chooses the owner of the largest live
member process; swap must stay full (below 1% of its size, at most 64 MiB,
free) for 15 seconds. A machine with no swap does not count as swap-full. It
stops the owner's process tree, records the stop reason and peak RSS, informs
that owner ("this experiment was too big for the machine") and allows
subsequent work. It does not depend on kernel OOM victim ordering. The
existing cancellation/close and explicit agent stop APIs still work.

A stop captures every member of the tree with its birth identity before the
SIGTERM, so a member the SIGTERM orphans still gets the SIGKILL and a reused
PID never does. A descendant that was already orphaned (its parent exited
after `setsid`) is no longer part of the tree and is not found.

The log keeps all output. `output()` caps every read at 50 KiB by default and
stops its cursor before a character the cap would cut, so no byte is lost.
`createSupervisedBashTool(cwd, options)` provides a blocking SDK-compatible
shell tool using the same supervisor. Its result is the answer: the end of the
output within the cap (a traceback is at the end), a note with the omitted
byte count, the exit code and the path of the full output. It delivers no
exit, diagnostic or flooding update on top; only findings while the call runs
reach the owner. Its root must be writable and readable to the owning agent;
pass sanitized session-local `env`, the owner's `deliver`, and the shared
reporter `record` callback. Neither timeouts nor findings kill work; session
cancellation and machine protection do.

## Integration hand-off

Harness training already launches through `ExperimentSupervisor`, so it gets
these changes automatically. The shared preflight checks sampling, memory and
process identities (and, on Linux, a loadable libc for `sysconf`, loaded on
first use rather than at import) whenever model/training/refit or explicit
`supervision` requirements are requested. No new credentials or Python packages are needed.

The kickoff assigns `agent/run/**` to D and `agent/subagents/**` to C. Stream A
only removed the dead update-interval option from `run/harness_solve_session.ts`.
Installing `createSupervisedBashTool` for agent bash calls waits until stream B,
which moves the session bash tool into `run/sandbox.ts`, is merged; it then
covers `run/session_runner.ts`, `subagents/pi.ts` and the isolated solve bash
path. Until then existing SDK bash calls are **not globally supervised**. A sandboxed
worker's arbiter is a separate process: keep supervision in the parent harness,
where it can sample host PIDs and coordinate shell work with trials. A descendant
that is orphaned after leaving the group (its parent exited) escapes the tree
and therefore signalling. Cross-harness-process arbitration
and Darwin swap-full sampling remain limitations, not verified capabilities.

## Checks

Run `./dev bun test harness/finetuned/agent/experiments
harness/finetuned/agent/harness` (on one command line), then
`./dev bun run typecheck`. Real scripts verify stuck/stale once-only reports,
healthy silence, the shell tail/spill without extra updates, process-tree
stops including a `setsid` descendant, and process-group cleanup. A fake `/proc`
verifies reaped-children CPU; an attached log verifies byte-exact UTF-8 reads. Injected memory
readings verify largest-owner selection, sustained swap pressure and a real
process stop followed by a successful next trial, without exhausting the
shared machine. Darwin-specific sampler checks skip on Linux.
