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
