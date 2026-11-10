# Redesign plan: a team of expert agents

Written 2026-11-10. This is the active plan for the finetuned arm
(`harness/finetuned/`). It replaces the "next steps" list in
[cleanup-plan.md](cleanup-plan.md) until it is finished.

## Goal

A collaborative, multi-stage environment: expert agents, one per field, build
the best pipeline for a dataset together. They share one workspace, reuse each
other's code and stop at the right time.

## Why (what two spam1 runs on 2026-11-09 showed)

- Research wrote 742 lines of scripts in its own folder, solve wrote 358 lines
  in a scratch folder with its own data loader. One file reached `solutions/`.
- Model selection happened three times (research, the orchestrator's guidance
  asking research for baselines, solve's local grid). Only harness trials count,
  and solve needed 57 minutes before its first one.
- Two research scripts took 9 GB each and stalled the machine. Nothing observed
  them. The process sampler only works on macOS; on this Linux machine it
  reports nothing, for harness training as well.
- The orchestrator made one model request per minute while waiting.
- A killed run lost the stage's work; each solve was charged 6 trials whether it
  ran them or not; running out of budget cancelled the run without a hand-over.
- No run has reached review, refit or a hand-over under the orchestrator.

## Decisions (taken with the user)

1. **Four experts** replace research, solve and review:
   - data: what is in the dataset; writes the shared loading code;
   - literature: what to try and why (best practices, algorithms, architecture
     level at most), from external sources; no model fitting;
   - modelling: builds the pipeline and tests ideas through harness trials;
   - validation: checks code and evidence, and can run checks itself.
2. **What and why, never how** for research-type work. Code only for short
   checks and for looking into the dataset. No model comparison outside harness
   trials.
3. **One shared workspace**: all agents work in the versioned `solutions/`
   under one sandbox. Code is modular, readable and encapsulated; nothing is
   written twice; existing code is searched and extended first.
4. **Sealed rows**: no agent sees them. The orchestrator sees the sealed
   numbers; they never go into guidance for experts.
5. **Harness-run trials stay** the only evidence. The rest of the safety
   machinery is simplified for offline runs.
6. **No time kills.** Processes are observed and the agent is woken by rules
   (exit, error output, stuck, memory), as decided in
   [experiment-supervision.md](../harness/finetuned/docs/experiment-supervision.md).
   This now covers the agents' own scripts too ("run observed").
7. **One shared memory pool** for all agent scripts and harness trials. Its cap
   is the machine's RAM minus a reserve for the harness and the system. A kill
   happens only when the pool is full, and takes the biggest process; trials go
   last. The agent is woken before that and told the reason after a kill.
8. **The orchestrator never polls.** It sleeps until a stage gives it input.
9. **Parallel experts are allowed** where their work is independent. The model
   server scales (1 request: 50 tokens/s; 8 at once: 20 each, 152 total). The
   machine has 6 cores (fixed) and 15 GB RAM (can grow), so at most one of two
   parallel experts should compute heavily.
10. A filename suffix that states the label, as the task description says, is
    not a leak. Prompt examples must not produce such findings.

## What a good spam1 run looks like

spam1 is simple. A hand-made reference
([redesign-spam1-reference.py](redesign-spam1-reference.py): binary TF-IDF on word unigrams with a
linear SVM, 5-fold stratified CV, about 30 lines of code) gives:

| Measure | Reference |
| --- | --- |
| Balanced accuracy (CV) | 0.9944 (unigrams) to 0.9954 (uni+bigrams) |
| Compute for three candidates | 42 seconds |
| Peak memory | 0.5 GB |

A good pipeline run on spam1 therefore shows:

| # | Indicator | Target |
| --- | --- | --- |
| 1 | It realises a simple model is enough | Champion is a linear model on TF-IDF-like features; CV balanced accuracy ≥ 0.994 |
| 2 | It finishes at the right time | Hand-over within 45 minutes (aim: 30); at most one follow-up round; at most 8 harness trials |
| 3 | It verifies well | At least one full promotion trial; the sealed check ran and agrees with CV within noise; the validation expert's checks are recorded |
| 4 | It gives the measurements | Hand-over files exist (15,051 predictions); stage reports and the scorecard list scores, times and memory |
| 5 | It reuses and modularises | Data loading exists once in `solutions/` and is imported by everything else; no agent Python outside `solutions/`; the index lists every module |
| 6 | It costs little | First harness trial within 10 minutes of the modelling expert's start; no model requests by the orchestrator while it waits; no script above 2 GB |
| 7 | It gets faster with memory | A second run on spam1, or a run on spam2 after spam1, imports the existing loader and needs fewer model requests |

`P4` builds the scorecard that measures these from a finished run.

## Work packages

Each package is implemented by one subagent in its own checkout, reviewed by a
second subagent, and merged into `merge-arms`. A wave ends with a spam1 run and
its scorecard. Nothing new is added while a wave's run does not reach a
hand-over.

### Wave 1 (parallel)

**P1. Observed scripts and the memory pool**

- Linux process sampling (CPU, memory, per process group) next to the macOS one
  in `agent/experiments/sampler.ts`.
- The shared memory pool: a systemd user slice with `MemoryMax` = RAM minus a
  configured reserve and no swap. Agent scripts and harness training workers
  start inside it; trials are killed last and get CPU priority over agent
  scripts. After a kill the harness reports the reason and the peak memory.
  A setup check declares the prerequisite.
- Run observed: a shell command that finishes quickly returns as today, with
  its duration, peak memory and CPU time. One that keeps running is handed to
  the supervisor: the call returns an ID and the output so far, and the agent is
  woken by rules (exit, error output, stuck, memory share of the pool). It can
  read output and stop the process. Research and solve sessions get this.
- Remove the research bash timeout (prompt sentence, config key, budget clamp).
- One shared prompt tells agents the machine (cores, pool size) and how to write
  code it can handle (plain lists instead of NumPy string arrays, sparse
  matrices, sample first, few parallel jobs, progress lines, no large files in
  `/tmp`).
- Measurable tests:
  - a busy loop samples near 100% CPU, a sleeping process near 0%, and a process
    holding 200 MB within 10% of that;
  - under a small test pool, a script that exceeds it is killed, the tool result
    names memory as the reason with the peak, and the harness process and a
    protected "trial" process survive;
  - `sleep 1` returns directly; a 30-second script returns an ID first and wakes
    the session on exit; a silent idle process is reported as stuck; a growing
    one produces the memory wake before the kill;
  - the spam1 reference script reports about 0.5 GB and its duration.

**P3. Run mechanics**

- `pipeline_wait` blocks until a stage result or the deadline. No periodic or
  percentage wakes (remove the 50%/20% notices in the working tree).
- Trials are charged when they run. An interrupted solve releases its
  reservation.
- When the budget ends (deadline, counters, or the decision agent stops) and a
  champion exists that was not handed over, the harness runs the terminal refit
  itself and reports "handed over at budget end". Exhausted counters no longer
  burn retries in a loop.
- A run can start detached from the terminal and prints one progress line per
  event (stage started, finished with outcome and duration, hand-over).
- Measurable tests:
  - with a fake stage lasting N seconds the orchestrator makes the same number
    of model requests for N = 1 and N = 30;
  - the trial counter equals the trials actually run, also after an interrupted
    solve;
  - a run that hits its deadline with a champion ends with hand-over files;
  - a detached run survives its launching shell and its log shows the progress
    lines.

**P4. Scorecard**

- A command that reads one finished finetuned run and prints the indicators
  above with pass or fail against targets kept in a small JSON file per task
  (spam1 first), plus the plain numbers: times per stage, time to first trial,
  model requests, trials, champion score, sealed check, peak memory where
  recorded, lines of agent code per folder, where data loading is implemented.
- It must work on the runs in `runs/finetuned/spam1/` today and say clearly what
  it cannot measure yet and which small hook would make it measurable.
- Measurable test: it runs on the two existing spam1 runs and reports their
  known facts (57 minutes to the first trial, no hand-over, loader written
  twice).

**P5. Design of the workspace and the experts (documents only)**

- `harness/finetuned/docs/expert-team.md`: the workspace layout in
  `solutions/`, the one sandbox and what data it shows, the four experts with
  draft prompts, the shared findings file, how the orchestrator calls experts
  (also two at once), what happens to the research brief and its validator, what
  stays of trials, champion, sealed check and refit, and a split of the
  implementation into wave-2 packages with file ownership and measurable tests.
- No code changes.

### Wave 2 (after wave 1 is merged and spam1 reaches a hand-over)

- **P6. One workspace** and one sandbox, from P5.
- **P7. The four experts**, the findings file and parallel calls, from P5.

### Wave 3

- **P8. Lighter controller**: the orchestrator's tools fill in action IDs and
  revisions themselves.
- **P9. Memory that saves work**: findings backed by harness records on the same
  dataset are passed on as facts.

Then the shared-drive tasks and the protocol for measured runs, as in
[cleanup-plan.md](cleanup-plan.md).

## Working rules

- Every package is checked by a review subagent before it is merged.
- Every package comes with measurable tests, and states the measured values in
  its report.
- Subagents work in their own checkout and never start a pipeline run with the
  model; spam1 runs are done from the main checkout between waves.
- Prompts stay in `agent/prompts/`; setup prerequisites are declared in the
  shared preflight; development guidance stays out of pipeline prompts (see
  `AGENTS.md`).

## Decision log

Decisions taken while carrying out the plan, newest last.

- **2026-11-10, subagents.** Four Opus 5.5 subagents at once hit the Claude API
  rate limit; the host resumes them. Code review of each package is done by
  GPT 6.1 (`gpt-6.1-sol`, high effort) after the implementation.
- **2026-11-10, second datasets.** The redesign is also checked on `code2`
  (clustering of PHP and Perl bots) and `attacks1` (adversarial example
  detection, no labels), so that it is not fitted to spam. See
  [tasks.md](tasks.md).
- **2026-11-10, scorecard hooks.** The scorecard needs two records: who caused
  each charged model request (`source` in the journal's `budget_reserved`
  entries, from P3), and the peak memory of trials and agent scripts
  (`processes.jsonl` and `worker-exit.json`, from P1).
- **2026-11-10, one working tree.** The first design gave every expert its own
  git worktree with harness merges, so that two code-writing experts could run
  at once. Rejected: it brings back separate folders per agent. Instead all
  experts work in the one checkout of `solutions/`, at most one code-writing
  expert (data, modelling, validation) is active at a time, and the literature
  expert, which has no shell or write tool, may run alongside it. Follow-up
  branches from the champion stay.
- **2026-11-10, sealed numbers.** No automatic filter on the orchestrator's
  guidance text; the earlier decision stands that this is an instruction. The
  validation expert no longer reads the sealed confirmation at all.
- **2026-11-10, label-free tasks.** Getting a task without labels to a
  hand-over is its own package (P7c), after the core works on spam1 and the
  clustering task: first an unscored hand-over (offline only), then labels the
  experts establish by inspection, with a part held back for the sealed check.
- **2026-11-10, many classes.** Tor website fingerprinting needs a multi-class
  task kind the harness does not have. It is out of scope for this plan and
  listed in [tasks.md](tasks.md) as not runnable.
- **2026-11-10, rate limit.** Four Opus 5.5 subagents use up the Claude API
  limit in about 20 minutes and then stall for hours. From now on at most three
  run at once, and fixes for review findings go to GPT 6.1 (`gpt-6.1-sol`, high
  effort), which also does the reviews. The core packages stay on Opus 5.5.
