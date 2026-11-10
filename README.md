# Auto SmartLab

An experiment comparing a minimal autonomous agent with a task-adapted ML harness on SmartLab tasks. Both arms share task data, model/provider configuration and offline/online mode; their instructions, execution and evidence policies intentionally differ.

Start with the **[review guide](docs/review-guide.md)** for reading order, verified command sources, status and limitations. Continue to [architecture and pipeline diagrams](docs/architecture.md), [code analysis](docs/code-analysis.md) and [architecture decisions](docs/adr/README.md).

```bash
./dev setup
./dev mise run test
./dev bun scripts/code-inventory.ts --check
```

The [experiment contract](docs/experiment.md) explains arm selection and isolation. [Cleanup queue](docs/cleanup-plan.md) owns active work; [redesign plan](docs/redesign-plan.md) records design and package status. P3 run mechanics are integrated; P1 resource-pool work is explicitly deferred from this merge. The four-expert team is a design awaiting implementation; current registered finetuned stages are research, solve, evaluate, refit and submit. [Merge evidence](docs/merge-readiness.md) separates local validation from unverified live behavior.

| Location | Purpose |
| --- | --- |
| `harness/minimal/` | Minimal arm code, configuration and historical docs |
| `harness/finetuned/` | Task-adapted harness, contracts and prompts |
| `experiment/`, `experiment.config.json` | Dispatch, confinement and shared conditions |
| `runs/` | Ignored arm-specific execution state and deliveries |
| `units/` | Ignored task material; private underscore directories excluded from agent inputs |
| `docs/` | Review navigation, decisions, plans and evidence references |

All project commands use [./dev](dev), which keeps tools and caches in `.tools/`. Credentials stay in ignored local configuration. Runtime prompts are explicitly selected from each arm; this README is development documentation.
