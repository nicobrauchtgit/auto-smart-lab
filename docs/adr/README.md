# Architecture decision records

[Review guide](../review-guide.md) · [Architecture](../architecture.md) · [Active redesign](../redesign-plan.md)

These records explain choices taken with the user and distinguish decisions
from delivered code. “Accepted design” does not mean implementation or live
validation is complete. P3 is integrated; the user explicitly deferred P1 from
this merge. The expert team remains a design. Current source metrics and
validation are in the [inventory](../code-inventory.md) and
[merge evidence](../merge-readiness.md).

| ADR | Decision | Current status |
| --- | --- | --- |
| [001](001-independent-arms.md) | Independent arms and shared experiment conditions | Accepted; implemented |
| [002](002-model-freedom-evidence.md) | Agent-owned design, harness-owned execution and evidence | Accepted; implemented, with task-adapter limitations. |
| [003](003-finite-ram-observation.md) | Finite RAM, observation and flexible modelling | Accepted design; P1 deferred, strict future acceptance retained |
| [004](004-durable-controller.md) | Durable controller, event-driven waits and budget-end hand-over | Accepted; P3 integrated in fd96ccd and local whole-branch validation passed; live shakedown remains |
| [005](005-isolation-confirmation-provenance.md) | Isolation, sealed confirmation and prompt provenance | Accepted; implemented boundaries with explicit limitations and planned strengthening. |
| [006](006-shared-expert-workspace.md) | One expert workspace and restrained concurrency | Accepted design; implementation planned in P6/P7. The four experts are not current runtime. |

The design philosophy is to provide trustworthy execution primitives and observations while preserving the agent's choices of features, model and experiments. Resource limits describe the machine, not a preferred estimator. Evidence authority comes from harness records, not agent confidence. Recovery, prompt provenance and isolation make behavior reviewable; advisory model review remains separate from authorization to submit.

Deferred proposals include P7c's unscored/evidence-labelled hand-over, P8's lighter action interface and P9's evidence-backed reuse. See the active redesign for their acceptance gates. Repetitions, reset/carryover and arm sequencing for measured comparison are still undecided; do not infer them from these ADRs.
