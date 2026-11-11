# Auto SmartLab

An experiment comparing a minimal autonomous agent with a task-adapted ML harness on SmartLab tasks. Both arms share task data, model/provider configuration and offline/online mode; their instructions, execution and evidence policies intentionally differ.

Start here:

- [The experiment](docs/experiment.md): question, shared conditions, arm differences, reset and isolation.
- [Work queue](docs/cleanup-plan.md): current state, the running spam batch, packages and follow-ups.
- [Expert team v2](harness/finetuned/docs/expert-team-v2.md): the accepted plan for the finetuned arm (one lead agent, blocking scouts, harness-run trials). The current finetuned code still runs the old research → solve → evaluate chain until P6/P7 land.

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
| `harness/minimal/` | Minimal arm code, configuration and historical docs |
| `harness/finetuned/` | Task-adapted harness, contracts and prompts |
| `experiment/`, `experiment.config.json` | Dispatch, confinement and shared conditions |
| `runs/` | Ignored arm-specific execution state and deliveries |
| `units/` | Ignored task material; private underscore directories excluded from agent inputs |
| `resources/` | Course slides supplied read-only to both arms |
| `docs/` | Experiment, work queue, decisions, reports and archive |

Credentials stay in ignored local configuration. Runtime prompts are explicitly selected from each arm; this README is development documentation.
