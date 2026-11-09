# The experiment: minimal agent vs. task-adapted harness

**Question:** on the SmartLab tasks, which performs better: a single minimal agent
that is simply run, or a more complex harness adapted to the task?

Both arms live on this branch. Choose one with a flag; no branch switch.

```bash
./dev bun run experiment -- --arm minimal --check-setup
./dev bun run experiment -- --arm minimal --offline --only spam1,spam2,spam3
./dev bun run experiment -- --arm harness --check-setup spam1
./dev bun run experiment -- --arm harness spam1
./dev bun run experiment -- --arm harness --reset        # shows what it would delete; add --yes
```

Arguments after the flag go to the arm's own entry point: `agent/pipeline_cli.ts`
for the harness, `arms/minimal/agent/run/solve_units.ts` for the minimal arm.

| Arm | Code | Described in |
| --- | --- | --- |
| harness | `agent/` | `README.md`, `docs/pipeline-integration.md` |
| minimal | `arms/minimal/` (imported from Leo's main, history kept) | `arms/minimal/docs/AGENT.md`, `arms/minimal/docs/EXPERIMENT_LOG.md` |

## The arms must not interfere

Controller code may sit anywhere. **Agents do not leave their run location.**

| Session | Run location | Boundary |
| --- | --- | --- |
| Minimal solver | `runs/minimal/<stamp>/`: a copy of the arm's `agent/` and `.pi/`, the units, its own venv | The whole arm process runs in bubblewrap (`agent/arms/minimal.ts`) |
| Harness research | `runs/<task>/research/` | Bubblewrap tools (`prepareResearchSandbox`) |
| Harness solve | `runs/<task>/solve/agent/`, `solutions/` | Bubblewrap tools (`prepareSolveSandbox`) |
| Harness evaluate, orchestrator | none | No file tools, only controller tools |

Neither arm can read the other's code, prompts or state, or `.env`. `agent/arms/minimal.test.ts`
and `agent/run/research_sandbox.test.ts` prove this; keep them passing.

Known limit: the minimal arm's model key has to be in the arm's process, and its
shell tool drops credentials from the environment, but a command could still read
the parent's `/proc/<pid>/environ`. That exposes the model key, not the other arm.

## Starting clean

A measured run starts from scratch. The minimal arm gets a fresh location for every
invocation. The harness keeps `runs/`, `knowledge/` and `solutions/` between runs on
purpose, so run `--arm harness --reset --yes` before a measured run. Delivered files
under `runs/deliveries/` survive a reset.

## What is compared

Results are instructor scores on the hand-over files, which have the same shape in
both arms: `output.csv` (no header, `id;prediction`), `source.zip`, `manifest.json`.

- Minimal: `runs/minimal/<stamp>/logs/deliveries/<stamp>/<task>/`
- Harness: `runs/deliveries/<task>/<identity>/`

Offline mode gives no score feedback in either arm, so only offline results compare
directly. Online mode stays available for both in case the lab returns.

Tasks: only those on the shared drive. The lab VM no longer exists, so token tasks
(defense1, offense1-2) cannot run.

## Differences between the arms

These are part of what is compared. Do not equalize them; report them with results.

| | Minimal | Harness |
| --- | --- | --- |
| Instructions | Environment and protocol facts only, no coaching | Authored prompts per stage, with coaching |
| Stages | One solver session, then a deterministic check | Research, solve, advisory evaluate, refit |
| Who trains | The agent runs its own code | The harness runs the agent's pipeline and owns folds, seeds and promotion |
| Labels | All labels visible to the agent | A sealed split stays hidden until the terminal refit |
| Budgets | 30-minute sessions, 3 failed sessions per task | 8-hour session limit, stall detection, 6 solve iterations |
| Installing packages | Plain `pip` in its own venv | `python_environment` tool, recorded in `changes.jsonl` |
| Extra packages | None beyond the shared base | `optuna`, `dpkt`, `joblib`, `matplotlib`, `beautifulsoup4`, `cloudpickle`, `smartlab-eval` |
| Model limits | Leo's entry: 262,144 context, 32,768 output, reasoning on, `compat` set | 262,144 context, 32,768 output, reasoning on, no `compat` |
| Memory within a batch | Later tasks may reuse earlier solvers (`--reset once`) | `solutions/` and `knowledge/` carry over between tasks |

## Kept the same

Each arm has its own configuration. The values below match only because both files say so;
change them deliberately and report any difference with the results.

| | Minimal | Harness |
| --- | --- | --- |
| Model and provider | `arms/minimal/arm.config.json` | `pipeline.config.json` |
| Run settings | Flags to `solve_units.ts` and constants in the arm's code | `harness.config.json`, `pipeline.config.json` |
| Python packages | `arms/minimal/requirements.in`, `requirements.txt` | `pyproject.toml`, `uv.lock` |

- **Model and provider:** default `mythllm/qwen3.8-flash-next-a5b`. The limits differ for now
  (see the table above): the minimal arm keeps Leo's entry, the harness may adopt it once
  `compat` is clarified. A 194,879-token prompt got a correct answer on 2026-11-09.
- **Base packages, same versions:** numpy, scipy, scikit-learn, pandas, torch (CPU build).
  `arms/minimal/requirements.txt` was pinned to match the harness's `uv.lock`; nothing keeps them in step.
- **Python, pi SDK and task data:** the interpreter from `.python-version`, pi 0.84.1, one `units/`.
- **Tools at run time:** `./dev`, bun, uv.

## Differences from Leo's earlier minimal-agent runs

Earlier results in `arms/minimal/docs/EXPERIMENT_LOG.md` are not directly comparable:

- **Packages:** the lab VM's `~/env` had 198 packages including TensorFlow, a count recorded
  in one log entry (2026-10-03). Its full list was not kept. TensorFlow is left out because it needs AVX and this VM's CPU
  (`QEMU Virtual CPU version 2.5+`) lacks it. Changing the VM's CPU type to one with AVX
  would allow re-adding it to both arms.
- **Model limits:** the arm keeps Leo's documented entry (`arms/minimal/arm.config.json`).
  Whether his VM's `~/.pi/agent/models.json` matched it is not recorded.
- **Runtime:** bun and pi 0.84.1 instead of tsx/node and the latest pi.
- **Visibility:** the agent no longer sees the arm's docs and logs of earlier runs, the
  other tasks' leftovers from other runs, or credentials in its shell environment.
- **Removed:** `scripts/vm/`, since the VM is gone.

`solver.md` is unchanged, so its prompt hash still matches.

## Reasoning settings measured on MythLLM

2026-11-09, `qwen3.8-flash-next-a5b`, one question ("primes below 200"), 3 requests each.
All variants answered correctly and followed the system instruction.

| Request | Thinking tokens (mean) | Seconds |
| --- | --- | --- |
| `system` role, no reasoning parameter (Leo's `compat`, minimal arm) | 364 | 6 |
| `developer` role, no parameter | 679 | 10 |
| `developer` role, `reasoning_effort: medium` (harness now) | 739 | 12 |
| `system`, `reasoning_effort: low` | 382 | 7 |
| `system`, `reasoning_effort: high` | 253 | 6 |
| `system`, `chat_template_kwargs.enable_thinking: false` | 0 | 0 |

`reasoning_effort` had no consistent effect; the `developer` role roughly doubled the
thinking; only `enable_thinking: false` turns thinking off. One easy question is not a
quality comparison.
