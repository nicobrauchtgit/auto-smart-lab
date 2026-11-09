# Auto SmartLab

An experiment on the [SmartLab](https://lab-test.smartlab.mlsec.tu-berlin.de/) tasks:
does a single minimal agent or a task-adapted harness perform better? Both arms live
here and are chosen with a flag.

```bash
./dev setup                                                       # toolchain, venv, JS dependencies
./dev bun run experiment -- --arm minimal --only spam1
./dev bun run experiment -- --arm finetuned spam1
```

```text
harness/minimal/     the minimal agent (Leo's arm)
harness/finetuned/   the task-adapted harness
experiment/          the switch, run locations and jails, boundary tests
runs/                run state: runs/minimal/, runs/finetuned/ (ignored by Git)
units/               task data, shared by both arms (ignored by Git)
docs/                the experiment, the work queue, open questions
experiment.config.json  shared by both arms: online or offline, provider and model
```

Start with [docs/experiment.md](docs/experiment.md). Each arm's own README describes
it: [finetuned](harness/finetuned/README.md), [minimal](harness/minimal/README.md).
Everything runs through `./dev`, which keeps the pinned toolchain under `.tools/`.
