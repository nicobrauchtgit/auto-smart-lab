# Expert team v2: a lead agent with expert subagents

Written 2026-11-11 after the observed finetuned spam1 run and a literature
scan. **Accepted by the user on 2026-11-11** (P5′). It replaces the topology
and orchestration of the first expert-team design: four executor stages, an
LLM orchestrator and its package split. That design remains in git history
(commit 452e1e5). Its contracts that
remain valid (task data and the sealed split, the shared working tree,
workspace checks, trial snapshots, the findings journal and P7c) are kept in
[expert-team.md](expert-team.md), now the contract appendix to this document,
and are referenced here instead of being repeated.

The old orchestrator, research and evaluate stages, knowledge store and leakage
canary were removed on 2026-11-11 (package "Clean slate", section 11); what
remains runs solve and then refit as a configured chain until P7 replaces it. The work queue is
[docs/cleanup-plan.md](../../../docs/cleanup-plan.md).

Paths are relative to `harness/finetuned/` unless prefixed by `runs/` or `docs/`.

## Clarification: readiness and delivery (2026-11-12)

`hand_over` now defaults to a free nonterminal readiness checkpoint. Its first
verified working baseline switches the harness goal to improvement in the same
lead session and preserves immutable measurement and validation evidence.
`finalize: true`, or the harness end step, requests validation-gated terminal
refit and delivery. Earlier descriptions below of `hand_over` immediately
refitting mean explicit finalization. See [lead execution](../agent/run/README.md)
for receipt identity, retry, budget and label-access semantics.

## 1. Why the design changes

### Evidence from our own runs (2026-11-11)

| | Finetuned spam1 (old chain) | Minimal spam1 / spam2 / spam3 |
| --- | --- | --- |
| Hand-over | 9 h 06 min | 46 / 17 / 15 min |
| Agent's local score | TF-IDF + LR, C=10 | 0.9967 / 0.99937 / 0.99819 |
| Where time went | research 32 min (14 min lost to a 9.5 GiB probe), solve 4 h 03 min, follow-up solve 3 h 54 min, plus controller dead ends | one agent iterating with a 30-minute session cap |

