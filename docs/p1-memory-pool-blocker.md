# P1: unresolved memory victim ordering

Recorded 2026-11-10. **Not integrated into `merge-arms`.** This is an investigation
result and merge-scope decision, not an implemented resource guarantee.

## Required behavior

The accepted P1 design calls for one capped, swap-free pool for agent scripts
and harness trials, reserving RAM for the harness and system. Scripts may use
idle capacity. When the pool fills, the largest script must be reclaimed before
a trial is killed, including when both allocate concurrently. The requirement
concerns process execution memory; it is separate from context-window budgets
and reusable knowledge across tasks.

## Evidence

The P1 continuation is `t3/protect-trials-under-pool-pressure` at
`eee18944584796cedc403c92fd49ab2acbaa3db5`. Its complete report is
`harness/finetuned/agent/experiments/memory-protection-investigation.md` on that
branch; its source and diagnostics are retained for review.

On the tested host (Linux 6.18.60, systemd 262, cgroup v2, UID 1000 without
effective capabilities), concurrent workers filled private 300 MiB test pools.
A trial of about 210 MiB was killed while a script of about 90–95 MiB survived
under each tested approach: OOM score bias, trial `memory.min` with script OOM
grouping, and parent `memory.high`. The harness test runner survived outside the
private pool. These are counterexamples to the required guarantee, not a claim
about every possible operating-system policy.

Writing `oom_score_adj=-1000` directly was denied. A systemd user service that
requested it ran with an observed value of 100. A successful property request
does not establish worker protection. A privileged broker or different kernel
policy would need design, implementation and verification; merely installing
one or permanently excluding trials from OOM does not establish largest-script
selection and safe behavior once only trials remain.

The acceptance regression remains skipped as a known failure. Passing diagnostic
tests must not be reported as passing victim-order acceptance. Other work did
measure crash cleanup (five scope members before harness SIGKILL, zero afterward)
and bounded retained output (16,380 of 198,890 logged bytes). Those results do
not repair ordering.

## Current merge consequence

The continuation refuses production setup and direct pool launches before
creating scopes. This prevents a false protection claim, but would also stop
research/solve on this machine if merged as the default. It is not integrated
and is not an operational P1 completion. The current branch retains its earlier
runtime and its known resource limitations.

The user has been asked to choose the merge scope:

- Defer P1 and review/merge the existing runtime, P3 recovery improvements and
  documentation, retaining strict P1 acceptance for later.
- Explicitly accept a bounded pool with best-effort trial priority and document
  the remaining risk. This changes the accepted guarantee and needs a separate
  implementation/review pass; the fail-closed branch cannot simply be merged.
- Keep the merge blocked until an enforcing mechanism is implemented and
  independently pressure-tested.

Until that choice, P1 is a blocker for a merge scope that includes completed
P1, rather than a smaller issue silently moved to the follow-up list.

## Completion evidence for strict P1

An implementation must establish protection before worker execution, cover
descendants, define largest process versus largest scope, reclaim the selected
script before further trial allocations can defeat the order, and handle the
trials-only case. Tests must cover inverted sizes, multiple scripts, concurrent
allocation, trial fallback, harness survival, owner death and bounded output.
Ancestor/global memory limits also need attention: a local pool cap alone does
not prove that the surrounding machine has available RAM.

See the [current queue](cleanup-plan.md), [design requirements](redesign-plan.md)
and [expert-team design](../harness/finetuned/docs/expert-team.md).
