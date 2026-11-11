# Supervision (stream A)

`ExperimentSupervisor` samples trial process trees on Linux (`/proc`) and
Darwin (libproc). `harness.config.json` has one validated `supervision` block.
CPU is a percentage of one core and includes reaped children's time
(`cutime`/`cstime`), so a loop of short subprocesses is not idle.

On Linux every process of a run is tracked by birth identity (PID plus start
time and boot ID): the process group while it is verifiably ours (spawned here,
or its leader verified on reattach, and not seen empty since), descendants
through their parent link, and every member seen earlier that is still the same
process. A member stays tracked after the leader exits or after it left the
group (`setsid`) and its parent died. RSS, CPU and I/O cover these members.
Tracked members are persisted with the run (`supervisor-state.json`). One
`/proc` scan per tick serves the sample, the protection refresh and the
liveness check; I/O is read only for members. Sampling is free. Healthy
progress never wakes an agent; completion and each kind of finding do.
Explicit status/output requests remain available.

Findings, each reported once per process lifetime:

- **stuck**: no output at idle CPU past the adaptive gap threshold.
- **stale**: busy CPU with no output is what fitting looks like, so silence
  alone is no evidence. Stale needs a rhythm the call set itself (at least
  three output gaps spread over at least `minStallMs`) and then busy silence
  beyond `stallGapMultiple` times its longest gap. A trial fitting one fold
  silently, or a script that printed a start-up burst, is never stale.
  Without a rhythm, busy silence beyond `busySilenceCeilingMs` (30 minutes;
  the projected overrun when comparable work was measured) is reported once,
  as stale, with CPU, memory and elapsed time. A run that prints once and then
  loops at full CPU is therefore never silent forever.
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
- **flooding**: output beyond `outputCapBytes`. A blocking shell call reports
  it only while it runs: the owner sees none of its output until it returns.

Each report includes CPU, RSS, elapsed time, the last output lines (exit
reports carry the lines the run ended with) and the complete log path. All
findings due in one tick are delivered in that tick. Reported kinds, output
timing and learned gaps are persisted with the run and restored on reattach,
so a restarted harness neither repeats a report nor forgets the rhythm. Every
agent-facing note is a prompt in `agent/prompts/experiments/` (`note-*`,
`machine-at-risk`, `shell-*`), rendered from the run's snapshot; the reference
is recorded with the `experiment_update` event.

`MachineProtection` is shared across supervisors **in one harness process**:
harness trials and every agent shell call. Each tick takes one machine
reading, evaluates the owner's warnings with it and then hands it to the
protection check, so a sudden drop below the reserve delivers the memory
warning in the same tick as, and before, the stop; a victim chosen by another
owner's check is warned first as well. Below the RAM reserve it immediately
chooses the owner of the largest live member process; swap must stay full (below 1% of its size, at most 64 MiB,
free) for 15 seconds. A machine with no swap does not count as swap-full. It
stops the owner's process tree, records the stop reason and peak RSS, informs
that owner ("this experiment was too big for the machine") and allows
subsequent work. It never chooses the same work twice: if a stop cannot end
every process, the next pressure check moves to the next largest. It does not
depend on kernel OOM victim ordering. The
existing cancellation/close and explicit agent stop APIs still work.

A stop signals every tracked member, each confirmed against a fresh read of
its PID (a PID whose birth differs from the scan is dropped, never signalled),
and the group while a verified member still holds its ID. A member the SIGTERM
orphans still gets the SIGKILL. The run is reported `stopped` only once none
of its processes remain; until then it stays `running` with its stop reason
and is finished as stopped when the last process goes. A recovered run whose
leader exited and whose remaining group members were never tracked still
blocks finishing but is not signalled.

The log keeps all output. `output()` caps every read at 50 KiB by default and
stops its cursor before a character the cap would cut, so no byte is lost. A
cap below 4 bytes (one character's widest encoding) is refused, here and in the
configuration. `createSupervisedBashTool(cwd, options)` provides a blocking
SDK-compatible shell tool using the same supervisor; `options.argv` names the
supervised process (a sandbox launcher). Its result is the answer: the end of
the output within the cap (a traceback is at the end), a note with the omitted
byte count, the exit code and the path of the full output. It delivers no exit
or diagnostic update on top; only findings while the call runs reach the owner.
The call returns when every tracked process is gone, so work it backgrounds
keeps it open: background work belongs in harness trials. Its root must be writable and readable to the owning agent;
pass sanitized session-local `env`, the owner's `deliver`, and the shared
reporter `record` callback. Neither timeouts nor findings kill work; session
cancellation and machine protection do.

## Integration hand-off

Harness training already launches through `ExperimentSupervisor`, so it gets
these changes automatically. The shared preflight checks sampling, memory and
process identities (and, on Linux, a loadable libc for `sysconf`, loaded on
first use rather than at import) whenever model/training/refit or explicit
`supervision` requirements are requested. No new credentials or Python packages are needed.

**Every agent shell call is supervised.** `run/agent_shell.ts` is the one
factory for agent `bash` tools (`agentBashTool`): the host shell of a scoped
session (`sessionBashTool` in `run/session_runner.ts`), subagent children
(`createChildBashTool` in `subagents/pi.ts`), and the sandboxed tools of the
solve session and every expert role (`isolatedSolveTools` in
`run/solve_sandbox.ts`, which `run/sandbox.ts` role policies use). In a sandbox
the supervised process is the bubblewrap launcher with the command inside, so
the mount, PID and user boundary is unchanged while the harness samples and
signals host PIDs and shares machine protection with trials. Full output goes
to `.shell-calls/` in the first writable mount (the agent's workspace), or to
`runs/finetuned/shell-calls/` for host shells. A tool is made before its
session exists; `runSession` and the subagent factory bind every tool they
hand to a session (`bindAgentShells`, again for a replacement session), and
refuse a `bash` tool from anywhere else (`assertSupervisedBash`). Findings
before binding join the session's next turn. `agent/pi_sdk.ts` (an
observability experiment, not the pipeline) keeps the raw SDK tool.

Cross-harness-process arbitration and Darwin swap-full sampling and member
tracking (Darwin still follows the process group) remain limitations, not
verified capabilities.

## Checks

Run `./dev bun test harness/finetuned/agent/experiments
harness/finetuned/agent/harness` (on one command line), then
`./dev bun run typecheck`; `run/agent_shell.test.ts` covers the wiring. Real
scripts verify stuck/stale once-only reports, the busy-silence ceiling, healthy
silence, the shell tail/spill without extra updates, process-tree stops
including a `setsid` descendant whose parent exited and a group whose leader
exited, a reattach that keeps reported kinds and calibration, and
process-group cleanup. An injected snapshot verifies that a reused PID is never
a stop target. The P6 check runs end to end through a real Pi session: a
script from an agent bash call is stopped under injected low-memory readings,
the session is told and continues. A sandboxed bash call verifies that the
supervised process is the sandbox launcher. A fake `/proc`
verifies reaped-children CPU; an attached log verifies byte-exact UTF-8 reads. Injected memory
readings verify largest-owner selection, sustained swap pressure and a real
process stop followed by a successful next trial, without exhausting the
shared machine. Darwin-specific sampler checks skip on Linux.
