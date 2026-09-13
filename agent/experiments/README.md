# Experiment supervision

Optional module. Nothing in the registered pipeline receives these tools yet.
A caller opts in by creating a scope, binding the observed session, and
attaching the tools to it.

The design is [experiment-supervision.md](../../docs/experiment-supervision.md);
the measurements behind its numbers are in
[research/sklearn-observability/](../../docs/research/sklearn-observability/).

## Why it exists

In the Pi session model a tool call *is* ownership. A fit started inside one
lives and dies inside it, and the agent reaches no model-call boundary until the
call returns, so streaming output into it wakes nothing. A fit that converged at
iteration 3 of a configured 500 burns the rest anyway.

Here the agent holds an ID and the supervisor holds the process. Observation is
what it delivers; not blocking is why it has to exist.

This is the second of two layers, and the smaller one. The first is the agent
writing a fit that emits anything at all -- a loop over folds or `partial_fit`
batches with a labelled line per step -- which is runtime guidance in
[`agent/prompts/solve/observable-fits.md`](../prompts/solve/observable-fits.md),
not infrastructure. `MultinomialNB` inside a `Pipeline` emits nothing during
`fit` because there is no intermediate state to emit, and no supervisor can
change that.

## What is here

| File | What it does |
| --- | --- |
| `supervisor.ts` | Detached start, line drain to `runs/<task>/experiments/<id>/output.log`, sampling loop, process-group stop |
| `sampler.ts` | CPU and RSS for a process group through libproc |
| `updates.ts` | When to wake the agent, and the coalescer that bounds how often |
| `tools.ts` | `experiment_start`, `experiment_status`, `experiment_output`, `experiment_stop` |
| `index.ts` | The opt-in scope, and the single delivery channel |

There is no `experiment_watch`. Push through the session covers the same need
without a tool the agent sits in a loop calling; add one only if push delivery
proves insufficient.

The log file is the record. There is no event ledger and no typed event union:
lifecycle and decisions are mirrored through `StageReporter.event`, which already
carries the pipeline and invocation identity.

## Things that cost a session to rediscover

Each was measured on Darwin 25, Apple Silicon, scikit-learn 1.9.

- `ps -o time,rss,vsz` fails with `requires entitlement`. CPU and memory come
  from `proc_pidinfo` with `PROC_PIDTASKINFO`.
- Its CPU fields are mach ticks, not nanoseconds. The timebase is 125/3, so
  41.67 ns a tick. Read as nanoseconds, a pegged core reports 2.4% and every
  healthy fit looks deadlocked.
- `proc_listpgrppids` returns the **number of pids**, not a byte count. Treating
  it as bytes leaves a one-process group reading as an empty one, which looks
  exactly like a finished fit.
- Enumerating the group with `ps -o pid= -g` costs 3.6 ms because it forks; the
  libproc call costs under a microsecond. Sampling is free, so it runs at 250 ms
  and waking does not.
- Without `PYTHONUNBUFFERED=1` a child's stdout is block-buffered when it is not
  a tty, so `verbose` output arrives in 8 KB chunks or at exit -- reproducing
  the exact problem this module fixes.
- `kill(-pgid)`, never `kill(pid)`. `n_jobs > 1` means joblib workers, and
  killing the parent alone orphans them to burn CPU into the next trial.
- `steer()` delivers after the current turn's tool calls finish. It cannot
  interrupt a blocking call.

## The stall rule is derived, not fixed

The longest legitimate silence measured 6.2 s on `spam1` and 35.7 s on `spam2`,
which holds 5.5x the text. A threshold tuned on the first fires constantly on the
second; one tuned on the second sleeps through a real hang on the first. So the
threshold comes from the pilot's measured gap when the caller supplies one
(`expectedGapMs`), and otherwise from the gaps this run has already shown. The
first gap is excluded: it is scikit-learn importing, 1.6 to 1.9 s warm and 8.6 s
cold, and silent by nature.

Silence alone is never a stall. A deliberately deadlocked trial sat at 0% CPU
through 89.5 s of it; every working configuration sat between 56% and 105%, and
at 310% under `n_jobs=4`. Silence *at idle CPU* is the stall.

CPU proves liveness, not usefulness. A trial doing arithmetic that will be
discarded reads 105% and is indistinguishable from productive work. Process
telemetry rules out hangs; only the loss or validation series rules out waste.

## Verification

```bash
devbox run -- bun test agent/experiments
```

Every test spawns real processes and no test calls a model. The paid live check
described in the [build prompt](../../docs/supervisor-build-prompt.md) -- the
agent stopping a fit on its own evidence, a fit surviving a model turn and a
compaction, and trial results failing to promote a champion -- is not written
yet. Until it has run against both corpora, treat the transport as tested and
the agent's use of it as unestablished.
