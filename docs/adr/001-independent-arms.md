# ADR 001: Independent arms and shared experiment conditions

[Decision index](README.md) · [Architecture](../architecture.md)

## Status

Accepted; implemented in `merge-arms`.

## Context

The study asks whether a minimal autonomous agent or a task-adapted harness performs better. Making their strategies identical would remove the treatment being compared. Earlier minimal runs used a different environment and are historical evidence, not matched trials.

## Decision

Keep code, configuration, docs and run state per arm. Share task material and root model/provider/online configuration. Preserve the minimal prompt without coaching. Report differences in label visibility, budgets, dependencies and learned memory as experimental conditions.

## Alternatives considered

One unified solver with flags would reduce code duplication but obscure treatment boundaries. Independent repositories would preserve separation but make shared conditions and boundary regression tests harder to inspect.

## Consequences and tradeoffs

Separation preserves reviewable treatments but duplicates some utilities and requires explicit dependency alignment. Comparable results require tasks both arms can run. Minimal fresh runs and finetuned persistent knowledge differ; reset and memory policies must be chosen before measurement. The shared model setting does not equalize all effective runtime behavior.

## Code and contracts

[Experiment](../experiment.md); implementation: [dispatch](../../experiment/cli.ts), [shared config](../../experiment/config.ts), [minimal confinement tests](../../experiment/minimal.test.ts).

## Revisit triggers

Revisit if arm isolation fails, base dependencies drift, or a measured protocol requires a different memory/reset policy. Repetitions, sequential versus parallel execution and instructor-score collection remain undecided.
