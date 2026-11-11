# ADR 006: One expert workspace and restrained concurrency

[Decision index](README.md) · [Architecture](../architecture.md)

## Status

Superseded on 2026-11-11 by [ADR 007](007-lead-and-scouts.md). The four
experts and their scheduling rules (at most one code writer, literature
overlapping) were never implemented and are dropped. Kept from this record:
one versioned solutions tree shared by all agents, follow-up branches from the
champion, immutable trial snapshots as the basis of validation, and the
append-only findings journal; their contracts are in
[expert-team.md](../../harness/finetuned/docs/expert-team.md).

## Context

Research and solve duplicated loaders and substantial scripts in separate folders. Independent expert worktrees would recreate separate working areas and require harness merge machinery. The host has finite cores/RAM even if the remote provider benefits from concurrent requests.

## Decision

Use one versioned solutions checkout and one sandbox for data, literature, modelling and validation experts. Permit at most one code-writing expert (data/modelling/validation) at a time. Literature has read/search tools, no shell/write tools, and may overlap one writer. Reuse existing modules and an append-only findings journal with evidence references; keep follow-up branches from the champion. Trials and terminal refit remain harness-owned.

## Alternatives considered

One worktree per expert permits independent edits but reintroduces fragmented code and merges. All experts concurrently writing one checkout risks conflicting edits and invalid evidence snapshots. A single undifferentiated agent removes role boundaries and makes collaboration harder to inspect.

## Consequences and tradeoffs

The chosen policy limits apparent parallelism but makes code ownership understandable. Immutable trial snapshots must remain the basis of validation despite later checkout edits. Findings do not automatically become authoritative facts. Shared persisted code/knowledge can reduce work on later tasks, but that cross-task learned memory is an experimental variable, separate from context tokens and RAM. P9 memory reuse is further work. P7c label-free unscored hand-over and evidence labels are proposals within the accepted roadmap, not existing capabilities.

## Code and contracts

[contract appendix](../../harness/finetuned/docs/expert-team.md), [current stage registry](../../harness/finetuned/agent/pipeline/registry.ts), [follow-up branches](../../harness/finetuned/agent/training/branches.ts).

## Revisit triggers

Revisit only with evidence of safe independent writers, a need for distributed workspaces, or task measurements showing the concurrency policy is the bottleneck. Gate implementation with source-bound validation, sealed-data boundaries, session-local environment and measured spam/clustering/label-free hand-over checks.