Research had a 0.990 TF-IDF + logistic-regression result 20 minutes in. Solve
rebuilt the same family over 4 hours, and the controller then spent another 4
hours on whether C=10 beats C=1. Controller hand-offs failed three times
(evaluate: missing `training_seed_plan`; solve: "no research document
upstream" twice) and a follow-up inherited an exhausted budget and hung.
Details: [the batch report](../../../docs/experiments/spam-2026-11-11.md).

### Evidence from research papers

Only papers count as evidence here. Engineering blog posts are not cited.
"Peer-reviewed" means accepted at the named venue; "preprint" means arXiv only.

**For one iterating agent over a fixed relay of roles**

- **Kim et al., ICML 2026 (peer-reviewed).** About 4,000 controlled
  ablations on 100 Kaggle competitions, three replicates, 24 h per run. A
  fixed Explorer → Builder → Evaluator pipeline scored 8.3–8.5 percentile
  points below the single-agent baseline; all components together scored
  13.7 points below it at 2.9× the tokens. With stronger backbones the
  single agent rose from 81 to 86–89 while the pipeline stayed at 71–73.
  Even with twice the single agent's tokens the pipeline was 8.5 points
  behind. The failure analysis attributes 38% of pipeline failures to
  coordination (incompatible outputs, circular revisions, miscommunication),
  against capability limits for the single agent. Their worked example: a
  builder that did not find the explorer's file repeated the exploration for
  2.5 hours, which is what our solve stage did after research.
  The authors limit the claim to this fixed sequential protocol.
- **Same paper, on iteration.** 1 → 10 iterations was worth +33.7 points,
  +19.7 of it from the first three; 58% of runs spent an iteration recovering
  from code, format or out-of-memory errors. Memory and planning components
  were near-neutral.
- **Cemri et al., NeurIPS 2025 (peer-reviewed).** A taxonomy of 14 failure
  modes from 1,642 annotated multi-agent traces. Failures come mainly from
  system design, inter-agent misalignment (about a third) and missing task
  verification, not only from weak base models.
- **Kim et al. (Google/MIT), 2025 (preprint).** 180 configurations across
  five architectures. On a sequential planning task every multi-agent
  variant lost 39–70% against one agent.
- **Shen et al., 2026 (preprint).** On an automated ML-optimization loop, a
  relay of specialist experts on one shared tree had more crashes and
  compounding errors than one agent with parallel subagents.

**For multi-agent designs (the other side)**

- **Kim et al. (Google/MIT), 2025 (preprint).** On a parallelizable finance
  task, centralized coordination improved results by about 81%. Independent
  agents amplified errors 17.2×, centralized coordination 4.4×.
- **Li et al., CoMind, ICLR 2026 (peer-reviewed).** A multi-agent MLE system
  with parallel exploration: 36% medals on 75 MLE-bench tasks, above 92.6%
  of human competitors in eight live competitions. There is no same-budget
  single-agent ablation, so it shows a strong system, not that the multi-agent
  part caused it.
- **Nam et al., MLE-STAR, NeurIPS 2025 (peer-reviewed).** Several specialized
  LLM calls (retrieval, ablation, block refinement, debugging, leakage check)
  inside a code-controlled loop; 63–64% medals on MLE-bench Lite. Its gains
  come from a strong first solution and targeted refinement. It supports
  specialized calls under a fixed algorithm, not a relay of autonomous agents.
- **Shen et al., 2026 (preprint).** Specialist teams did better on deep,
  coupled changes when given more compute; one agent plateaued quickly on
  broad sweeps, where parallel subagents did best.

**For an independent check of the result**

- **Panickssery et al., NeurIPS 2024 (peer-reviewed).** LLM evaluators
  recognize and prefer their own outputs; self-preference grows with
  self-recognition. This supports a validation pass by a separate session
  rather than the lead grading itself.

**Search policy**

- **Toledo et al., AIRA-dojo, NeurIPS 2025 (peer-reviewed).** With AIDE's
  Draft/Debug/Improve operators, greedy search matched MCTS and evolutionary
  search (35–39% medals); better operators raised it to 47.7%.

### How strong this is

The case against a fixed relay rests on one peer-reviewed controlled study
(Kim et al., ICML 2026), one peer-reviewed failure taxonomy and two preprints.
The case for multi-agent rests on parallelizable tasks (preprint) and on
strong systems without single-agent ablations. No paper we found compares a
single agent with context compaction against a role relay directly, so the
claim that hand-offs between stages lose more than compaction is a hypothesis
supported by the failure analyses, not a measured result. Our own spam1 run
is one run per arm.

Reading both sides: extra agents help with parallel breadth and with an
independent check, under central control. They hurt as a fixed sequential
relay with document hand-offs.

### What this means for us

The harness has two jobs, and neither is to constrain what the agent builds:

1. **Verification, not limitation.** Every pipeline the agent proposes is
   measured by the harness quickly, on fixed folds, with cheap checks before
   it is charged. The agent can watch its trials live and is told how well each
   iteration generalizes and whether it is really better than the last. It
   decides what to try and when it is done.
2. **Clean context for the builder.** Exploration with many tool calls (data
   inspection, web search, checking) happens in short scout sessions. The
   builder receives only their bullet lists, not their transcripts.

One **lead agent** (the builder) drives the whole run. Scouts for data, ideas
and validation are **subagents the lead calls**; the lead receives their final
bullets asynchronously as inbox news. The harness is a set of tools and guards
around the lead, not a pipeline of stages. This keeps the user's decisions (four kinds of expertise,
what/why research, one shared tree, harness-run trials as the measurement, no
polling, observed tool calls) and removes the fixed relay that the evidence
and our run both show to be the bottleneck.

## 2. Run shape

```text
harness (code, no model)
  ├─ prepare task data + split (once per task, reused)
  └─ start the lead, then only serve tools and guard budgets

lead agent (drives everything)
  ├─ may call scouts at any time, continuing work or ending its turn to wait:
  │    data scout · idea scout · validation scout  (several at once allowed)
  ├─ writes the pipeline, smoke-checks it, starts harness trials
  ├─ watches trials live when it wants; is woken when a trial ends or misbehaves
  ├─ reads feedback: folds, noise verdict, generalization check
  ├─ calls scouts again when trials fail or stall (guided by the failures)
  └─ calls hand_over when satisfied → validation scout once → terminal refit
```

