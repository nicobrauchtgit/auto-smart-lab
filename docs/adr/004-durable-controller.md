# ADR 004: Durable controller, event-driven waits and budget-end hand-over

[Decision index](README.md) · [Architecture](../architecture.md)

## Status

Accepted; durable controller and P3 run mechanics are implemented in
this integration (P3 fd96ccd, carried by the reviewed `merge-arms` branch). Source metrics identify their exact input
bytes in the [generated inventory](../code-inventory.md).

## Context

Long tasks outlive model sessions and can be interrupted. Repeating a mutation after a crash can duplicate work or uploads. Waiting should not consume one model request per minute. Budget exhaustion should preserve a valid champion rather than discard completed work.

## Decision

Persist immutable run/task/config/prompt identity, action IDs/revisions, accounting and artifact lineage. Resume through verified ownership and reconciliation. Wait for stage events and deadlines rather than model polling. Integrated P3 behavior charges trials when they start and releases unused reservations; at budget end it settles work and deterministically refits an unhanded champion, without uploading. Explicit caller cancellation stays cancellation.

## Alternatives considered

An in-memory chat loop is simpler but loses ownership and idempotency. Periodic decision calls consume provider budget without new evidence. Killing everything on deadline is simple but can waste the only selected result. Automatically uploading at deadline exceeds authorization.

## Consequences and tradeoffs

Atomic local state and locks provide cooperative durability, not distributed consensus or security against a host rewriting all state. Unknown submission outcomes remain reserved and reconcile read-only. The 6901a54 source snapshot charged solve allocations up front and included 50%/20% notices. Current P3 fd96ccd removes those notices, charges launched workers, adds terminal hand-over and detached progress, and refuses incompatible persisted harness-run versions. Its final fixes reconcile frozen champions, avoid charging pre-spawn failures and recover budget-end refits across deadlines. Parent reports 61 focused tests passing. Terminal refit may finish beyond the controller deadline by design. No successful live shakedown is established by the existence of these mechanisms.

## Code and contracts

[Coordinator](../../harness/finetuned/agent/orchestrator/coordinator.ts), [state](../../harness/finetuned/agent/orchestrator/state.ts), [run loop](../../harness/finetuned/agent/orchestrator/run.ts), [controller contract](../../harness/finetuned/agent/orchestrator/README.md).

## Revisit triggers

Revisit on journal/state inconsistency, double effects, unreconciled workers, provider-level retry ambiguity or a need for distributed scheduling. After final integration, verify constant decision-request count for short/long fake stages, interrupted trial accounting and a real budget-end delivery.
