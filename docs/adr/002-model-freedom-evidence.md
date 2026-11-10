# ADR 002: Agent-owned design, harness-owned execution and evidence

[Decision index](README.md) · [Architecture](../architecture.md)

## Status

Accepted; implemented, with task-adapter limitations.

## Context

Agents need freedom to discover useful representations and estimators. Their prose or self-run fits cannot serve as authoritative comparisons, especially when source, folds or seeds change.

## Decision

Let the agent choose parsing, features, estimator, parameters, search logic and CV scheme, including custom grouping. The harness supplies entropy, materializes and persists folds, snapshots source, starts workers, observes/stops descendants, writes predictions and measurements, compares candidates and freezes/refits the champion. Agent-run fits may inform development but cannot promote.

## Alternatives considered

Prescribing a fixed estimator/search space simplifies automation but changes the research problem and limits discovery. Trusting agent-reported scores gives flexibility without reproducible evidence. Fully arbitrary agent-owned execution makes consistent recovery and comparison difficult.

## Consequences and tradeoffs

A common trial ABI and source/dependency identity cost engineering effort. Pilots reduce work and inform cost; they are not promotion evidence. Pairing on identical folds reduces misleading gains. A positive lead greater than two standard errors is a selection heuristic, not proof of global optimality. Batch clustering may fit on the unknown batch when the task contract permits it; scoring labels must not enter fit. Label-free diagnostics currently do not select a refittable champion.

## Code and contracts

[Training contract](../../harness/finetuned/docs/harness-owned-training.md), [TrainingService](../../harness/finetuned/agent/training/service.ts), [pairedPromotion](../../harness/finetuned/agent/training/promotion.ts), [worker](../../harness/finetuned/agent/training/python/worker.py).

## Revisit triggers

Revisit when a new task kind cannot express its execution/metric contract, when comparison uncertainty is inadequate, or when source identity/replay tests expose gaps. Add primitives and measurements before restricting model design.