No phase order is fixed. Scout output is short, so calling a scout again with
a narrower question is cheap and expected: "trial 3 misclassifies long HTML
mails; what is in them?" is a better research call than a long upfront brief.
At budget end without a hand-over, the harness hands over the current
champion itself (P3's budget-end refit).

## 3. Scouts (the info-gathering research step)

Scouts gather information; the lead decides how to build. A scout never
delivers a pipeline, an architecture or code for the lead to adopt.

| Scout | Looks at | Returns (bullets only) | Tools |
| --- | --- | --- | --- |
| **data** | task text, profile, training and test inputs | interesting properties of the data; where training and test differ; which inputs or fields look informative; traps (e.g. encodings, duplicates) | read, bash (observed), profile |
| **ideas** | task, data bullets, course slides, web | features that might work and why; extras worth having in a pipeline (class weighting, threshold tuning, normalization …); no estimator recipes or parameters | read-only, web search |
| **validation** | the champion's frozen snapshot and trial records | concrete defects with evidence (fold leakage, wrong output domain, fit on test inputs); `ok` / `fix` / `advice` | read/search files, author checks, execute through `run_checks`; no bash |

Capability correction, 2026-11-12: validation's shell was removed after the
[live audit](../../../docs/experiments/spam1-interface-verification-2026-11-12.md)
observed checks executing outside `run_checks`. File-tool admission now enforces
the route. This does not constrain arbitrary Python inside a check from doing CV.

**Output.** Short bullets, as many as the scout actually found and no
more, each with where it came from (a profile record, a file, a trial ID or a
URL). There is no bullet quota: a fixed number would either cut findings or
invite padding. No document, no sections, no architecture. The bullets go to the lead and to the findings journal; the
scout's own tool calls and transcript stay in its session.

**Budget.** Counted in tool calls, not wall time or tokens; the scout decides
how to spend them. Evidence: BATS (Liu et al., arXiv 2511.17006, preprint)
found that a larger tool-call budget alone does not help, because agents
without budget awareness hit a ceiling, while a *Budget Tracker* that appends
the remaining and used calls after every step reached comparable accuracy with
about 10× less budget (40% fewer search calls, 31% lower cost). That paper
shows the budget continuously; we found no study comparing continuous display
with milestone notices such as 50%/10%. v2 therefore follows the evidence: a
one-line counter after every tool call ("7 of 15 tool calls used"). When the
budget is used, tools are blocked and the scout gets one finish-up turn:
"Write your final bullets now." The finish-up turn does not count. Running out
never fails the run. Wall time is used only to detect stalls (section 6).

Starting budgets: data 15, ideas 10 (at most 3 of them web searches),
validation 10 (`team.scouts` in `harness.config.json`). Planned from the
expected work: the ideas scout needs about 3 searches, 2 slide reads and a
look at the data bullets. The data scout reads the task and the harness
profile, looks at a few training and test samples and runs one or two small
scripts; Kim et al. found that 58% of runs needed at least one iteration to
repair a failing script, so 10 is tight for it. Measured basis, the P7a budget
test (each scout alone on spam1–3 and `code2` with 10 and 20 calls,
2026-11-11, [results](../agent/team/budget-results.md)):

- data used every call at both budgets, and 20 calls surfaced further useful
  properties, so it gets 15, between the tested values;
- ideas returned useful material at 9–10 calls; 18–19 of 20 added detail with
  no shown gain, so it stays at 10;
- validation completed at 10 calls on all four tasks, with one check each.
  At 20 it wrote 2–4 checks and reached the same conclusions, so it stays at
  10; a focused repeat call buys more checks.

Limits of that basis: one probe per cell, one provider and model, prompt and
backend changes between the data/ideas probes, and no quality comparison.
Findings were not graded, and no trial with a seeded defect was validated.

**Dry run (2026-11-11, one data scout on spam1, budget 10).** Original script and
prompts (since moved to `agent/team/budget_probe.ts` and
`agent/prompts/team/{data,ideas}.md`):
output under `runs/finetuned/scout-dry-run/2026-11-11T11-00-09-spam1-data-10/`.
It used 10 of 10 calls in 298 s and returned 14 sourced bullets (5.3k
characters), no blocked calls after the budget. Findings were useful: training
is Enron-style mail while the test set looks like a different spam corpus,
text is pre-normalized (URL artifacts), spam is padded, the test set has a long
tail, everything is lowercase. Two defects: it still called the label suffix a
leak, prompted by the profile's `name_leakage` record (removed since), and it
wrote its scripts to `/tmp`; the data scout prompt now gives it a `research/`
folder for all scripts and outputs. The task text and unit intro reached it
(`task.md`); the spam unit intro does not mention file endings, which the task
texts now state. The ideas scout has not been dry-run yet.

**Stream C implementation and budget matrix (2026-11-11).** Blocking scouts,
role tools, continuous counters, journal append and prompt-exclusion regressions
are implemented under `agent/team/`. The serial 10/20-call data/ideas matrix on
spam1–3 and code2 completed all 16 probes within budget with bullet replies:
data used 10/10 or 20/20 calls; ideas used 9–10/10 or 18–19/20. Recorded times
were 79–375 s after initial staging/profiling. Results and what each surfaced
are in [the scout budget report](../agent/team/budget-results.md). Propose
starting budgets **data 15, ideas 10 (at most 3 searches), validation 10
provisional**. These development probes had prompt/backend changes and do not
isolate a budget effect or demonstrate model-quality gains. After the
integration with stream B, the eight validation probes ran on measured trial
snapshots with `run_checks`. All 10-call runs completed. Two 20-call runs were
recorded as empty because the bullet parser dropped findings written without
list markers; that parser is fixed. No probe called the label suffix a defect.
The code2 runs wrongly required `fit`/`predict` of a `fit_predict`-only
clustering pipeline; the solutions README and the validation prompt now state
that batch clustering needs only `fit_predict`.

**Repeat calls.** The lead passes a focused question and optional references
(trial IDs, error summaries). A repeat call sees earlier bullets from the
journal and is told not to repeat them.

## 4. Feedback to the lead

**Live observation (pull).** While a trial runs, the lead may check its status
and bounded output at any time with `experiment_status` / `experiment_output`,
and stop it with a reason, as the observer did during the spam batch. It may
also keep working, for example writing the next pipeline.

**Wakes (push), only for news.** The harness wakes the lead when a trial
ends, prints an error or warning, stalls (no output at near-idle CPU), or its
memory grows toward the machine limit. Healthy progress causes no wake. This
is what [experiment-supervision.md](experiment-supervision.md) already
specifies; the current code still sends a progress update every 30 s
(`experiments/updates.ts:104-106`, `solve.experimentUpdateIntervalSeconds`),
which v2 removes.

**Trial result.** Every completed trial returns, compactly:

- per-fold scores, mean and spread on the shared folds;
- the paired difference to the current champion and a plain verdict:
  "better beyond noise", or "+0.0004: within fold noise, not a real
  improvement" (promotion rule: more than 2 standard errors of the paired fold
  differences, `training/promotion.ts:15`). The lead is told this rule up front;
