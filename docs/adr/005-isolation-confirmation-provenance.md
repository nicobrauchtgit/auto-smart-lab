# ADR 005: Isolation, sealed confirmation and prompt provenance

[Decision index](README.md) · [Architecture](../architecture.md)

## Status

Accepted; implemented boundaries with explicit limitations and planned strengthening.

## Context

Development labels are repeatedly inspected during search. Confirmation must not silently become another tuning target. Ambient repository guidance can also contaminate the arm comparison. Recovery needs evidence identity beyond mutable filenames.

## Decision

Use bubblewrap for agent file/shell boundaries, explicitly selected runtime prompts and typed inputs, with ambient AGENTS/CLAUDE loading disabled. Snapshot templates and rendered-message hashes once per run. Hide sealed rows/labels from agents; use the frozen champion for controller-owned confirmation, and admit sealed data to training only after terminal freeze. Record source, dependencies, seeds and artifacts separately from observational traces.

## Alternatives considered

Prompt-only isolation cannot stop filesystem reads. Exposing all labels simplifies agent work but removes held-back evidence in the finetuned treatment. Re-loading mutable prompts on every retry makes recovery incomparable. Treating telemetry as authoritative state confuses observation with execution ownership.

## Consequences and tradeoffs

Langfuse is shared observability; durable trial/recovery records remain authoritative and JSONL tracing is emergency-only. Current reviewer can inspect confirmation, while the planned validation expert cannot. No automatic filter sanitizes controller guidance or knowledge: the prohibition on sealed-derived guidance is instructional. Binary confirmation exists; non-binary confirmation skips. Task-persistent sealed configuration and executable checks against immutable trial source are planned P6/P7 work. Minimal parent /proc environment access remains a credential-boundary limitation; neither prompt loading controls nor mount tests establish network isolation.

## Code and contracts

[Solve isolation](../../harness/finetuned/docs/solve-filesystem-isolation.md), [confirmation](../../harness/finetuned/docs/held-back-confirmation.md), [runSession](../../harness/finetuned/agent/run/session_runner.ts), [prompt loader](../../harness/finetuned/agent/prompts/loader.ts), [telemetry](../../harness/finetuned/docs/telemetry.md).

## Revisit triggers

Revisit when a new tool broadens filesystem/network access, sealed disclosure appears in guidance, repeated task configuration changes split membership, or a resumed session cannot prove prompt/source identity. Keep fixture AGENTS marker regression tests whenever session construction changes.
