# ADR 003: Finite RAM, observation and flexible modelling

[Decision index](README.md) · [Architecture](../architecture.md)

## Status

Superseded on 2026-11-11 by
[expert-team-v2.md section 6](../../harness/finetuned/docs/expert-team-v2.md#6-global-supervision-of-tool-calls-and-trials)
(global supervision of tool calls and trials), accepted with
[ADR 007](007-lead-and-scouts.md). The observation principles below carry
over; the shared swap-free pool with scripts-first victim ordering (P1) is
dropped. Process ownership of harness workers exists today.

## Context

The redesign recorded two research scripts using about 9 GB each on a roughly
15 GB machine; on 2026-11-10 a 9.5 GiB research probe filled swap. Remote model
throughput does not enlarge host RAM. A productive long-running fit and a hung
silent process need different treatment. A time cap alone cannot tell them
apart.

## Decision (original, 2026-11-10)

Observe CPU, RSS, output and progress. Return a process ID for long commands and wake the agent on exit, diagnostics, idle stalls or memory pressure. Design one pool capped at machine RAM minus a reserve, covering agent scripts and trials with no swap; intended policy sacrifices scripts before trials and explains interruptions. Avoid arbitrary time kills as the primary resource policy. Preserve estimator freedom.

## What replaced it

The P1 investigation (branch `t3/protect-trials-under-pool-pressure`,
`eee1894`) found that
unprivileged cgroup controls did not make the kernel kill the largest script
before a trial: in a 300 MiB test pool a 210 MiB trial died while a 90–95 MiB
script survived, and writing `oom_score_adj=-1000` was denied. v2 section 6
therefore uses its own sampler for every agent shell call and trial. It reports
stuck, stale, time-wasting, flooding and runaway-memory calls to the owning
agent, and its only stop is machine protection: when available RAM falls below
a reserve or swap stays full, the harness stops the largest process itself,
tells its owner it was too big, and the run continues.

## Consequences and tradeoffs

Observation does not prove useful progress: high CPU can still waste work.
Opaque fits may offer no checkpoint. The current sampler is Darwin-only and
returns no samples on Linux; a Linux sampler is a P6 prerequisite. Stopping the
largest process can stop a trial rather than a script; v2 accepts that and
reports it. There is no peer-reviewed evidence for the specific thresholds;
they come from our own measurements in
[experiment-supervision.md](../../harness/finetuned/docs/experiment-supervision.md).
Process RAM is bytes in local processes; model context is tokens; cross-task
memory is persisted code/knowledge. None substitutes for the other.

## Code and contracts

[v2 supervision](../../harness/finetuned/docs/expert-team-v2.md#6-global-supervision-of-tool-calls-and-trials), [supervision measurements](../../harness/finetuned/docs/experiment-supervision.md), [sampler](../../harness/finetuned/agent/experiments/sampler.ts), [supervisor](../../harness/finetuned/agent/experiments/supervisor.ts), [experiment README](../../harness/finetuned/agent/experiments/README.md).
