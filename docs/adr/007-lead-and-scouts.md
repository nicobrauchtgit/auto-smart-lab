# ADR 007: One lead agent with blocking scouts

[Decision index](README.md) · [Architecture](../architecture.md)

## Status

Accepted by the user on 2026-11-11. Not implemented yet. The orchestrator, the
research and evaluate stages and the knowledge store were removed on
2026-11-11; the remaining code runs solve, then refit, until P7 lands. Supersedes [ADR 006](006-shared-expert-workspace.md) and the scheduling
part of [ADR 003](003-finite-ram-observation.md); amends
[ADR 004](004-durable-controller.md) and [ADR 005](005-isolation-confirmation-provenance.md).

## Context

The observed finetuned spam1 run of 2026-11-10/11 took 9 h 06 min to hand-over;
the minimal arm took 46 / 17 / 15 min on spam1 / spam2 / spam3. Research had a
0.990 TF-IDF + logistic-regression result after 20 minutes; solve rebuilt the
same family over 4 hours, and a follow-up spent another 4 hours on C=10 versus
C=1. Controller hand-offs failed three times on stage gates, and a follow-up
inherited an exhausted budget and hung
([batch report](../experiments/spam-2026-11-11.md)).

The papers point the same way. In about 4,000 controlled ablations (Kim et al.,
ICML 2026) a fixed Explorer → Builder → Evaluator relay scored 8.3–8.5
percentile points below one iterating agent, with 38% of its failures from
coordination; iteration count mattered most. Multi-agent designs helped with
parallel breadth and independent checks under central control (preprints;
CoMind, MLE-STAR). LLM evaluators favour their own outputs (Panickssery et al.,
NeurIPS 2024). Sources and limits:
[expert-team-v2.md section 1](../../harness/finetuned/docs/expert-team-v2.md#1-why-the-design-changes).

## Decision

- One **lead agent** drives the run. It writes the pipeline, starts harness
  trials, reads their feedback and decides when to hand over.
- **Scouts** for data, ideas and validation are subagents the lead calls; the
  lead is blocked until they answer. They return short bullets with sources,
  no pipeline, no code. They are built on `agent/subagents/`.
- No LLM orchestrator, no fixed research → solve → evaluate chain, no research
  brief or `check_brief`.
- Budgets are tool calls for every agent, with a counter after every call:
  lead 80, data 15, ideas 10, validation 10 to start. Prefer more iterations
  over more upfront research: short scout runs, then targeted scout calls
  guided by trial results.
- Holdout feedback uses the Ladder on new champions ([ADR 005](005-isolation-confirmation-provenance.md)).
- Every agent gets the task text and the unit introduction. The label in
  training file names is a stated task fact; the filename-leakage canary is
  dropped.
- The harness keeps seeds, folds, fits, predictions, the noise rule for
  promotion, clean commits per trial and the terminal refit
  ([ADR 002](002-model-freedom-evidence.md)).

## Alternatives considered

Implementing the accepted four-expert design (ADR 006) keeps a relay of roles
with document hand-offs, which is what failed in spam1 and in the controlled
study. A single agent without scouts loses clean context and an independent
check of its result. Parallel independent agents amplify errors without central
control.

## Consequences and tradeoffs

The run has no fixed phase order, so comparisons rely on harness records and
tool-call counts rather than stage boundaries. The lead's context holds scout
bullets but not their transcripts. Tool calls do not bound compute; global
supervision (v2 section 6) reports time-wasting calls instead. Starting budgets
are open until measured; the knowledge store was dropped. The case
against a fixed relay rests on one peer-reviewed controlled study, a
peer-reviewed failure taxonomy, preprints and one run per arm.

## Code and contracts

[expert-team-v2.md](../../harness/finetuned/docs/expert-team-v2.md), [contract appendix](../../harness/finetuned/docs/expert-team.md), [subagents](../../harness/finetuned/agent/subagents/README.md), [work queue](../cleanup-plan.md).

## Revisit triggers

Revisit after the integration gate (spam1–3 against the minimal arm's numbers),
after the scout budget test, or if the lead repeatedly stalls without using
scouts or trials.
