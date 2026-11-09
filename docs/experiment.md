# The experiment: minimal agent vs. task-adapted harness

**Question:** on the SmartLab tasks, which performs better: a single minimal agent
that is simply run, or a more complex harness adapted to the task?

Both arms live on this branch. Choose one with a flag; no branch switch.

```bash
./dev bun run experiment -- --arm minimal --check-setup
./dev bun run experiment -- --arm minimal --offline --only spam1,spam2,spam3
./dev bun run experiment -- --arm finetuned --check-setup spam1
./dev bun run experiment -- --arm finetuned spam1
./dev bun run experiment -- --arm finetuned --reset        # shows what it would delete; add --yes
```

Arguments after the flag go to the arm's own entry point:
`harness/finetuned/agent/pipeline_cli.ts` for the finetuned arm,
`harness/minimal/agent/run/solve_units.ts` for the minimal arm.

```text
harness/minimal/     the minimal agent: agent/, pipeline.config.json, requirements.*, docs/
harness/finetuned/   the task-adapted harness: agent/, pipeline.config.json,
                     harness.config.json, pyproject.toml, uv.lock, .venv, docs/
experiment/          the switch (cli.ts), run locations and jails, boundary tests
runs/minimal/        one folder per minimal run
runs/finetuned/      finetuned run state: <task>/, solutions/, knowledge/, deliveries/
units/               task data, shared and read-only for both
```