- cost (time, peak memory) and budget left;
- a generalization check on the withheld rows (below).

**Generalization check on withheld rows.** The lead knows the withheld rows
exist and that they tell it whether a pipeline generalizes beyond the folds it
was tuned on. Their labels are never shown. Showing their raw score after every
trial would turn them into a second validation set the agent tunes against,
which is exactly what the adaptive-data-analysis results warn about:

- Dwork et al., *Science* 2015 (peer-reviewed): reusing a holdout adaptively
  overfits it; their *reusable holdout* answers with the training estimate
  unless the holdout disagrees beyond a noise threshold.
- Blum & Hardt, *ICML* 2015 (peer-reviewed): the *Ladder* reveals a new
  holdout score only when it beats the previous best by a significant margin,
  rounded, which keeps the leaderboard reliable under many submissions.

v2 uses the Ladder on new champions: when a trial becomes champion, the
harness scores it on the withheld rows and tells the lead "holdout confirms
the improvement (score, rounded)" or "holdout shows no significant
improvement over the previous champion". Every query is counted and recorded,
so the final hand-over states how often the holdout was used.

## 5. Budget and hand-over

The lead decides when it is done. Its budget is also counted in tool calls,
with the same counter after every call as the scouts (section 3); starting a
trial is one tool call. Default: 80 tool calls for the lead; the minimal agent
used 20–35 per solver session on spam1–3. Scout calls count against the
scouts' own budgets, not the lead's.

Tool calls do not bound compute: one trial is one call but can run long. That
is the supervision's job (section 6): a trial far beyond its projected cost is
reported as time-wasting, and the lead decides. Wall time is recorded for every
run, so the comparison with the minimal arm (30-minute sessions) can use it,
but it is not a budget.

There is no plateau stop and no harness-chosen baseline. The trial result
shows how many trials in a row brought no real improvement; the lead decides
what that means. `hand_over` runs the validation scout once on the champion
snapshot. `fix` returns the defect to the lead (it may start more trials
within the budget); `ok` and `advice` go to the terminal refit, which
includes the withheld rows.

**Configuration.** All budgets live in one block of `harness.config.json`,
replacing today's `research`, `solve` and `orchestrator` budget keys:

```json
"team": {
  "lead":   { "maxToolCalls": 80 },
  "scouts": {
    "maxConcurrent": 3,
    "data":       { "maxToolCalls": 15 },
    "ideas":      { "maxToolCalls": 10, "webSearches": 3 },
    "validation": { "maxToolCalls": 10 }
  },
  "scoutGuard": { "stallMs": 900000, "wallMs": 5400000 },
  "budgetCounter": "every_call",
  "holdoutFeedback": "ladder"
},
"supervision": {
  "sampleIntervalMs": 250,
  "idleCpuPercent": 5,
  "outputCapBytes": 51200,
  "memoryReserveBytes": 1073741824,
  "swapFullSeconds": 15
}
```

