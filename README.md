# auto-smart-lab

Autonomous ML challenge solver for the [SmartLab](https://lab-test.smartlab.mlsec.tu-berlin.de/) adversarial-AI platform.

The agent loops: **solve → eval → submit**, with up to 3 submissions per task. Re-solving after a rejection is free; only actual submissions count toward the limit.

---

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

### 2. Fetch units from the lab

Populates `units/` with task prompts, metadata, and training data:

```bash
python3 agent/setup/fetch_units.py --insecure
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

### 4. Solve a task

```bash
npm run solve <task_id> -- --insecure [--model <model_id>]
```

Examples:

```bash
# Use default model
npm run solve spam1 -- --insecure

# Choose a specific model
npm run solve spam1 -- --insecure --model gwdg/devstral-2-123b-instruct-2512

# Override task URL manually (bypasses index.json lookup)
npm run solve spam1 -- --insecure --task-url 'https://lab-test.../units/.../tasks/.../'
```

The orchestrator will:
1. Scaffold a solver at `agent/smartlab/tasks/<task_id>.py` if missing
2. Run the **solver agent** (researches, implements, validates locally)
3. Run the **eval agent** (reviews quality, decides approve/reject)
4. On approval: **submit directly** (HTTP upload + poll for score)
5. On rejection: re-solve with feedback (free, no submission consumed)

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
│   ├── orchestrate.ts   Main entry point
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
    ├── smartlab.ts      smartlab_submit tool
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

Then register it in `agent/smartlab_agent.py`'s `TASKS` dict.

**Constraint:** stdlib Python only — no scikit-learn, numpy, or pandas. The SmartLab VM has none of these.

---

## Lab auth

`agent/setup/fetch_lab.py` handles CSRF login and cookie reuse:

```bash
cd agent/setup
export LAB_USER='...' LAB_PASS='...'
python3 fetch_lab.py --insecure login     # save session cookie
python3 fetch_lab.py --insecure get 'URL' # fetch authenticated page
```
