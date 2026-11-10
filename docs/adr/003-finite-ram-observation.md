# ADR 003: Finite RAM, observation and flexible modelling

[Decision index](README.md) · [Architecture](../architecture.md)

## Status

Accepted design; process ownership exists, Linux observed scripts/shared pool pending P1 integration. Victim ordering unresolved.

## Context

The redesign records two research scripts using about 9 GB each on a roughly 15 GB machine. Remote model throughput does not enlarge host RAM. A productive long-running fit and a hung silent process need different treatment. A time cap alone cannot tell them apart.

## Decision

Observe CPU, RSS, output and progress. Return a process ID for long commands and wake the agent on exit, diagnostics, idle stalls or memory pressure. Design one pool capped at machine RAM minus a reserve, covering agent scripts and trials with no swap; intended policy sacrifices scripts before trials and explains interruptions. Avoid arbitrary time kills as the primary resource policy, while retaining explicit run/action/context budgets and user cancellation. Preserve estimator freedom; use sparse data, small probes and bounded parallel jobs as guidance.

## Alternatives considered

Unbounded processes can exhaust the machine. Fixed short wall timeouts can kill useful work. A fixed whitelist of small models limits agent choice. Independent per-command memory caps cannot fairly account for combined scripts and workers.

## Consequences and tradeoffs

Observation does not prove useful progress: high CPU can still waste work. Opaque fits may offer no checkpoint. At parent HEAD the sampler is Darwin-only and research bash still has a timeout. Unintegrated P1 d2d5949 added Linux/pool machinery but recorded a 300 MiB reproduction where a 205 MiB trial dies while a 90 MiB script survives. oom_score_adj=1000 is a bias, not a scripts-first guarantee. Do not claim the intended victim ordering is enforced. Final investigation eee1894 on t3/protect-trials-under-pool-pressure found no tested unprivileged strict-ordering controls and now unconditionally refuses production pool setup/launch. P1 is not integrated. The pending user choice is to defer P1, document best effort, or retain strict blocking; this ADR does not resolve it. A robust pool and death/recovery policy must be tested with descendants and inverted sizes.

## Code and contracts

[Redesign decisions](../redesign-plan.md); [supervision design](../../harness/finetuned/docs/experiment-supervision.md), [sampler](../../harness/finetuned/agent/experiments/sampler.ts), [supervisor](../../harness/finetuned/agent/experiments/supervisor.ts), [current experiment README](../../harness/finetuned/agent/experiments/README.md).

## Revisit triggers

Revisit after P1 integration and its inverted-size failure is fixed; also when host RAM changes, cgroup/systemd prerequisites are unavailable, or aggregate resource peaks violate the reserve. Process RAM is bytes in local processes; model context is tokens; cross-task memory is persisted code/knowledge. None substitutes for the other.