`scoutGuard` only detects stuck scout sessions: no session event for
`stallMs`, or still running after `wallMs`. It is not a work budget. Every
tool call a scout emits counts against its budget, including calls Pi rejects
(unknown tool, invalid arguments), and its model turns are bounded by the
budget plus two.

**Resumption.** The harness writes a small `PROGRESS.json` (champion, trials
with their one-line hypotheses, holdout verdicts, budget left) and the
findings journal. A resumed or compacted lead session starts from these and
the `solutions/` git history. This is an engineering choice, not a research
result.

## 6. Global supervision of tool calls and trials

One `supervision` block in `harness.config.json` applies to every process an
agent starts (lead and scout bash calls) and every harness trial. Its purpose
is to find **stale, stuck or time-wasting** calls, not to cap work:

| Finding | Signal (sampled every 250 ms, no model cost) | Action |
| --- | --- | --- |
| stuck | no output and CPU below about 5% beyond a threshold scaled from the call's own output gaps | tell the owning agent with CPU, memory, elapsed time |
| stale | a long call whose output stopped growing while CPU is busy, past the same threshold | tell the owning agent |
| time-wasting | a shell call running far longer than such calls usually take for this task, or a trial far beyond its projected cost | tell the owning agent with the projection |
| flooding | output beyond a cap (default 50 KiB to the agent; the rest to a file) | truncate and point to the file |
| runaway memory | resident memory growing toward the machine limit | tell the owning agent before the limit |
| machine at risk | available RAM below a reserve (default 1 GiB) or swap full for 15 s | stop the largest running process (agent script or trial), tell its owner "this experiment was too big for the machine" with its peak memory, and go on |

Only the last row stops anything, and only so the machine never stalls (the
9.5 GiB script of 2026-11-10 filled swap). The run continues; the agent gets
the reason and can try a smaller version. Everything else is information for
the agent, which decides. Defaults and the CPU separation of hangs from slow
work come from our own measurements in experiment-supervision.md; there is no
peer-reviewed evidence for the specific thresholds. The scouts' budgets
(section 3) are separate and count tool calls.

**Prerequisites found before P6 (2026-11-10/11).**

- The deferred P1 investigation (branch
  `t3/protect-trials-under-pool-pressure` at `eee1894`)
  could not make the kernel's OOM killer pick the largest script before a
  trial without privileges: in a capped 300 MiB pool a 210 MiB trial was
  killed while a 90–95 MiB script survived under OOM score bias, `memory.min`
  and `memory.high`, and writing `oom_score_adj=-1000` was denied. v2's
  machine-protection stop therefore does not rely on kernel OOM ordering: it
  uses its own sampler, picks the largest process itself and stops it before
  available RAM falls below the reserve.
- The process sampler currently returns no samples on Linux:
  `agent/experiments/sampler.ts` returns `null` when the platform is not
  Darwin (see [docs/architecture.md](../../../docs/architecture.md), process
  and resource diagram). Every row of the table above depends on CPU and RSS
  samples, so a Linux sampler (for example from `/proc`) is a P6 prerequisite.

## 7. Cheap checks before a trial is charged

Kim et al. traced most of the value of iteration to repairing broken code.
`trial_smoke` imports `tasks/<task>.py`, builds the pipeline, fits a small
stratified sample, predicts a small test sample and validates output domain
and IDs, and runs `workspace_check`. Failures return the traceback and charge
no trial. This is verification; it puts no limit on what the pipeline is.

## 8. Changes to the current harness

From the audit of 2026-11-11 (prompts, `harness.config.json`, training code).
Items marked *(done)* were removed in the clean slate of 2026-11-11.

**Remove (prescribes how to build)**
- "Implement the brief's recommended pipeline first … one atomic change at a
  time" (`prompts/solve/start.md`). *(done)*
- Research's required concrete pipeline, CV scheme and atomic improvements,
  the brief format and `check_brief` number matching (`prompts/research/system.md`,
  `research/validate.ts`); replaced by scout bullets. *(done)*
- "scikit-learn pipelines" wording; the interface is any object with
  `fit`/`predict` (or `fit_predict` for batch clustering).

**Change (slows feedback or fills context)**
- Pilot-first becomes an option, not a rule (stated four times today).
- A search winner counts once measured on the shared folds; no mandatory
  second confirmation run.
