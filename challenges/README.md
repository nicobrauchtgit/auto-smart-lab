# Challenge store

Persistent, per-task source of truth for a SmartLab unit. This lives **above**
the transient `environment/` sandbox on purpose: it holds the prompt + data for
*every* task, while `environment/` only ever contains the **one** task the agent
is currently working on (so the agent's context is never overloaded).

```
challenges/
└── <unit>/
    ├── unit-intro.md                # shared welcome / unit description
    └── <task>/
        ├── prompt.md                # the task prompt handed to the agent
        ├── data/                    # TRAINING data (loaded by default)
        └── test/                    # TEST data (injected only on request)
```

Training and test data are kept apart on purpose: the test set is never placed
in `environment/` until it is explicitly injected (mirroring the week-two test
release), so the two sets can't leak into each other.

## Load a task into the environment

Use the loader in the setup infra (never run by the agent itself):

```bash
python3 agent/setup/load_challenge.py 01-spam/task1-spam-detection
```

This clears `environment/` and populates it with:

- `environment/README.md`  ← the task's `prompt.md`
- `environment/data/`, ...  ← the task's extracted **training** data

## Inject test data (on explicit request only)

When the agent asks for the test set, add it to the *current* environment
without clearing the agent's work:

```bash
python3 agent/setup/load_challenge.py --inject-test 01-spam/task1-spam-detection
```

## Clear the environment (before the next task)

```bash
python3 agent/setup/load_challenge.py --clear
```
