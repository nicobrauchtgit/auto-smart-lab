# Paper notes

Points to make in the write-up. Each note names its evidence; claims without
measurements are marked as expectations.

## Parallel exploration is limited by our hardware, not by the design

*Added 2026-11-11.*

The finetuned arm (v2, [expert-team-v2.md](../harness/finetuned/docs/expert-team-v2.md))
runs harness trials one at a time. Systems that explore several solution
candidates in parallel report strong results: CoMind (ICLR 2026) with
parallel exploration, and parallel subagents in Shen et al. (2026, preprint),
which gave the most valid improvements on broad sweeps. v2 leaves this out
because of the machine, not because the evidence is against it:

- **Compute:** 6 cores (13th-gen Intel i3), 15 GB RAM, 6 GB swap. Trials run
  their folds as harness worker processes on these cores, and one agent
  script reached 9.5 GiB on 2026-11-10 and filled swap. Parallel trials next
  to the agent's own scripts would compete for the same few cores and leave
  no memory headroom.
- **Model server:** not the bottleneck. MythLLM measured on 2026-11-09:
  1 request 50 tok/s; 8 concurrent requests 20 tok/s each, 151 tok/s total,
  without errors.

Expectation, not measured: on a machine with more cores and memory, parallel
candidate trials (several lead-proposed variants run at once, compared on the
same folds) should shorten time to a good model and widen the search at the
same wall-clock budget. Trials are already compared on shared, harness-owned
folds, so results from parallel workers stay comparable; the controller would
need a configurable worker count. A follow-up study could vary it on a larger
machine.

## Both arms stay on pi 0.84.1, not the newest release

*Added 2026-11-15.*

Both arms and both models run on the pinned pi 0.84.1 (`package.json`), released
2026-08-07. By 2026-11-15 pi had reached 1.5.2 (25 releases, including 1.0).
We did not upgrade, because of time and resources, not because the evidence is
against it:

- **Porting cost:** the finetuned arm's context hand-off
  (`harness/finetuned/agent/context/session.ts`) uses `agent.shouldStopAfterTurn`,
  removed in 0.87.0, and writes `agent.state.messages` directly, which no longer
  changes the request history since 0.87.0. Further breaking changes cover tool
  schemas, event types and the provider interface. Both arms would need porting
  and full retesting, including Leo's minimal arm.
- **Comparability:** all runs so far used 0.84.1. Upgrading mid-experiment would
  put units on different runtimes; upgrading only for one model would add a
  second difference besides the model.

Fixes in the newer releases that could matter for us (from pi's changelog; their
effect on our runs is not measured): Gemini on Vertex treated tool calls cut off
at the output limit as normal tool use (0.84.2), used unsupported thinking levels
(0.86.0) and sent unsupported `const` tool-schema keywords (1.5.0); token-refresh
retries on Vertex (1.4.0); LiteLLM/vLLM (MythLLM's stack) got fixes for an empty
tools list (1.5.1), context-overflow detection (1.5.0) and reasoning order
(1.3.0); compaction summaries no longer fail on long reasoning (1.4.0). The
1.5.2 catalog also lists `gemini-3.8-flash`, which we declare ourselves with the
same limits and prices.

Expectation, not measured: a run on the newest pi might be somewhat more robust,
mainly for Gemini tool calling and context hand-off; a follow-up could repeat a
unit on both versions.