- Allow parallel folds within the machine's cores.
- Wake on news only (section 4); remove the 30 s progress pushes.
- Training tool description only for the task's kind (today 118 lines,
  mostly anomaly/clustering diagnostics).
- Hypothesis text: no 2,000-character rejection; ask for one or two short
  sentences and truncate if longer.
- Remove the stage gates that failed in spam1: "no research document
  upstream" (`pipeline/stages/solve.ts:120-123`) and the evaluate evidence
  gate (`evaluation/evidence.ts:35`), together with the stages. *(done)*

**Keep (needed for trustworthy feedback)**
- Harness-owned seeds, folds, fits and predictions; withheld rows; noise rule;
  clean commit per trial; terminal refit.

## 9. Datasets and the interface

Checked against the local data on 2026-11-11:

| Task | Fits `build_pipeline()` over `id`/`input` | Note |
| --- | --- | --- |
| spam1, spam2, spam3 | yes | binary, zip members; spam3 is imbalanced (3007/554) |
| code2 | with caveats | batch clustering (`fit_predict` on the test batch) is supported but not configured; families 538/73/25/21 make grouped folds fragile |
| attacks1 | not to hand-over yet | no labels; needs P7c evidence labels |
| maldoc (not staged) | probably | if the archives are zip members |
| Tor (not staged) | no | multi-class is not a task kind |

**Label in the file name.** Verified on 2026-11-11: in every labelled
training archive the member suffix equals the label in the `.labels` file
(spam1 16,662, spam2 18,756, spam3 3,561, code2 657 members; 0 mismatches),
and every test member ends in `.x`. attacks1 has no labels; its training
members also end in `.x`. The suffix is a convenient way to read the labels
and worthless as a feature, because test names carry nothing. Nothing is
engineered around it. The course task texts do not say this, so a "Data
note" is added to each labelled task's `prompt.md` (spam1–3, `code2`): it is
part of the task, and both arms read it. `units/` is gitignored course
material and `fetch_units.py` rewrites `prompt.md`, so a refetch must re-add
the note. The note replaces today's rule "never use … a label-bearing file
extension as a feature" in `prompts/solve/task-binary_classification.md`.

The filename-leakage canary is dropped by the same decision and was removed on
2026-11-11, from trials, champion comparison and confirmation. So was the data
profile's `training.name_leakage` record, whose "suffix" purity a scout dry run
on 2026-11-11 read as a leak despite its prompt.

**Task text.** Every agent gets the task text *and* the unit introduction:
the course always had a unit intro that applies to all tasks of the unit.
Today the minimal agent gets both (`read_challenge` returns `unit_intro`),
but in the finetuned arm only the removed orchestrator saw the unit intro; solve
sees only `prompt.md`, so P7a must supply it to the lead and the scouts. Local
state: `units/01-spam/unit-intro.md` and `units/clustering-of-malicious-code/unit-intro.md`
exist (short versions); `detection-of-unknown-attacks` has none locally, only
in `units/_vm-archive/units/detection-of-unknown-attacks/unit-intro.md`.
The sentence about labels in file names in
`units/_vm-archive/units/01-spam/task1-spam-detection/prompt.md` sits in a
"## Data" section written for an earlier VM setup, not in the course text.

## 10. What stays from expert-team.md

[expert-team.md](expert-team.md) keeps these contracts:

