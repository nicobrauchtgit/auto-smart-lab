# Architecture decision records

[Work queue](../cleanup-plan.md) · [Architecture](../architecture.md) · [Expert team v2](../../harness/finetuned/docs/expert-team-v2.md)

These records explain choices taken with the user and distinguish decisions
from delivered code. "Accepted" does not mean implementation or live
validation is complete. On 2026-11-11 the user accepted v2 (ADR 007): one lead
agent with blocking scouts replaces the four-expert design and the LLM
orchestrator. It is not implemented yet; the old orchestrator, research and
evaluate stages and knowledge store were removed on 2026-11-11.

| ADR | Decision | Current status |
| --- | --- | --- |
| [001](001-independent-arms.md) | Independent arms and shared experiment conditions | Accepted; implemented |
| [002](002-model-freedom-evidence.md) | Agent-owned design, harness-owned execution and evidence | Accepted; implemented, with task-adapter limitations |
| [003](003-finite-ram-observation.md) | Finite RAM, observation and flexible modelling | Superseded by v2 section 6 (global supervision, own sampler); P1 pool dropped |
| [004](004-durable-controller.md) | Durable controller, event-driven waits and budget-end hand-over | Accepted; P3 integrated. LLM controller retired in v2 P7b; durable state and budget-end hand-over stay |
| [005](005-isolation-confirmation-provenance.md) | Isolation, sealed confirmation and prompt provenance | Accepted; holdout feedback amended to the Ladder (planned) |
| [006](006-shared-expert-workspace.md) | One expert workspace and restrained concurrency | Superseded by ADR 007; shared tree, snapshots and journal kept |
| [007](007-lead-and-scouts.md) | One lead agent with blocking scouts | Accepted 2026-11-11; implementation planned in P6/P7 |

The design philosophy is to provide trustworthy execution primitives and observations while preserving the agent's choices of features, model and experiments. Resource limits describe the machine, not a preferred estimator. Evidence authority comes from harness records, not agent confidence. Recovery, prompt provenance and isolation make behavior reviewable; advisory review remains separate from authorization to submit.

Repetitions, reset/carryover and arm sequencing for measured comparison are still undecided (F2 in the [work queue](../cleanup-plan.md)); do not infer them from these ADRs.
