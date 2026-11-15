# Tool-call budget policy and prompt ownership

2026-11-13. Prompt change plus research review; no live model run. This does
not implement [completion fallback](../completion-reliability-plan.md).

## Implemented prompt change

`team.lead-system` is the single owner of the lead's budget and finishing
policy. It is supplied from the first session and retained in every context
replacement. It says to plan delivery before optional improvement, reserve
capacity for validation/repair/commit/smoke/remeasurement, and finalize before
exhaustion. Free hand-over does not imply free repair calls. It makes no promise
of extra calls or fallback behavior that the runtime does not implement.

The context handoff asks for unfinished work and artifact references without
copying standing system instructions. The hand-over tool describes its API,
including the 1,000-character reason limit. Checkpoint feedback states the
milestone without directing indefinite improvement; exhaustion feedback reports
the state and refers to the base policy. The follow-up prompt no longer promises
that an unsuccessful round loses nothing. Factual counters and progress remain.

The real scripted context-replacement test checks that both sessions have the
same system prompt, the policy appears once there, and handoff messages do not
carry another copy. The checkpoint regression checks factual acceptance rather
than the removed imperative. These checks establish prompt wiring, not that
the experimental model will reliably reserve calls.

No accounting semantics changed: ordinary emitted tool calls, including reads
and rejected calls, still count. `hand_over` retains its existing exemption.
No hidden ten-call extension or free shell inspection was added.

Verification: `./dev bun run test:fast` passed (575 passed, two platform-specific
skips, zero failed; 132.42 seconds), including prompt loading, context replacement,
checkpoint, admission and isolation regressions. `./dev bun run typecheck` and
`./dev git diff --check` passed. No full-suite or live-model outcome is claimed;
this change is not merged.

## What research actually budgets

These are primary papers. The versions examined below are **preprints**; their
findings concern their reported tasks, not this ML-development harness.

- Liu et al., [Budget-Aware Tool-Use Enables Effective Agent Scaling,
  v1](https://arxiv.org/html/2511.17006v1), §§2–3: separate caps for search and
  browse, updated budget feedback, and a separate cost metric combining tokens
  with API costs. Budget awareness helped their search agents; simply providing
  more calls did not ensure effective scaling. This supports visible accounting,
  not a universal equal charge for every possible tool.
- Liu et al., [Budget-Constrained Agentic Large Language Models: Intention-Based
  Planning for Costly Tool Use,
  v1](https://arxiv.org/html/2602.11541v1), §§1–2: tools have individual monetary
  prices under a total spending constraint. Their cost-augmented StableToolBench
  results show that per-call budget feedback alone does not ensure feasibility.
- McCleary and Ghawaly, [Quantifying the Accuracy and Cost Impact of Design
  Decisions in Budget-Constrained Agentic LLM Search,
  v1](https://arxiv.org/html/2603.08877v1), §3.3: separate search-call and token
  allowances, with search disabled at its cap. The accounting unit is the scarce
  resource being studied, not a rule that all operations have identical cost.

There is no uniform research convention that puts every activity into one
flat counter. Tool calls, search queries, completion tokens and monetary costs
are different constraints. The papers reviewed here do not test free `head`/
`tail` in a shell-enabled coding agent, or a hidden repair-call extension after
failed final validation. They supply no direct evidence that either proposal
would solve this repository's completion failure.

## Recommendation for this repository

**Keep accounting simple while fixing completion selection.** Continue to show
budget state; the runtime must preserve a valid delivery candidate even when
the model plans badly. Better wording is not a replacement for that repair.

**Do not add a hidden bonus now.** The concern is not demonstrated abuse by this
model. It is that failed validation would become a trigger for extra resources,
the advertised total would cease to describe the actual allowance, and retries
would need additional persistence and admission rules. If later justified, use
one explicit harness-controlled repair phase for a verified defect, with no new
exploration and a durable bound across restart. A transparent reserve within the
declared budget is easier to reason about than an undisclosed extension. Its
size would still need measurement; ten calls is not a research-established value.

**Do not exempt shell calls by the words `head` or `tail`.** Commands can execute
a fit and pipe it through `tail`; observed runs already did that. Parsing shell
syntax to infer cheap inspection would add an unreliable second execution
classifier. Existing typed read-only file tools provide a clearer capability
boundary, but making even those unlimited would leave model/token/latency costs
unbounded by the call counter. Differential charging could be tested later
under a hard global bound, without making arbitrary bash free.

If accounting is revisited, compare cost per verified delivery, elapsed time,
model tokens, executed tool calls and completion failures under fixed tasks and
conditions. Do not compare a hidden 90-call run to an advertised 80-call run as
if their resources were equal. This is an evaluation proposal, not authorization
for another task run or a claim that a weighted system will improve results.