- Task-level split, `TaskData`, `prepareTaskData` (sections 1 and 5 there).
- Shared tree `runs/finetuned/solutions/`, index, docstrings,
  `workspace_check`, follow-up branch merge, reuse across tasks (section 2).
  It is the one shared sandbox for the lead and every scout: scouts may
  write and adapt code there (a data scout's reader, a validation check), and
  git history keeps every version.
- Trial snapshots, `resolveTrialSnapshot` and the check runner for the
  validation scout (section 3).
- The findings journal, reduced to kinds `fact`, `idea`, `result`, `defect`
  and `decision` (section 4).
- The import/deletion audit (section 6) and current code obstacles (section 8).
- P7c after v2 works on spam and `code2` (section 7).

## 11. Packages

### P5′ — accept this design (documents) — done 2026-11-11
- Accepted; `expert-team.md` trimmed to the contract appendix,
  `docs/cleanup-plan.md`, ADRs and `AGENTS.md` updated, superseded plans
  removed (they remain in git history).
- The draft prompts in [expert-team/prompts/](expert-team/prompts/) are seeds;
  rewriting them as lead and scout prompts is P7a work.

### Clean slate — done 2026-11-11
- Removed the LLM orchestrator, the research and evaluate stages with their
  CLIs, prompts and gates, the knowledge store and lesson step with its
  prompts (including `lessons/sealed.md`), the scorecard, the old
  `agent/instructions/`, the filename-leakage canary and the profile's
  `name_leakage` record, and the solve prompt's brief-first instructions.
  The chain is solve → refit; typecheck and tests pass.

### P6 — foundations

P6, P7a and P7b are implemented as three parallel streams plus a lead stream;
see [docs/v2-kickoff.md](../../../docs/v2-kickoff.md) for the split, file ownership
and one prompt per stream.
- Task data; shared tree; `workspace_check`; trial snapshots.
- Linux process sampler (section 6); global `supervision` block applied to
  every agent shell call and trial; machine-protection stop with its own
  largest-process choice; output cap with spill file.
- `trial_smoke`; parallel folds; per-session environment.
- Checks: spam1 split unchanged; a stuck, a stale and
  a flooding script each produce exactly one report and no kill; a script that
  pushes available RAM below the reserve is stopped, its owner is told it was
  too big, and the run continues; a broken pipeline fails smoke and charges
  no trial.

### P7a — lead and scouts
- Build the asynchronous scouts on `agent/subagents/` (parent/child Pi sessions
  with a bounded final reply; [README](../agent/subagents/README.md)). It is
  the base, not deleted; v1's plan to delete it is withdrawn.
- Lead session with compaction and resume from `PROGRESS.json`.
- `scout({role, question, refs})`, asynchronous, several roles per call allowed;
  tool-call budgets with a counter after every call and a finish-up turn;
  bullets with a source each, no quota; journal append.
- Scout budget test: each scout alone on spam1–3 and `code2` with 10 and 20
  tool calls; record calls used and findings.
- Prompts in `agent/prompts/team/`: lead, data, ideas, validation, shared
  workspace and machine notes.
- Checks: a scout cannot exceed its budget and always returns bullets; the
  lead's context contains the bullets but none of the scout's tool output;
  prompts exclude fixture `AGENTS.md`.

### P7b — harness services
- Trial feedback (folds, noise verdict, Ladder holdout check), wake-on-news,
  the lead's tool-call budget counter, `hand_over` with validation scout, budget-end
  hand-over, `PROGRESS.json`; retire the remaining solve stage chain. Trial
  history stays as harness trial records behind the trial feedback.
- Checks: a within-noise trial is labelled so; the holdout is revealed only on
  significant improvement and every query is counted; healthy trials cause no
  wake; a killed run resumes without repeating a charged trial.

### Integration gate (before P7c)
- spam1 → spam2 → spam3 offline against the minimal arm's 2026-11-11 numbers:
  first trial ≤ 10 min, hand-over ≤ 45 min (measured, not enforced), spam1 CV balanced
  accuracy ≥ 0.994, no machine-at-risk stop, reader reused on spam2/3.
- spam1 reference: a hand-made binary TF-IDF + linear model with 5-fold
  stratified CV ([docs/redesign-spam1-reference.py](../../../docs/redesign-spam1-reference.py),
  about 30 lines) reaches 0.9944 (unigrams) to 0.9954 (uni+bigrams) CV balanced
  accuracy, in 42 s for three candidates at 0.5 GB peak memory (measured
  2026-11-10).
- Then `code2` to hand-over, then P7c.

## 12. Decisions

Taken with the user on 2026-11-11:

- One lead agent drives; scouts were blocking subagents (superseded by the
  2026-11-12 decision below); no LLM orchestrator and no fixed stage pipeline.
- Scouts return bullets without a quota, under tool-call budgets.
- Holdout feedback uses the Ladder on new champions.
- Budgets are tool calls for every agent; wall time only detects stalls and is
  recorded for comparison.
- Quick iterations: no mandatory pilots, no second confirmation run.
- The only stop is machine protection: stop the largest process, tell the
  agent it was too big, continue.
- The label suffix is a stated task fact, not engineered around; the
  filename-leakage canary is dropped. Each labelled task's text says so.
- One shared sandbox (`runs/finetuned/solutions/`) for the lead and all
  scouts; anyone may reuse and adapt code there; git keeps every version.
- The knowledge store is dropped; the findings journal and code reuse in
  `solutions/` carry what one task learns to the next.
- Every agent gets the task text and the unit introduction.
- More iterations over more upfront research: short scout runs first, then
  targeted new scout calls guided by trial results.
- `agent/subagents/` is the base for the asynchronous scouts.
- Scout starting budgets data 15, ideas 10, validation 10, from the P7a scout
  budget test (section 3). The lead's 80 is exercised at the integration gate.

## Sources

Peer-reviewed:

- Kim, Mireskandari, Son, Zhou, Shahid, Dai, *Investigating Component
  Contributions in Multi-Agent ML Systems*, ICML 2026:
  <https://icml.cc/virtual/2026/poster/65244>,
  [PDF](https://yifan1207.github.io/assets/pdf/kim2026component.pdf)
- Cemri et al., *Why Do Multi-Agent LLM Systems Fail?*, NeurIPS 2025:
  <https://neurips.cc/virtual/2025/poster/121528>
- Toledo et al., *AI Research Agents for Machine Learning: Search,
  Exploration, and Generalization in MLE-bench*, NeurIPS 2025:
  <https://proceedings.neurips.cc/paper_files/paper/2025/hash/328b81881da145412f2bc56c998dfb6a-Abstract-Conference.html>
- Nam et al., *MLE-STAR: Machine Learning Engineering Agent via Search and
  Targeted Refinement*, NeurIPS 2025: <https://arxiv.org/abs/2506.15692>
- Li et al., *CoMind: Towards Community-Driven Agents for Machine Learning
  Engineering*, ICLR 2026: <https://iclr.cc/virtual/2026/poster/10009716>
- Panickssery, Bowman, Feng, *LLM Evaluators Recognize and Favor Their Own
  Generations*, NeurIPS 2024:
  <https://papers.nips.cc/paper_files/paper/2024/hash/7f1f0218e45f5414c79c0679633e47bc-Abstract-Conference.html>

- Shi et al., *Large Language Models Can Be Easily Distracted by Irrelevant
  Context*, ICML 2023: <https://proceedings.mlr.press/v202/shi23a.html>
- Liu et al., *Lost in the Middle: How Language Models Use Long Contexts*,
  TACL 2024: <https://aclanthology.org/2024.tacl-1.9/>

- Dwork, Feldman, Hardt, Pitassi, Reingold, Roth, *The reusable holdout:
  Preserving validity in adaptive data analysis*, Science 349(6248), 2015:
  <https://doi.org/10.1126/science.aaa9375>
- Blum, Hardt, *The Ladder: A Reliable Leaderboard for Machine Learning
  Competitions*, ICML 2015: <https://proceedings.mlr.press/v37/blum15.html>

Preprints (no venue found):

- Kim et al. (Google Research, MIT), *Towards a Science of Scaling Agent
  Systems*, 2025: <https://arxiv.org/abs/2512.08296>
- Shen et al., *An Empirical Study of Multi-Agent Collaboration for Automated
  Research*, 2026: <https://arxiv.org/abs/2603.29632>
- Liu et al., *Budget-Aware Tool-Use Enables Effective Agent Scaling* (BATS),
  2025: <https://arxiv.org/abs/2511.17006>

## 2026-11-12 user decision: asynchronous scouts

In our measured spam1 run, a data+ideas consultation took about 12 minutes
while the lead was blocked. The lead reported using rare, broad consultations
because of that delay and said asynchronous delivery would allow narrow
questions while continuing work. This is evidence about this repository's run,
not a general research finding. The user decided to make consultations
asynchronous, with parallel roles and multiple simultaneous consultations.

The scout tool returns a consultation ID in one charged call. A FIFO queue
caps background scout sessions at `team.scouts.maxConcurrent` (default 3).
Only final bullets and role failure/stopped/empty lines reach the lead through
its inbox; news wakes a waiting lead. Ending a turn waits while consultations
remain pending. Synchronous hand-over validation bypasses the background cap,
so it cannot be starved. Finalized hand-over, budget-end hand-over, session end
and cancellation cancel outstanding consultations and await session/supervised
shell cleanup. The budget-end path cancels rather than waiting for findings.
Pending consultations are process-local; a resumed lead has none pending,
retains its scout-call counter and durable journal, and receives a resume note.

### Scout discovery decision — 2026-11-12 (user decision)

Give the lead three concise on-demand skills describing data, ideas and
validation scouts, their visibility, evidence references, useful moments and
costs. Pi receives only these explicit skills; ambient skill/context discovery
stays disabled. Bodies come from the registered prompt snapshot, are staged in
a harness-owned read-only lead mount, and carry prompt IDs and content hashes
in attempt/observability records. Scouts receive no skills. Add one coaching
note: a data or ideas consultation before the first pipeline is often worth it,
since asynchronous answers arrive during workspace setup. This is optional
finetuned coaching, not a consultation quota. No minimal-arm change.
