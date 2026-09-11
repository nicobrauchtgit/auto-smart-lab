# auto-smart-lab

Autonomous ML challenge solver for the [SmartLab](https://lab-test.smartlab.mlsec.tu-berlin.de/) adversarial-AI platform.

The agent loops: **solve → eval → submit**, with up to 3 submissions per task. Re-solving after a rejection is free; only actual submissions count toward the limit.

---

## Design rule: barebones, no coaching

This agent exists to measure how far different models get on their own. The prompts in
`agent/instructions/` describe the **environment and protocol only** (where data is, the module
interface, session limits, the sentinel, what memory keys the orchestrator reads). They contain
**no advice** on how to solve tasks — no suggested models, features, search queries, time-management
tips or iteration recipes — and the feedback the orchestrator sends after a submission states facts
(scores, attempts left) without diagnosis. The harness itself (retries, rate-limit waits, timeout
salvage, budget control) is expected to work perfectly; that is infrastructure, not guidance.
A separately maintained, deliberately coached agent is used for other experiments.

## Quick start

### 1. Prerequisites

```bash
npm install          # install PI SDK + tsx
```

Required environment variables (add to `~/.bashrc` or `.envrc`):

```bash
export LAB_USER='your_username'
export LAB_PASS='your_password'
```

Optional — enables web search in the solver:

```bash
export TAVILY_API_KEY='...'
```

> **TLS:** the lab serves a self-signed certificate, so certificate verification is **off by
> default** for lab connections (`LAB_INSECURE_TLS=1`). Pass `--secure` to any command, or set
> `LAB_INSECURE_TLS=0`, to verify instead; the Python scripts also honour `LAB_CA_BUNDLE`.

### 2. Fetch units from the lab

Populates `units/` with task prompts, metadata, and training data:

```bash
python3 agent/setup/fetch_units.py
```

This also writes `units/index.json` — a short-ID → URL mapping used by the orchestrator.

### 3. List available tasks

```bash
npm run solve list
```

Output:

```
Available tasks:

  ID              Unit                           Task
  --------------------------------------------------------------------------------
  spam1           Introduction with Spam ;)      1. Spam Detection with Machine Learning (50 points)
  spam2           Introduction with Spam ;)      2. Spam Detection in Practice (50 points)
  spam3           Introduction with Spam ;)      3. Bonus: Webspam Detection (30 points)
  ...
```

### 4. Start from scratch

This harness is an experiment in how far an autonomous agent gets on a unit **without prior
solutions**. Before every test run, wipe all task-specific state (solver modules, agent memory,
prediction CSVs, checkpoints). Solver modules under `agent/smartlab/tasks/` are run artifacts and
are not tracked in git; what a run achieved is recorded in `logs/` and on the lab:

```bash
npm run reset            # everything
npm run reset -- spam2   # only one task
```

### 5. Solve everything: `npm run solve-units`

One command that fetches units if needed, resets, and works through every task of every unit
unattended, one task at a time:

```bash
npm run solve-units                                     # solve all open tasks, real submissions
npm run solve-units -- --plan                # only show what would run
npm run solve-units -- --no-submit           # solver + eval for every task, no uploads
npm run solve-units -- --only spam1,spam3    # subset
npm run solve-units -- --max-attempts 1      # spend at most 1 attempt per task this run
```

Before each task the driver reads the task's lab page and **skips** it when all attempts are used,
when the best existing platform score already meets `--target` (override with `--retry-solved`),
or when the task is not open yet / past its deadline. Otherwise it runs the per-task orchestrator
as a subprocess and continues with the next task whatever happens. `--reset once` (default) does a
full reset before the first task so later tasks may reuse solvers written earlier in the same run;
`--reset each` resets before every task; `--reset none` keeps existing state.

A results table is printed at the end and written, with per-task logs, to
`logs/solve-units/<timestamp>/`. Tasks run sequentially because the GWDG API budget
(~200 requests/hour) allows only two to three solver runs per hour anyway.

### 6. Solve a single task

```bash
npm run solve <task_id> [-- --model <model_id>]
```

Examples:

```bash
# Use default model
npm run solve spam1

# Choose a specific model
npm run solve spam1 -- --model gwdg/devstral-2-123b-instruct-2512

# Test solver + eval without spending one of the 3 submissions
npm run solve spam1 -- --no-submit

# Override task URL manually (bypasses index.json lookup)
npm run solve spam1 -- --task-url 'https://lab-test.../units/.../tasks/.../'
```

The orchestrator will:
1. Scaffold a solver at `agent/smartlab/tasks/<task_id>.py` if missing
2. Run the **solver agent** (researches, implements, validates locally)
3. Run the **eval agent** (reviews quality, decides approve/reject)
4. On approval: **submit directly** (HTTP upload + poll for score)
5. On rejection: re-solve with feedback (free, no submission consumed)
6. If the **platform score is below `--target`** (default 0.97) and submissions remain, the real
   score is fed back to the solver and the loop continues. Identical predictions are never
   re-submitted. The run stops at the target or when all 3 submissions are spent.
7. If a solver session hits its time cap (`--solver-timeout`, default 30 min) or ends without a CSV,
   the orchestrator **salvages** the solver module it left behind (runs `validate` + `solve`
   directly, no LLM) and continues; if there is nothing to salvage it re-runs the solver once
   with finish-first instructions.

---

## Models

Models are configured in `~/.pi/agent/models.json`. The GWDG Chat-AI provider is pre-configured. Available model IDs:

| ID | Description |
|----|-------------|
| `gwdg/devstral-2-123b-instruct-2512` | Devstral 2 123B — coding-focused |
| `gwdg/qwen3-coder-next` | Qwen3 Coder Next |
| `gwdg/qwen3.5-397b-a17b` | Qwen3.5 397B — large reasoning model (default) |
| `gwdg/deepseek-v4-flash-0731` | DeepSeek V4 Flash — fast |

Pass `--model gwdg/<id>` to select one.

---

## Project layout

```
agent/
├── instructions/        System prompts for solver, eval, and submit agents
├── memory/              Persistent memory across sessions (gitignored)
├── run/                 Orchestrator and session runners (TypeScript)
│   ├── solve_units.ts   Batch driver: fetch → reset → every open task (npm run solve-units)
│   ├── orchestrate.ts   Per-task entry point (npm run solve <task>)
│   ├── solver_session.ts
│   ├── eval_session.ts
│   └── submit_session.ts  Direct HTTP submit (no LLM)
├── setup/               Lab auth + data fetch scripts (not run by agent)
│   ├── fetch_lab.py     Login/cookie helper
│   ├── fetch_units.py   Fetch all units/tasks from the lab → units/
│   └── load_challenge.py Load a task into environment/ for manual testing
├── smartlab/            Python solver framework
│   ├── smartlab_agent.py  CLI: list / download / validate / solve
│   ├── common.py        Shared utilities (stdlib-only)
│   └── tasks/           One solver module per task (e.g. spam1.py)
└── tools/               PI extension tools
    ├── smartlab.ts      smartlab_submit tool (manual use only — NOT loaded into agent sessions; the orchestrator submits)
    ├── memory.ts        memory_read / memory_write tools
    ├── web_search.ts    web_search tool (requires TAVILY_API_KEY)
    └── challenge_context.ts  list_challenges / read_challenge tools
units/                   Task prompts, metadata, and training data
├── index.json           Short ID → task URL mapping
└── <unit-slug>/
    └── <task-slug>/
        ├── prompt.md
        ├── meta.json    { short_id, url, unit, task, ... }
        └── data/        Training data zips (extracted)
submissions/             Generated prediction CSVs
environment/             Sandbox loaded by load_challenge.py (manual testing)
```

---

## Manual task testing (without the agent)

Load a task into `environment/` and run the solver manually:

```bash
# Load training data
python3 agent/setup/load_challenge.py 01-spam/task1-spam-detection

# Run from agent/ directory
cd agent
python3 smartlab_agent.py validate spam1
python3 smartlab_agent.py solve spam1
```

---

## Adding a new task solver

The orchestrator scaffolds a stub automatically when you run `npm run solve <new_task_id>`. The solver agent fills it in.

To add one manually, create `agent/smartlab/tasks/<task_id>.py` with:

```python
from pathlib import Path
from smartlab.common import project_root

DEFAULT_SUBMISSION = project_root() / "submissions" / "<task_id>_predictions.csv"

def download(force: bool = False) -> None: ...
def validate(validation_fraction: float = 0.2, seed: int = 42) -> float: ...
def solve(output_path: Path = DEFAULT_SUBMISSION) -> Path: ...
```

`smartlab_agent.py` discovers every module in `agent/smartlab/tasks/` automatically; no registration needed.

**Constraint:** stdlib Python only — no scikit-learn, numpy, or pandas. The SmartLab VM has none of these.

---

## Lab auth

`agent/setup/fetch_lab.py` handles CSRF login and cookie reuse:

```bash
cd agent/setup
export LAB_USER='...' LAB_PASS='...'
python3 fetch_lab.py login     # save session cookie
python3 fetch_lab.py get 'URL' # fetch authenticated page
```
