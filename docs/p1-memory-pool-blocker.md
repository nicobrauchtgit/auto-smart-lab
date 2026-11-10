# P1: unresolved memory victim ordering

Recorded 2026-11-10. **Deferred from the integration on local `main` by the user.**
This is an investigation result and scope decision, not an implemented resource guarantee.

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

On 2026-11-10 the user chose to **defer P1 and prepare the existing runnable code
and documentation for merge**. P3 recovery improvements, P4 scorecard and P5
design remain in scope. P1's strict acceptance requirement remains for future
work; best-effort victim ordering was not accepted as a substitute. Neither its
resource implementation nor its unconditional production guard is integrated.

The remaining resource limitations are explicit follow-ups for this merge.
Deferral is not evidence that P1 passed or that current research/solve scripts
have its proposed observation, Linux sampling or shared memory protection.

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
