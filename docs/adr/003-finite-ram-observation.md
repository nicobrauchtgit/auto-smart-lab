# ADR 003: Finite RAM, observation and flexible modelling

[Decision index](README.md) · [Architecture](../architecture.md)

## Status

Accepted design; process ownership exists. Linux observed scripts/shared pool
are deferred from this merge by the user. Strict victim ordering remains a
future acceptance requirement, not an implemented guarantee.

## Context

The redesign records two research scripts using about 9 GB each on a roughly 15 GB machine. Remote model throughput does not enlarge host RAM. A productive long-running fit and a hung silent process need different treatment. A time cap alone cannot tell them apart.

## Decision

Observe CPU, RSS, output and progress. Return a process ID for long commands and wake the agent on exit, diagnostics, idle stalls or memory pressure. Design one pool capped at machine RAM minus a reserve, covering agent scripts and trials with no swap; intended policy sacrifices scripts before trials and explains interruptions. Avoid arbitrary time kills as the primary resource policy, while retaining explicit run/action/context budgets and user cancellation. Preserve estimator freedom; use sparse data, small probes and bounded parallel jobs as guidance.

## Alternatives considered

Unbounded processes can exhaust the machine. Fixed short wall timeouts can kill useful work. A fixed whitelist of small models limits agent choice. Independent per-command memory caps cannot fairly account for combined scripts and workers.

## Consequences and tradeoffs

Observation does not prove useful progress: high CPU can still waste work.
Opaque fits may offer no checkpoint. Current sampling is Darwin-only and research
bash still has a timeout. P1 investigation eee1894 reproduced a larger trial
dying while a smaller script survived in a capped 300 MiB pool: OOM score bias
is not a scripts-first guarantee. The user chose to defer P1, leaving neither
its backend nor its unconditional production guard in the merge. Strict future
acceptance remains; see the [counterexamples and decision](../p1-memory-pool-blocker.md).
A robust pool and death/recovery policy must be tested with descendants,
concurrent allocation and inverted sizes. Existing resource limitations are
recorded rather than presented as fixed.

## Code and contracts

[Redesign decisions](../redesign-plan.md); [supervision design](../../harness/finetuned/docs/experiment-supervision.md), [sampler](../../harness/finetuned/agent/experiments/sampler.ts), [supervisor](../../harness/finetuned/agent/experiments/supervisor.ts), [current experiment README](../../harness/finetuned/agent/experiments/README.md).

## Revisit triggers

Revisit after P1 integration and its inverted-size failure is fixed; also when host RAM changes, cgroup/systemd prerequisites are unavailable, or aggregate resource peaks violate the reserve. Process RAM is bytes in local processes; model context is tokens; cross-task memory is persisted code/knowledge. None substitutes for the other.
