# v2 kickoff: parallel work streams

Written 2026-11-11 on branch `v2-clean-slate`, after the clean slate. The design
is [expert-team-v2.md](../harness/finetuned/docs/expert-team-v2.md) (packages in
section 11), its contracts are in
[expert-team.md](../harness/finetuned/docs/expert-team.md), the queue is
[cleanup-plan.md](cleanup-plan.md).

## How much can run at once

P6, P7a and P7b were written as a sequence, but most of their items touch
disjoint code. Grouped by the files they own, three streams can run at the
same time; the lead agent and the integration gate need all three.

| Stream | Packages | Owns (writes) | Needs from others |
| --- | --- | --- | --- |
| **A. Supervision** | P6 sampler, `supervision` block, machine-protection stop, output cap; P7b wake-on-news | `agent/experiments/**`, the `supervision` section of `harness.config.json` and `agent/harness/config.ts`, its setup check | nothing |
| **B. Trials and feedback** | P6 task data and split, shared tree, `workspace_check`, follow-up merge, trial snapshots, `trial_smoke`, parallel folds, per-session environment; P7b noise verdict and Ladder holdout feedback; section 8 "Change" items for training | `agent/training/**`, `agent/solve/**`, `agent/confirmation/**`, `agent/refit/**`, `agent/prompts/training/**`, `agent/prompts/solve/**` | nothing |
| **C. Scouts** | P7a blocking `scout()`, tool-call budget counter, data/ideas/validation scouts, task text plus unit intro, findings journal append, scout budget test | new `agent/team/**`, `agent/prompts/team/**`, `agent/subagents/**`, `agent/dryrun/**` (absorb, then delete), the `team` section of the config | B's trial snapshots, for the validation scout only (build it last, against the contract in expert-team.md section 3) |
| **D. Lead and hand-over** | P7a lead session, `PROGRESS.json` and resume; P7b lead budget counter, `hand_over` with validation scout, budget-end hand-over; retire the solve → refit chain; integration gate | `agent/run/**`, `agent/pipeline/**`, CLIs, `experiment/` | A, B and C merged |

So: **three streams in parallel now (A, B, C), then D**, then the integration
gate, then P7c. A fourth parallel stream would collide: D rewires the session
runner and executor that A, B and C still call.

Shared files every stream may touch: `harness.config.json`,
`agent/harness/config.ts`, `agent/prompts/registry.ts`,
`agent/pipeline/setup.ts`, `package.json`. Rule: add only your own section or
entries, never reorder or reformat others, rebase on the branch before merging.

Machine limits (6 cores, 15 GB): the full test suite takes about 11 minutes
and starts many Python workers. While streams run in parallel, each runs only
its own module tests; the full suite runs once per merge, one merge at a time.

## Shared preamble (put in front of every stream prompt)

```text
You are implementing part of the v2 design in /home/nico/Projects/auto-smart-lab
(finetuned arm, harness/finetuned/). Read AGENTS.md, docs/cleanup-plan.md,
harness/finetuned/docs/expert-team-v2.md (sections 2-11) and the sections of
harness/finetuned/docs/expert-team.md your stream names. Work only in the files
your stream owns (docs/v2-kickoff.md); in shared files add only your own
section or entries. Do not touch harness/minimal/ and do not add coaching to
the minimal arm. Run commands through ./dev. Run only your module's tests while
other streams are active; never start the full suite in parallel with another
stream. Add setup checks and regression tests for every new feature as
AGENTS.md requires. Keep prompts in agent/prompts/ with registry IDs. Facts to
keep in mind: training file names end in their label and test names in .x
(a stated task fact, not a leak; never engineer around it); every agent gets
the task text and the unit introduction; budgets are tool calls; the only stop
is machine protection. Cite papers only for design claims. When done, report
which checks from expert-team-v2.md section 11 pass, with test output, and what
is left. Commit on your own branch; do not merge or push unless asked.
```

## Stream A prompt: supervision

```text
Stream A (supervision). Implement expert-team-v2.md section 6 and the
wake-on-news part of section 4:
1. A Linux process sampler in agent/experiments/sampler.ts (from /proc: CPU
   time, RSS, I/O, children), keeping the Darwin path; today it returns null
   on Linux.
2. One `supervision` block in harness.config.json (values in v2 section 5),
   validated in agent/harness/config.ts, applied to every agent bash call
   (session runner and subagent child bash) and every harness trial.
3. Findings stuck, stale, time-wasting, flooding, runaway memory: each tells
   the owning agent once, with CPU, memory and elapsed time; nothing is killed.
4. Machine at risk (available RAM below the reserve or swap full for 15 s):
   stop the largest running process yourself (do not rely on OOM ordering, see
   v2 section 6 prerequisites), tell its owner "this experiment was too big for
   the machine" with its peak memory, and continue the run.
5. Output cap: 50 KiB to the agent, the rest to a spill file it can read.
6. Wake on news only: remove the 30 s progress pushes
   (agent/experiments/updates.ts); wake on trial end, a finding, or a request.
Checks (v2 P6): a stuck, a stale and a flooding script each produce exactly
one report and no kill; a script that pushes available RAM below the reserve
is stopped, its owner is told, and the run continues; healthy trials cause no
wake.
```

