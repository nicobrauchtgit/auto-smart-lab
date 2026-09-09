# auto-smart-lab

Autonomous ML challenge solver for the [SmartLab](https://lab-test.smartlab.mlsec.tu-berlin.de/) adversarial-AI platform.

The agent loops: **solve → eval → submit**, with up to 3 submissions per task. Re-solving after a rejection is free; only actual submissions count toward the limit.

Stages run through one instrumented executor. Today only research is enabled:

```bash
npm run pipeline -- unit 1 task 1        # research task 1 of unit 1 until it validates
npm run pipeline -- --list               # show locally available units and tasks
```

New modules follow the [pipeline integration and observability
contract](docs/pipeline-integration.md). `agent/pi_sdk.ts` is the standalone
observability experiment.

---

## Quick start

### 1. Prerequisites

```bash
npm install          # install PI SDK + tsx
```

Copy `.env.example` to the ignored `.env` file and configure the SmartLab web login:

```bash
LAB_USER='your_username'
LAB_PASS='your_password'
```

Quote values containing spaces or shell-special characters.

Optional — enables web search in the solver:

```bash
export TAVILY_API_KEY='...'
```

### 2. Fetch a unit from the lab

Populates `units/` with task prompts, metadata, and datasets:

```bash
npm run fetch-unit -- 01-spam
```

The fetcher verifies a per-unit data hash, resumes missing archives, and skips
dataset downloads once the local corpus matches. It also writes
`units/index.json` — a short-ID → URL mapping used by the orchestrator.

Refresh page-derived prompts and metadata without replacing matching datasets:

```bash
npm run fetch-unit -- 01-spam --refresh-metadata
```

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

### 4. Run grounded research when useful

Research is an optional module, not a mandatory pre-step. It gives the
configured model a compact task/data manifest, filesystem access to analyze the
local corpus, and bounded web search. The model improves a living document in
`runs/<task_id>/research/research.md`:

```bash
npm run research -- spam1
```

Research sessions now receive a compact startup summary of the training-label
count and class counts and percentages for the fetched spam tasks. It includes
balanced accuracy only when explicitly named in the task prompt; otherwise it
marks the metric unknown. The summary also distinguishes the majority-class
ordinary-accuracy baseline from constant-prediction balanced accuracy. It reads
only the known training labels file and records its hash in
`context.json` under `startup_profile`. Missing or malformed labels produce an
explicit unavailable result, never partial counts. Other task formats need an
explicit adapter.

Preview the injected context without starting a model or changing run files:

```bash
npm run research -- spam1 --preview-context
# Without Bun:
./node_modules/.bin/tsx agent/research_cli.ts spam1 --preview-context
```

For a comparison run, use `--no-startup-context`. The same profile remains
available in `context.json`; only its inclusion in the opening message changes.
`runs.jsonl` records `startup_context_injected` and the profile status. Research
still reproduces any cited measurements in its own analysis artifacts.
Compare fresh research workspaces, the same model and budgets, and repeated runs;
reusing an already improved `research.md` would confound a quality comparison.

The workspace also contains `task.md`, `context.json`, reproducible scripts and
measurements under `analysis/`, and an append-only `runs.jsonl` revision trace.
Research output is not cached: every invocation refreshes the input manifest,
performs dataset and internet research, and revises the existing document. The
model has filesystem and shell tools for analysis, no submission tools, at most
three web searches, and a validation/repair pass for citations and document
size.

The same module can be invoked through the orchestrator without solving:

```bash
npm run solve spam1 -- --research-only
```

### 5. Solve a task

```bash
npm run solve <task_id> -- --insecure [--model <model_id>]
```

Examples:

```bash
# Use default model
npm run solve spam1 -- --insecure

# Refresh grounded research first, then enter the solve/eval/submit loop
npm run solve spam1 -- --insecure --research

# Choose a specific model
npm run solve spam1 -- --insecure --model gwdg/devstral-2-123b-instruct-2512

# Override task URL manually (bypasses index.json lookup)
npm run solve spam1 -- --insecure --task-url 'https://lab-test.../units/.../tasks/.../'
```

The orchestrator will:
1. Optionally update grounded research when `--research` is present
2. Scaffold a solver at `agent/smartlab/tasks/<task_id>.py` if missing
3. Run the **solver agent** (implements and validates locally)
4. Run the **eval agent** (reviews quality, decides approve/reject)
5. On approval: **submit directly** (HTTP upload + poll for score)
6. On rejection: re-solve with feedback (free, no submission consumed)

---

## Models

Pipeline models are configured in `pipeline.config.json`; the project-local PI
CLI mirror is `.pi/agent/models.json`. Both currently define the SAIA/GWDG
OpenAI-compatible endpoint. The default model is:

| ID | Description |
|----|-------------|
| `saia/mistral-medium-3.5-128b` | Mistral Medium 3.5 128B |

Set `SAIA_API_KEY` in the ignored `.env` file. Pass `--model
<provider>/<model>` to select another model after adding it to
`pipeline.config.json`.

---

## Project layout

```
agent/
├── prompts/             Versioned module prompts, tool text, and typed snapshot loader
├── instructions/        Legacy copies retained for pre-migration running processes
├── research/            Research context builder and report validator
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

Local research and modeling use Devbox Python with dependencies declared in
`pyproject.toml` and resolved in `uv.lock`. Check the task's actual
dependency restrictions for code that will execute on a submission server.
See [Python environment management](agent/runtime/python/README.md).

---

## Lab auth

`agent/setup/fetch_lab.py` handles CSRF login and cookie reuse:

```bash
cd agent/setup
export LAB_USER='...' LAB_PASS='...'
python3 fetch_lab.py --insecure login     # save session cookie
python3 fetch_lab.py --insecure get 'URL' # fetch authenticated page
```
