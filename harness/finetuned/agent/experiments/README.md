# Supervision (stream A)

`ExperimentSupervisor` samples trial process groups on Linux (`/proc`) and
Darwin (libproc). `harness.config.json` has one validated `supervision` block.
CPU is a percentage of one core; RSS and Linux I/O counters include children.
Sampling is free. Healthy progress never wakes an agent; completion and each
kind of finding do. Explicit status/output requests remain available.

Stuck (idle silence), stale (busy silence), flooding, runaway memory and an
overrun beyond twice a supplied projection report once per process lifetime.
Stale uses the same adaptive gap threshold as stuck. Shell projections use the
median of the last 20 completed shell calls in that workspace, after three
observations; trial callers can supply `projectedDurationMs`. Without measured
history or a supplied projection there is no invented time-wasting verdict.
Each report includes CPU, RSS, elapsed time and the complete log path.

`MachineProtection` is shared across supervisors **in one harness process**.
Below the RAM reserve it immediately chooses the owner of the largest live
member process; swap must stay completely full for 15 seconds. A machine with
no swap does not count as swap-full. It explicitly stops the owner's process
group, records the stop reason and peak group RSS, informs that owner, and
allows subsequent work. It does not depend on kernel OOM victim ordering.
The existing cancellation/close and explicit agent stop APIs still work.

The log keeps all output. `output()` caps every read at 50 KiB by default;
findings contain only a bounded tail. `createSupervisedBashTool(cwd, options)`
provides a blocking SDK-compatible shell tool using the same supervisor and
returns a capped response with the spill path. Its root must be writable and
readable to the owning agent; pass sanitized session-local `env`, the owner's
`deliver`, and the shared reporter `record` callback. Neither timeouts nor
findings kill work; session cancellation and machine protection do.

## Integration hand-off

Harness training already launches through `ExperimentSupervisor`, so it gets
these changes automatically. The shared preflight checks sampling, memory and
process identities whenever model/training/refit or explicit `supervision`
requirements are requested. No new credentials or Python packages are needed.

The kickoff assigns `agent/run/**` to D and `agent/subagents/**` to C; stream A
has not edited those files. Those owners must install `createSupervisedBashTool`
in `run/session_runner.ts`, `subagents/pi.ts`, and the isolated solve bash path.
Until then existing SDK bash calls are **not globally supervised**. A sandboxed
worker's arbiter is a separate process: keep supervision in the parent harness,
where it can sample host PIDs and coordinate shell work with trials. The current
supervisor controls process groups; detached descendants which independently
create a new session can escape signalling. Cross-harness-process arbitration
and Darwin swap-full sampling remain limitations, not verified capabilities.
The legacy solve-stage interval override is still accepted by its adapter,
but this module ignores it and no longer emits routine progress.

## Checks

Run `./dev bun test harness/finetuned/agent/experiments
harness/finetuned/agent/harness/config.test.ts` (on one command line), then
`./dev bun run typecheck`. Real scripts verify stuck/stale once-only reports,
healthy silence, flooding/spill and process-group cleanup. Injected memory
readings verify largest-owner selection, sustained swap pressure and a real
process stop followed by a successful next trial, without exhausting the
shared machine. Darwin-specific sampler checks skip on Linux.