## Stream B prompt: trials and feedback

```text
Stream B (trials and feedback). Implement in this order:
1. P6 task data: TaskData and prepareTaskData with a persistent task-level
   split (expert-team.md sections 1 and 5); the spam1 split must stay
   unchanged.
2. P6 shared tree: runs/finetuned/solutions/ as one shared, version-controlled
   sandbox for the lead and all scouts, workspace_check, follow-up branch merge,
   reuse across tasks (expert-team.md section 2).
3. P6 trial snapshots and resolveTrialSnapshot (expert-team.md section 3).
4. trial_smoke (v2 section 7): import, build, fit a small stratified sample,
   predict a small test sample, validate output domain and IDs, run
   workspace_check; failures return the traceback and charge no trial.
5. Parallel folds within the machine's cores; per-session environment.
6. v2 section 8 "Change" items for training: pilot-first is an option, a
   search winner counts once measured on the shared folds, hypothesis text is
   one or two sentences (truncate, do not reject), the training tool
   description only for the task's kind, the interface is any object with
   fit/predict (fit_predict for batch clustering).
7. P7b trial feedback (v2 section 4): fold scores, the noise verdict (beyond
   noise only if the paired lead exceeds 2 standard errors) stated to the
   agent, and the Ladder holdout check (Blum & Hardt 2015): reveal the
   holdout score only on a significant improvement, count every query, never
   expose withheld labels.
Checks: v2 P6 (split unchanged, a broken pipeline fails smoke and charges no
trial) and v2 P7b (a within-noise trial is labelled so; the holdout is
revealed only on significant improvement and every query is counted).
```

## Stream C prompt: scouts

```text
Stream C (scouts). Implement the scouts of expert-team-v2.md section 3 as
part of P7a, building on agent/subagents/ (README there):
1. A blocking scout({role, question, refs}) tool for the lead: it starts the
   scout and returns only its final bullets; the scout's tool output never
   enters the lead's context. Several roles per call allowed.
2. Tool-call budgets with a one-line counter after every call and one
   finish-up turn (see agent/dryrun/scout_dry_run.ts, which already does this;
   move it into agent/team/ and delete agent/dryrun/ when done). Budgets come
   from a `team` block in harness.config.json (v2 section 5).
3. Data scout (read, observed bash, profile, its own research/ folder in the
   shared tree), ideas scout (read-only plus at most 3 web searches, course
   slides), validation scout last (needs stream B's trial snapshots; build
   against expert-team.md section 3 and stub until B merges). Prompts in
   agent/prompts/team/, starting from agent/dryrun/scouts/*.md and the seeds in
   harness/finetuned/docs/expert-team/prompts/.
4. Every scout gets the task text and the unit introduction (v2 section 9).
5. Bullets are appended to the findings journal (expert-team.md section 4);
   a repeat call sees earlier bullets and is told not to repeat them.
6. Scout budget test: each scout alone on spam1-3 and code2 with 10 and 20
   tool calls; record calls used, time and what it surfaced; write the result
   into v2 section 3 and propose starting budgets.
Checks (v2 P7a): a scout cannot exceed its budget and always returns bullets;
the lead's context contains the bullets but none of the scout's tool output;
prompts exclude fixture AGENTS.md.
```

## Stream D prompt: lead and hand-over (after A, B and C are merged)

```text
Stream D (lead and hand-over). Streams A, B and C are merged. Build the lead
agent of expert-team-v2.md sections 2, 4 and 5:
1. One lead session (start from agent/run/harness_solve_session.ts) with the
   training tools, scout(), trial_smoke, live trial observation and the
   wake-on-news supervisor; compaction and resume from PROGRESS.json.
2. The lead's tool-call budget with the counter after every call.
3. hand_over with the validation scout; budget-end hand-over by the harness.
4. Retire the solve → refit configured chain: the lead run replaces it as the
   finetuned arm's entry (pipeline_cli.ts and experiment/), terminal refit
   stays deterministic.
5. Integration gate (v2 section 11): spam1 -> spam2 -> spam3 offline against
   the minimal arm's 2026-11-11 numbers (first trial <= 10 min, hand-over
   <= 45 min, spam1 CV balanced accuracy >= 0.994, no machine-at-risk stop,
   reader reused), then code2 to hand-over. Report the measurements.
Checks (v2 P7b): a killed run resumes without repeating a charged trial; the
lead's context holds scout bullets but no scout transcripts.
```

## Running the streams

Each stream needs its own checkout (a git worktree on its own branch from
`v2-clean-slate`). Gitignored inputs are not in a fresh worktree: link `units/`,
the slide files under `resources/01-spam/` and `.env` from the main checkout,
and run `./dev setup` for `harness/finetuned/.venv`. Merge A, B and C into
`v2-clean-slate` one at a time, with the full test suite after each merge, then
start D from the merged branch.
