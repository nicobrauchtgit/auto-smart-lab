# auto-smart-lab — what, why and how

This document is the durable context for the agent: the research question behind it, the
design rules that follow from that question, how the pieces fit together, and the operational
knowledge needed to run it. It is written for someone who has never seen the repo, human or
LLM. `README.md` is the usage guide; `docs/EXPERIMENT_LOG.md` is the dated record of runs.
Keep all three current when the agent changes.

---

## 1. What

[SmartLab](https://lab-test.smartlab.mlsec.tu-berlin.de/) is the seminar platform of the Chair of
Machine Learning and Security at TU Berlin. Students work through **units** (e.g. "Introduction
with Spam"), each consisting of **tasks** (e.g. "Spam Detection with Machine Learning"). A task
provides training data with labels and unlabeled test data; students upload a prediction CSV plus
their source code and get a score (balanced accuracy for the spam unit). Each task allows
**3 submission attempts**.

`auto-smart-lab` is an autonomous agent that logs into the lab, fetches the units, writes a
solver for each task, validates it locally, and submits — with no human in the loop.

## 2. Why

The agent is a **cheating baseline**. The question it answers is: *how far does an autonomous LLM
agent get on the seminar's units with as little upfront guidance as possible, and could a student
replicate that to bypass the learning?* Secondary questions: how do different models compare, how
many attempts do they need, and where do they fail.

Two consequences shape everything else:

1. **Every measured run starts from scratch.** No pre-written solver, no memory of earlier attempts,
   no prediction file. A student starts with an empty repository; so does the agent. `npm run reset`
   enforces this and `npm run solve-units` does it automatically. Solver modules the agent writes
   are *results*, not code: they are gitignored and deleted on reset.
2. **The agent is barebones: no coaching.** The prompts in `agent/instructions/` describe the
   environment and the protocol (where data is, the module interface, session limits, what memory
   keys the orchestrator reads, the completion sentinel). They contain **no advice** on how to solve
   tasks — no suggested models or features, no search queries, no time-management tips, no
   iteration recipes. Feedback the orchestrator sends after a submission states facts (scores,
   attempts left), not diagnoses. The point is to measure the model's own intelligence and
   approach. A separately maintained, deliberately coached agent exists for other experiments;
   do not merge its guidance into this one.

What *is* allowed, and expected to work perfectly, is **infrastructure**: retries, rate-limit
waits, timeout salvage, loop detection, attempt budgeting, correct data fetching. A harness bug
is a measurement error and must be fixed; a prompt hint is a confound and must not be added.

## 3. How

### 3.1 Components

```
npm run solve-units                 agent/run/solve_units.ts   batch driver: fetch → reset → each open task
  └─ npm run solve <task>           agent/run/orchestrate.ts   per-task loop (the unit of failure)
       ├─ solver session            agent/run/solver_session.ts + instructions/solver.md   (LLM)
       ├─ eval session              agent/run/eval_session.ts   + instructions/eval.md     (LLM)
       └─ submit                    agent/run/submit_session.ts (deterministic HTTP, no LLM)
LLM sessions run through           agent/run/session_runner.ts (pi SDK; retries, 429 sleeps, cap, loop guard)
Tools available to LLM sessions    agent/tools/{memory,web_search,challenge_context}.ts
Python side                        agent/smartlab_agent.py (CLI), agent/smartlab/common.py (helpers),
                                   agent/smartlab/tasks/<task>.py (written by the agent, gitignored)
Lab access (setup, not agent)      agent/setup/fetch_lab.py (login/cookies), fetch_units.py, reset_state.py
Task material                      units/<unit>/<task>/{prompt.md, meta.json, data/}, units/index.json
```

### 3.2 Per-task loop (`orchestrate.ts`)

1. Scaffold `agent/smartlab/tasks/<task>.py` with the required interface if it does not exist.
2. **Solver session.** The LLM reads the task via `read_challenge`, writes the module, runs
   `python3 smartlab_agent.py validate|solve <task>`, records results in memory, and ends with the
   sentinel `SOLVER_DONE val_score=… csv=… approach=…`.
3. **Eval session.** A second LLM session checks the CSV and the score against a rubric
   (approve at ≥ 0.97, conserve the last attempt, etc.) and prints `EVAL_DECISION: APPROVE|REJECT`.
   A rejection sends its feedback back to a new solver session; rejections are free.
4. **Submit.** The orchestrator uploads `output.csv` plus a `source.zip` of the repo, polls the
   task page for the new result row, parses the score and the attempts counter, and updates memory.
5. **Score-driven iteration.** If the platform score is below `--target` (default 0.97) and
   attempts remain, the score is fed back (facts only) and the loop continues. Byte-identical
   predictions are never re-submitted. `--max-attempts` caps attempts per run.
6. **Salvage.** If a solver session hits its cap (`--solver-timeout`, default 30 min) or ends
   without a CSV, the orchestrator runs the module it left behind directly (validate + solve,
   no LLM) and continues; if nothing is salvageable it re-runs the solver once.

`--no-submit` stops after eval approval and spends no attempt. Exit codes: 0 done, 1 no attempts
before start, 2 solver failed, 3 submission failed, 99 fatal.

### 3.3 Batch driver (`solve_units.ts`)

Fetches units if `units/index.json` is missing, resets once, then for every task reads the lab page
and **skips** it when attempts are exhausted, the best score already meets the target, or the task
is outside its start/deadline window. The decision comes from the platform, never from agent memory
(memory is wiped by reset and, historically, has been wrong). Tasks run sequentially; a results
table and `logs/solve-units/<stamp>/summary.json` are written.

### 3.4 Safety properties worth knowing

- **LLM sessions cannot submit.** The `smartlab_submit` tool exists for manual use only, is not
  loaded into any session, and refuses unless `SMARTLAB_ALLOW_LLM_SUBMIT=1`. On 2026-09-10 a solver
  session spent all three spam2 attempts by calling it directly; that is why.
- **Attempt budget** is read from the task page ("N of 3 attempts used") before and after every
  submission.
- **Degenerate tool loops** (same tool, same arguments, 6× in a row) abort the session and take the
  salvage path. `memory_append_session` ignores duplicate consecutive entries.
- **Rate limits** (HTTP 429) are handled by sleeping until the window resets; the wait is not
  charged to the session cap.

### 3.5 Models

Models are served by the GWDG Chat-AI API (`https://chat-ai.academiccloud.de/v1`, OpenAI-compatible,
configured in `~/.pi/agent/models.json`). Only some support tool calling, which the agent needs:

| Works with tools | Fails with tools (HTTP 500) or not served |
|---|---|
| `qwen3-coder-next` (used for all 2026-09-10 runs), `openai-gpt-oss-120b`, `devstral-2-123b-instruct-2512` | `qwen3.5-397b-a17b` (the old default), `mistral-medium-3.5-128b`, `glm-4.7`, `qwen3.6-35b-a3b`; some listed IDs 404 |

Probe a model by POSTing a completion with a `tools` array and checking for 200. Even working
models intermittently return 500 or time out; the session runner treats those as transient.
Quota per key: 30 requests/min, 200/hour, 1000/day. One from-scratch solver run costs roughly
40–100 requests, so **two to three runs per hour** is the practical ceiling.

### 3.6 Environment and access

- **VPN.** The lab host is only reachable inside the TU network/VPN. The model API is public.
- **TLS.** The lab has a self-signed certificate; verification is off by default for lab
  connections (`--secure` / `LAB_INSECURE_TLS=0` to verify, `LAB_CA_BUNDLE` for the Python scripts).
- **Secrets** live in the untracked `.env` (`LAB_USER`, `LAB_PASS`, `GWDG_API_KEY`, optional
  `TAVILY_API_KEY`); see `.env.example`. Without direnv, load them with `set -a; source .env; set +a`.
- **Python.** Solvers must be stdlib-only because the SmartLab evaluation VM has no third-party
  packages. Locally, Homebrew Python 3.14 is used; macOS has no GNU `timeout` command.
- **Malware datasets vs. endpoint protection.** Units 02-maldoc and 03-clust contain real malicious
  documents and binaries. On a Mac with Microsoft Defender (or any AV with real-time protection)
  the extracted samples get quarantined during the run — 1505 files vanished on 2026-09-13 — which
  silently corrupts training and test sets. Run those units on a machine without AV (a Linux VM, or
  the lab's own VMs), or get an exclusion for `units/`. The zip archives survive; extraction is the
  trigger.
- **Lab quirks the setup code compensates for:** task titles carry no "1." prefix, so task order is
  taken from the unit page; the task description sits in a `col-md-8` div after the `bd-title` h1;
  a logged-in page has no password form (posting to the first form would hit *logout*); the download
  host needs the lab session cookie.

## 4. Known model failure modes (observed, not fixed on purpose)

These are *results* of the experiment, handled by infrastructure but deliberately not prevented by
prompting:

- Rewrites the same archive-reading code per document (minutes per validation instead of seconds).
- Launches hyperparameter sweeps far beyond the session budget (a 210-fit grid on spam1).
- Keeps tuning past a good score until the session cap kills it (spam2 run 1: 0.905 in hand, no
  submission).
- Uses the GNU `timeout` shell command, which does not exist on macOS.
- Tries to call the `SOLVER_DONE` sentinel as a tool before printing it.
- Enters degenerate tool-call loops after finishing (46× `memory_append_session`).
- Submits on its own when given a submission tool (hence none is given).

## 5. Decisions and their reasons

| Decision | Reason |
|---|---|
| Submission is deterministic code, not an LLM tool | An LLM will spend attempts; 3 is all there are. |
| Solver modules are not tracked in git | They are results of a run, and every reset deletes them; tracking them caused churn and leaked solutions into the next run. |
| Status for skipping tasks comes from the lab page | Memory is reset per run and once missed three real submissions. |
| Salvage runs the module directly instead of re-prompting first | A finished module with a decent score is worth more than another 30 minutes of the same model. |
| Rate-limit waits do not count against the session cap | Otherwise the API's quota, not the model, decides the outcome. |
| Coaching stripped from prompts (2026-09-10) | The experiment measures the model, not our hints; a coached agent lives elsewhere. |
| Tasks run sequentially | Parallel runs only trigger 429s under the per-minute quota. |

## 6. Where to look next

- `docs/EXPERIMENT_LOG.md` — every measured run with model, scores, duration, incidents.
- `logs/` (gitignored) — full per-session logs on the machine that ran them.
- The lab's task pages — the authoritative record of attempts and scores.
- Open ideas: compare models on the same reset state; run the coached agent on the same tasks for
  a coaching-on/off comparison; make the eval rubric read the metric from the task prompt for
  non-accuracy units; add a per-run request budget so a run cannot exhaust the hourly quota for
  the next one.