| Arm | Code | Described in |
| --- | --- | --- |
| finetuned | `harness/finetuned/` | `harness/finetuned/README.md`, `harness/finetuned/docs/pipeline-integration.md` |
| minimal | `harness/minimal/` (imported from Leo's main, history kept) | `harness/minimal/docs/AGENT.md`, `harness/minimal/docs/EXPERIMENT_LOG.md` |

## The arms must not interfere

Controller code may sit anywhere. **Agents do not leave their run location.**

| Session | Run location | Boundary |
| --- | --- | --- |
| Minimal solver | `runs/minimal/<stamp>/`: a copy of the arm's `agent/` and `.pi/`, the units, its own venv | The whole arm process runs in bubblewrap (`experiment/minimal.ts`) |
| Finetuned research | `runs/finetuned/<task>/research/` | Bubblewrap tools (`prepareResearchSandbox`) |
| Finetuned solve | `runs/finetuned/<task>/solve/agent/`, `runs/finetuned/solutions/` | Bubblewrap tools (`prepareSolveSandbox`) |
| Finetuned evaluate, orchestrator | none | No file tools, only controller tools |

Neither arm can read the other's code, prompts or state, or `.env`. `experiment/minimal.test.ts`
and `harness/finetuned/agent/run/research_sandbox.test.ts` prove this; keep them passing.

Known limit: the minimal arm's model key has to be in the arm's process, and its
shell tool drops credentials from the environment, but a command could still read
the parent's `/proc/<pid>/environ`. That exposes the model key, not the other arm.

## Starting clean

A measured run starts from scratch. The minimal arm gets a fresh location for every
invocation. The finetuned arm keeps `runs/finetuned/` (task runs, `solutions/`,
`knowledge/`) between runs on purpose, so run `--arm finetuned --reset --yes` before a
measured run. Delivered files under `runs/finetuned/deliveries/` survive a reset.

## What is compared

Results are instructor scores on the hand-over files, which have the same shape in
both arms: `output.csv` (no header, `id;prediction`), `source.zip`, `manifest.json`.

- Minimal: `runs/minimal/<stamp>/logs/deliveries/<stamp>/<task>/`
- Finetuned: `runs/finetuned/deliveries/<task>/<identity>/`

Offline mode gives no score feedback in either arm, so only offline results compare
directly. Online mode stays available for both in case the lab returns.

Tasks: only those on the shared drive. The lab VM no longer exists, so token tasks
(defense1, offense1-2) cannot run.

## Differences between the arms

These are part of what is compared. Do not equalize them; report them with results.

| | Minimal | Finetuned |
| --- | --- | --- |
| Instructions | Environment and protocol facts only, no coaching | Authored prompts per stage, with coaching |
| Stages | One solver session, then a deterministic check | Research, solve, advisory evaluate, refit |
| Who trains | The agent runs its own code | The harness runs the agent's pipeline and owns folds, seeds and promotion |
| Labels | All labels visible to the agent | A sealed split stays hidden until the terminal refit |
| Budgets | 30-minute sessions, 3 failed sessions per task | 8-hour session limit, stall detection, 6 solve iterations |
| Installing packages | Plain `pip` in its own venv | `python_environment` tool, recorded in `changes.jsonl` |
| Extra packages | None beyond the shared base | `optuna`, `dpkt`, `joblib`, `matplotlib`, `beautifulsoup4`, `cloudpickle`, `smartlab-eval` |
| Model limits | Leo's entry: 262,144 context, 32,768 output, reasoning on, `compat` set | 262,144 context, 32,768 output, reasoning on, same `compat` |
| Memory within a batch | Later tasks may reuse earlier solvers (`--reset once`) | `solutions/` and `knowledge/` carry over between tasks |

## Kept the same

Each arm has its own configuration. The values below match only because both files say so;
change them deliberately and report any difference with the results.

| | `harness/minimal/` | `harness/finetuned/` |
| --- | --- | --- |
| Model and provider | `pipeline.config.json` | `pipeline.config.json` |
| Run settings | Flags to `solve_units.ts` and constants in the arm's code | `harness.config.json`, `pipeline.config.json` |
| Python packages | `requirements.in`, `requirements.txt` | `pyproject.toml`, `uv.lock` |

- **Model and provider:** default `mythllm/qwen3.8-flash-next-a5b` with Leo's entry in both:
  262,144 context, 32,768 output, reasoning on, `compat` and `reasoning_effort: xhigh`.
  A 194,879-token prompt got a correct answer on 2026-11-09.
- **Base packages, same versions:** numpy, scipy, scikit-learn, pandas, torch (CPU build).
  `harness/minimal/requirements.txt` was pinned to match the harness's `uv.lock`; nothing keeps them in step.
- **Python, pi SDK and task data:** the interpreter from `.python-version`, pi 0.84.1, one `units/`.
- **Tools at run time:** `./dev`, bun, uv.

## Differences from Leo's earlier minimal-agent runs

Earlier results in `harness/minimal/docs/EXPERIMENT_LOG.md` are not directly comparable:

- **Packages:** the lab VM's `~/env` had 198 packages including TensorFlow, a count recorded
  in one log entry (2026-10-03). Its full list was not kept. TensorFlow is left out because it needs AVX and this VM's CPU
  (`QEMU Virtual CPU version 2.5+`) lacks it. Changing the VM's CPU type to one with AVX
  would allow re-adding it to both arms.
- **Model limits:** the arm keeps Leo's documented entry (`harness/minimal/pipeline.config.json`).
  Whether his VM's `~/.pi/agent/models.json` matched it is not recorded.
- **Runtime:** bun and pi 0.84.1 instead of tsx/node and the latest pi.
- **Visibility:** the agent no longer sees the arm's docs and logs of earlier runs, the
  other tasks' leftovers from other runs, or credentials in its shell environment.
- **Removed:** `scripts/vm/`, since the VM is gone.

`solver.md` is unchanged, so its prompt hash still matches.

## Reasoning settings measured on MythLLM

The model is hybrid: thinking is on by default, and its documentation lists effort levels
`xhigh` (default), `medium`, `low` and `none`, selected with the chat template argument
`reasoning_effort`, plus `enable_thinking`. MythLLM is LiteLLM in front of vLLM; its
model metadata lists no reasoning support for this model, so it documents nothing here.

2026-11-09, 3 requests per row, all followed the system instruction unless noted.
Question A: primes below 200 (easy). Question B: smallest n whose factorial ends in
exactly 100 zeros (405).

| Request | Q | Correct | Thinking tokens (mean) | Seconds |
| --- | --- | --- | --- | --- |
| `system` role, no parameter (`compat`, both arms) | A | 3/3 | 364 | 6 |
| `developer` role, no parameter | A | 3/3 | 679 | 10 |
| `developer` role, top-level `reasoning_effort: medium` (pi without `compat`) | A | 3/3 | 739 | 12 |
| No parameter | B | 3/3 | 442 | 11 |
| Template `reasoning_effort: xhigh` | B | 3/3 | 523 | 13 |
| Template `reasoning_effort: medium` | B | 3/3 | 476 | 11 |
| Template `reasoning_effort: low` | B | 3/3 (2/3 followed the instruction) | 673 | 16 |
| Template `reasoning_effort: none` | B | 3/3 | 644 | 10 |
| Top-level `reasoning_effort: low` | B | 3/3 | 504 | 6 |
| Template `enable_thinking: false` | B | 2/3 | 0 | 7 |

The server accepts the effort levels without error, but with three requests no level
changed the thinking length in the documented order, and `none` still thought. Either the
deployed chat template ignores `reasoning_effort` or the effect is too small to see here.
Only `enable_thinking: false` reliably turns thinking off. The `developer` role roughly
doubled the thinking, so both arms use `compat` (`system` role, no effort parameter) and
send `chat_template_kwargs: {"reasoning_effort": "xhigh"}`, the documented default and
highest level, whatever the deployment makes of it. Checked on the captured requests.
