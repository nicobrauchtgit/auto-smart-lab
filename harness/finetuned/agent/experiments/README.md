# Supervision (stream A)

`ExperimentSupervisor` samples trial process trees on Linux (`/proc`) and
Darwin (libproc). `harness.config.json` has one validated `supervision` block.
CPU is a percentage of one core and includes reaped children's time
(`cutime`/`cstime`), so a loop of short subprocesses is not idle.

On Linux every supervised command (harness trials, refit, confirmation and
every agent shell call) runs under a launcher (`launcher.ts`, `reaper.py`):
a small Python process from the project environment, standard library only,
that marks itself a child subreaper (`prctl(PR_SET_CHILD_SUBREAPER)`, no
privileges needed), runs the command and stays until no descendant remains.
A process the command leaves behind (`setsid cmd &`, a daemon's double fork)
re-parents to the launcher instead of to init, so it stays a descendant of
the run's group leader and any later scan finds it, however soon its own
parent exited: discovery does not depend on when a sample happens. The
launcher leads the process group (`pgid` in `experiment.json` is its PID and
`launcher` its argv) and records the command's own PID and exit in
`command.json`. It ignores SIGTERM, SIGINT and SIGHUP; a stop kills the rest
of the tree first, round after round (a process forked meanwhile re-parents to
the launcher and the next round finds it), and the launcher then exits by
itself, or is killed last. It resets SIGPIPE and SIGXFSZ, which Python
ignores, before running the command. Darwin has no subreaper; there the
process group is followed as before. The shared preflight checks the launcher
(`supervision-launcher`) wherever it checks process supervision.

On Linux every process of a run is tracked by birth identity (PID plus start
time and boot ID): the process group while it is verifiably ours (spawned here,
or its leader verified on reattach, and not seen empty since), descendants
through their parent link, and every member seen earlier that is still the same
process. A member stays tracked after the leader exits or after it left the
group (`setsid`) and its parent died. RSS, CPU and I/O cover these members.
Tracked members are persisted with the run (`supervisor-state.json`). On
reattach that state is validated field by field; a malformed state, gate or
member list is treated as absent and recorded (`experiment_state_malformed`),
never a crash. A tick that fails (the run's directory removed) is recorded
(`experiment_tick_failed`) and never thrown out of the timer. One
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
- **busy-silence** (information only): without a rhythm, busy silence beyond
  `busySilenceCeilingMs` (30 minutes; the projected overrun when comparable
  work was measured) is reported once under its own kind, worded neutrally:
  "no output for 30 min at high CPU; if this is expected, ignore this note".
  Never on top of stale or time-wasting. A run that prints once and then
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
configuration. `createSupervisedBashTool(cwd, options)` provides an
SDK-compatible shell tool with one supervisor per tool; `options.argv` names
the supervised process (a sandbox launcher). A call returns when its own
command (the shell process) ends, as a normal shell does, with the end of the
output within the cap (a traceback is at the end), a note with the omitted
byte count, the exit code and the path of the full output. Processes the
command left running stay with the tool's supervisor: sampled, under machine
protection, their findings delivered to the owner, their output continuing in
the same file. The result says plainly how many are still running and that
they are tracked, with their PIDs, and that `kill <PIDs>` stops them; they
are stopped when the owning session ends (`closeAgentShells`, or the tool's
`close()`). `timeout` (seconds) stops the call's whole process tree and the
result says so. Findings raised while a call runs are delivered through the
owner's `deliver` (`steer` on a running session), so they reach the agent
right after the result; findings before a session is bound join its next
turn. No exit or diagnostic update is added on top of a result. Its authoritative root stays outside sandbox writable mounts; pass sanitized session-local
`env`, the owner's `deliver`, and the shared reporter `record` callback.
Findings never kill work; `timeout`, session cancellation and machine
protection do. In a sandbox nothing outlives the call: bubblewrap's PID 1
ends the namespace when the command ends, and `--die-with-parent` ends it
with the launcher.

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
signals host PIDs and shares machine protection with trials. Sandboxed calls retain authoritative logs, `command.json`, `experiment.json`
and supervisor state outside all writable mounts. The solve runner uses its
harness-owned `shell-calls/`; other sandboxed callers default to a private host
temporary directory. An agent-readable copy goes to `.shell-calls/<id>.log`
in the first writable mount. The supervisor never reads that copy. Host shells
use `runs/finetuned/shell-calls/` and retain their existing unrestricted access. A tool is made before its
session exists; `runSession` and the subagent factory bind every tool they
hand to a session (`bindAgentShells`, again for a replacement session), and
refuse a `bash` tool from anywhere else (`assertSupervisedBash`). They
validate and bind the **final** tool set of a session, after custom tools
replaced built-ins by name (`replaceToolsByName`), never the originals.
A supervised tool carries its binding under an enumerable, module-private
symbol, so a wrapper made by object spread (`{ ...tool, execute }`) or by
`wrapAgentTool(tool, wrap)` is still recognised, and binding the wrapper binds
the supervisor the original reports through; the brand cannot be put on a
raw shell. Findings before binding join the session's next turn. The sandbox
worker (`run/solve_tool_worker.ts`) and `isolatedSolveTools` have no raw shell
definition at all: `bash` there is always the supervised one.
`agent/pi_sdk.ts`, the separate observability experiment and not the
pipeline, keeps an unsupervised SDK bash.

Cross-harness-process arbitration and Darwin swap-full sampling and member
tracking (Darwin still follows the process group) remain limitations, not
verified capabilities.

## Checks

Run `./dev bun test harness/finetuned/agent/experiments
harness/finetuned/agent/harness` (on one command line), then
`./dev bun run typecheck`; `run/agent_shell.test.ts` covers the wiring. Real
scripts verify stuck/stale once-only reports, the busy-silence note, healthy
silence, a detached worker whose parent exits before the first sample (found
and stopped), a process forked during a stop, default SIGPIPE, the launcher
preflight, malformed persisted state (`regressions_round3.test.ts`), a shell
call that backgrounds work, `timeout`, a finding reaching a real session, a
wrapped bash replacing the child's built-in, a sandboxed call leaving nothing
behind and a worker without a shell (`run/agent_shell_round3.test.ts`), the shell tail/spill without extra updates, process-tree stops
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

## Log integrity (2026-11-12)

Live output, tails and finding excerpts use the descriptor opened before launch,
with `O_NOFOLLOW` and a regular-file check. Recovery opens logs and small records
without following final symlinks. Replaced state is reported malformed. Agent
copies use fresh files and atomic rename under directory descriptors pinned one
component at a time, preventing ancestor symlink swaps. Failed copies emit
`experiment_spill_failed`; they never cause the harness to read the destination.
Copies are bounded to the source size at the start of copying.

Training stores supervisor files, recovery metadata and trusted runner receipts
in `<training root>/.supervision/<id>/`, outside the worker's trial mount.
Confirmation and refit use separate `.supervision` trees beside their candidate
directories. Legacy worker-writable recovery records require inspection and
explicit migration; they are not silently trusted for a new launch.
Validation checks retain host logs in private temporary directories and return
bounded output captured from pipes; scratch logs are disposable copies.
Default temporary log directories are retained for inspection; automatic cleanup
is not implemented. Unsandboxed host shells and terminal refit retain their
existing host privileges; relocating their logs is not a filesystem sandbox.
Darwin descriptor-relative copy behavior is not measured by the Linux tests.

`log_symlinks.test.ts`, `run/agent_shell.test.ts`, `run/solve_sandbox.test.ts`
and `training/trial_checks.test.ts` exercise harmless host markers, swapped logs,
status/state symlinks, copied-log symlinks and scratch-directory replacement.
No real withheld labels are used. These are local security regressions, not an
integration-gate run or proof against arbitrary malicious model code.

Local verification on Linux, 2026-11-12:

- `./dev bun run test:fast`: 541 passed, 4 skipped, 0 failed (74 files).
- Focused refit/service, training/recovery and confirmation/service: 36 passed,
  0 failed (353.33 s).
- Focused log-symlink, trial-source/checks, solve-session and scout-integration
  checks: 24 passed, 0 failed. After adding the authoritative check-log path,
  trial checks passed again (4 tests); log-symlink checks passed again (4 tests).
- The broader supervision/harness/sandbox/scout run passed 128 tests, skipped
  2 Darwin checks and failed one busy-silence timing assertion under concurrent
  service-test load. Its whole `regressions_round2.test.ts` file then passed
  all 11 tests; the serial fast suite also passed it. An earlier concurrent
  fast run hit a 5 s training-test timeout; the serial rerun passed unchanged.
- `./dev bun run typecheck` and `git diff --check` passed.

The full approximately 16-minute suite and the v2 task integration gate were
not run for this security commit; the full suite remains required before merge.
