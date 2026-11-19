# Auto SmartLab

An experiment comparing two harnesses for an autonomous LLM agent on SmartLab tasks: a **minimal harness** that gives the model only facts about its environment, and a **guided harness** that coaches the model and keeps control of training and validation.

Terminology, shared with the [report](report/main.pdf): a *harness* is everything around the model (prompts, tools, limits, checking and delivery code); the model running inside one is the *agent*. In folder names, configuration and the `--arm` flag the two harnesses are called `minimal` and `finetuned`, so "the finetuned arm" in older documents and run records means the guided harness.

Both harnesses share task data, model/provider configuration and offline/online mode; their instructions, execution and evidence policies intentionally differ.

Start here:

- [The experiment](docs/experiment.md): question, shared conditions, harness differences, reset and isolation.
- [Work queue](docs/cleanup-plan.md): current state, packages and follow-ups.
- [Expert team v2](harness/finetuned/docs/expert-team-v2.md): the accepted design of the guided harness, now implemented: one lead agent, asynchronous scouts (data, ideas, validation), harness-run trials and a validated terminal refit.
- [Experiment reports](docs/experiments/): one record per observed run, and the [written report](report/main.pdf).

Then [architecture](docs/architecture.md) (current diagrams), [architecture decisions](docs/adr/README.md), [task readiness](docs/tasks.md) and the [source inventory](docs/code-inventory.md).

## Commands

Run from the repository root. [dev](dev) and [mise.toml](mise.toml) keep the pinned toolchain and caches in `.tools/`. Host requirements: Linux with git, zip/unzip and curl or wget; agent confinement needs bubblewrap and working user namespaces. The finetuned Python environment is `harness/finetuned/.venv`, exposed as `VENV_DIR`.

| Command | Purpose |
| --- | --- |
| `./dev setup` | Sync managed Python and locked packages; frozen JS install |
| `./dev mise run test` | Typecheck, Bun tests, Python test suites |
| `./dev bun scripts/code-inventory.ts --check` | Verify the source inventory is fresh (without `--check`: regenerate) |
| `./dev bun run experiment -- --arm minimal --check-setup` | Minimal prerequisites |
| `./dev bun run experiment -- --arm finetuned --check-setup spam1` | Whole-chain preflight; may make a tiny explicit provider probe |
| `./dev bun run experiment -- --arm finetuned spam1` | Actual finetuned model run |
| `./dev bun run experiment -- --arm minimal --only spam1` | Actual minimal run in a fresh run directory |
| `./dev bun run experiment -- --arm finetuned --reset` | Preview state deletion; `--yes` performs it, preserving deliveries |

Shared [experiment.config.json](experiment.config.json) sets `online: false`: no uploads or fetching. Configured chains stop before submit; evaluation does not authorize it.

## Layout

| Location | Purpose |
| --- | --- |
| `harness/minimal/` | Minimal harness: code, configuration and historical docs |
| `harness/finetuned/` | Guided harness: code, contracts and prompts |
| `experiment/`, `experiment.config.json` | Dispatch, confinement and shared conditions |
| `runs/` | Ignored harness-specific execution state and deliveries |
| `units/` | Ignored task material; private underscore directories excluded from agent inputs |
| `resources/` | Course slides supplied read-only to both harnesses |
| `docs/` | Experiment, work queue, decisions, reports and archive |

Credentials stay in ignored local configuration. Runtime prompts are explicitly selected from each harness; this README is development documentation.
