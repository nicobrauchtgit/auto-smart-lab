# Research stage redesign: decisions

Decided with the user on 2026-11-03 after the overnight spam1–3 queue
(`runs/overnight-spam-2026-11-02/`) stopped at research for all three tasks.
The work queue lives in [cleanup-plan.md](cleanup-plan.md); this file
records what was decided and why.

## What went wrong overnight

- A fixed 30-minute session timeout (`session.timeoutMs`) killed research
  sessions while the agent was still working, and the stage then failed the
  whole run. Partial work was discarded.
- Tools were not the bottleneck: 51 bash calls took 65 s in total.
- Model generation took 5,319 s across 63 requests. Overnight MythLLM decoded
  at a steady ~7 tok/s; latency ≈ 8 s + output tokens / 7 (R² = 0.92), with
  no dependence on input size.
- On 2026-11-03 the same API, our model adapter, and a bare pi session all ran
  at 61–76 tok/s, including with 13.5k input tokens and tools. The overnight
  slowness was most likely server load, not our code. The full instrumented
  session path has not been re-measured on a fast day.
- About 40% of generation time went into the agent writing 6–9 KB survey
  scripts (4–7 minutes each at 7 tok/s). Each task repeated the same survey.
- About 40% of output characters were hidden thinking, which the model emits
  even with `reasoning: false`. `chat_template_kwargs: {enable_thinking: false}`
  disables it; any change should be decided by an A/B comparison, not assumed.

## Decisions

1. **The harness computes the data profile.** The generic profile is
   deterministic and full-corpus, and its records can be cited. Following AIDE,
   which generates its data preview in the harness, the agent stops rewriting
   the survey for every task.
   - The generic layer covers all tasks: per-split inventory, size
     distributions, target counts, content type by magic bytes and encoding,
     exact duplicates within and across splits, label leakage through member
     names or order, and training-vs-test comparisons.
   - A format layer is added only when tasks need it. Text comes first, for
     spam.
   - Domain analysis stays with the agent.
2. **Research produces a short solution brief, not a survey report.** The
   main limit is the number of routes, not bytes: one recommended pipeline
   tailored to the dataset, at most two ranked alternates, and a few atomic
   next improvements. A byte cap remains only as a loose safety limit. If a
   brief is too long, feedback asks the agent to condense it, and the run
   continues.
3. **Sources are required so the harness can check them.** The citation
   format does not matter. A source is anything the harness can resolve: a
   profile record, an artifact path, or a URL. The checks:
   - the source exists;
   - numbers in a claim appear in the cited file;
   - each URL was returned by this run's `web_search`.

   The agent gets a self-check tool that runs the same checker before it
   stops. The current claim-audit prose, the Measured/Sampled labels, and the
   separate test-pass prose rules are dropped.
4. **Solve starts from the brief.** Solve fits the recommended pipeline as
   its baseline, compares the alternates on the harness hold-out, and keeps
   what wins. Research suggests; harness measurements decide. This already
   matches [the harness-owned training contract](harness-owned-training.md).
5. **The research budget counts actions, not wall time or output tokens.**
   Output size depends on the task, and API speed varies. The budget is a
   fixed number of tool calls and model turns, shown to the agent after each
   tool call, with tiered guidance (Budget Tracker / BATS). When the budget
   runs out, tools are blocked, the agent gets one final turn to write the
   brief, and the stage ends as `complete` or `partial`. Running out of
   budget never fails the run; solve continues with known gaps.
6. **Wall time only detects stalls.** A request with no streamed tokens for
   N minutes is retried a bounded number of times. A slow but progressing
   request is never killed. `session.timeoutMs` becomes a safety limit only.
7. **The orchestrator decides when to research again.** When solve
   plateaus, the orchestrator may start another research round with a
   different focus, for example features, data representation, or model
   family. This is not a strict rule: the orchestrator decides, guided by
   few-shot examples such as "no gain beyond CV noise for 3 trials, all
   routes tried, so research features next". It receives trial history, CV
   spread, routes tried and remaining, and the budget, and it records its
   reason for each decision.
   - A new round gets a typed diagnosis of what was tried and must propose
     routes not already in the experiment history.
   - Rounds are bounded by the existing orchestrator budgets.

## Defaults and how to defend them

The specific counts are not established by published findings:

- MLE-STAR's settings (4 retrieved models, 4×4 refinement loops) were never
  compared against alternatives.
- AIDE's "3–5 sentence" plans and "single atomic improvement" are prompt
  design.
- Only the direction has evidence: models follow fewer instructions more
  reliably (IFScale).

Treat the counts as configurable defaults borrowed from current systems, and
compare them on our own tasks: 1 route vs 1 + 2 alternates vs an open list,
scored by harness hold-out results on spam1–3.

## Evidence used

- Budget Tracker / BATS, arXiv 2511.17006: agents that see their budget used
  far fewer calls for the same accuracy; continue/pivot with summaries.
- MLE-STAR, arXiv 2506.15692: web-retrieved candidates, evaluated on a
  hold-out, merged when they help; ablation-guided refinement; leakage
  checker.
- AIDE, arXiv 2502.13138 and the `WecoAI/aideml` prompts: harness data
  preview, short plans, atomic improvements.
- R&D-Agent, arXiv 2505.14738v2: alternating research and development;
  adaptive branching beat a simple chain (35.1% vs 25.3% any medal).
- KompeteAI, arXiv 2508.10177: external ideas widen the search space.
- AIRA-dojo, arXiv 2507.02554: operator quality matters more than search
  policy; validation-test gaps mislead search.
- IFScale, arXiv 2507.11538: adherence falls as instruction count rises.
- Liu et al., arXiv 2304.09848: only 51.5% of cited sentences were fully
  supported, and 74.5% of citations backed their sentence.
- ALCE, arXiv 2305.14627: the best models lacked complete citation support
  50% of the time on one dataset.
- Walters & Wilder, Scientific Reports 2023: 55% (GPT-3.5) and 18% (GPT-4)
  of references were fabricated.
- CRITIC, ICLR 2024: correction works with external, tool-based checks;
  self-verification alone is unreliable.
