# ADR 005: Isolation, sealed confirmation and prompt provenance

[Decision index](README.md) · [Architecture](../architecture.md)

## Status

Accepted; implemented boundaries with explicit limitations and planned strengthening.
**Amended 2026-11-11:** holdout feedback to the agent follows the Ladder
(decision below; planned in v2 P7b). Until then the current code keeps the
sealed score out of solve prompts, tools and mounted inputs.

## Context

Development labels are repeatedly inspected during search. Confirmation must not silently become another tuning target. Ambient repository guidance can also contaminate the arm comparison. Recovery needs evidence identity beyond mutable filenames.

## Decision

Use bubblewrap for agent file/shell boundaries, explicitly selected runtime prompts and typed inputs, with ambient AGENTS/CLAUDE loading disabled. Snapshot templates and rendered-message hashes once per run. Hide sealed rows and their labels from agents; admit sealed data to training only after terminal freeze. Record source, dependencies, seeds and artifacts separately from observational traces.

**Holdout feedback (2026-11-11).** The lead knows the withheld rows exist. When a trial becomes champion, the harness scores it on the withheld rows and tells the lead either "holdout confirms the improvement" with a rounded score, or "no significant improvement over the previous champion". This is the Ladder (Blum & Hardt, ICML 2015): a new score is revealed only when it beats the previous best by a significant margin, rounded. Labels are never shown and raw per-trial holdout scores are not shown. Every query is counted and recorded, and the hand-over states how often the holdout was used. See [expert-team-v2.md section 4](../../harness/finetuned/docs/expert-team-v2.md#4-feedback-to-the-lead).

## Alternatives considered

Prompt-only isolation cannot stop filesystem reads. Exposing all labels simplifies agent work but removes held-back evidence in the finetuned treatment. Showing the raw holdout score after every trial turns it into a second validation set the agent tunes against (Dwork et al., *Science* 2015). Never showing anything leaves the agent unable to tell whether its pipeline generalizes beyond the folds it tuned on. Re-loading mutable prompts on every retry makes recovery incomparable. Treating telemetry as authoritative state confuses observation with execution ownership.

## Consequences and tradeoffs

Langfuse is shared observability; durable trial/recovery records remain authoritative and JSONL tracing is emergency-only. The Ladder bounds but does not remove adaptive overfitting of the holdout; the query count makes its use visible. Today the reviewer can inspect confirmation and no automatic filter sanitizes controller guidance or knowledge. Binary confirmation exists; non-binary confirmation skips. Task-persistent sealed configuration and executable checks against immutable trial source are planned P6/P7 work. Minimal parent /proc environment access remains a credential-boundary limitation; neither prompt loading controls nor mount tests establish network isolation.

## Code and contracts

[Solve isolation](../../harness/finetuned/docs/solve-filesystem-isolation.md), [confirmation](../../harness/finetuned/docs/held-back-confirmation.md), [runSession](../../harness/finetuned/agent/run/session_runner.ts), [prompt loader](../../harness/finetuned/agent/prompts/loader.ts), [telemetry](../../harness/finetuned/docs/telemetry.md).

## Revisit triggers

Revisit when a new tool broadens filesystem/network access, raw holdout values appear in guidance, repeated task configuration changes split membership, or a resumed session cannot prove prompt/source identity. Keep fixture AGENTS marker regression tests whenever session construction changes.
