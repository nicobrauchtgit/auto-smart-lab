# Configuration reference

> Superseded by [expert-team-v2.md](expert-team-v2.md) section 5 (one `team` budget block in tool calls, plus the `supervision` block of section 6) when P6/P7 land. Accurate for the current code until then.

This file covers the harness. The settings both arms share (`online`, the chosen
`model` and all `providers`) are in `experiment.config.json` at the repository root,
described in `docs/experiment.md` there; `pipeline.config.json` must not repeat them.

All harness tuning values live in two version-controlled JSON files at the top of
`harness/finetuned/`. JSON has no comments, so this file explains every key. Restart the
pipeline process after editing; values are read once per process, and every
agent session records the effective `harness.config.json` in Langfuse
(`harness_configuration`). `agent/harness/config.ts` validates the file at
startup and rejects missing, unknown or out-of-range keys.

Secrets never go in these files: API keys live in the ignored `.env`
(see `.env.example`).

## `pipeline.config.json`: what runs

| Key | Meaning |
| --- | --- |
| `pipeline.entryStage` | First stage of a run (`solve`). |
| `pipeline.scheduling` | `"configured"`: the fixed chain from `entryStage` (solve → refit). The `"agent"` mode and its orchestrator were removed on 2026-11-11. |
| `pipeline.stages.<stage>.enabled` | Makes a stage available. `submit` is registered but runs only under an explicit controller submission policy; a configured chain stops before it. |
| `pipeline.stages.<stage>.options` | Per-stage overrides. Solve accepts `maxIterations`, `seed` and `foldPolicy`, overriding the `solve` section below. |
| `pipeline.tasks.<task>` | Typed task declaration: sample source, train/test archives, targets, metric, holdout and refit mode, submission format. |
| `agent` | Pi working directory and agent directory. |

## `harness.config.json`: how it runs

### `pipeline`
| Key | Default | Meaning |
| --- | --- | --- |
| `maxStageInvocations` | 8 | Stage invocations per pipeline run before the executor stops. |

### `session`: every agent session
| Key | Default | Meaning |
| --- | --- | --- |
| `stallMs` | 600000 (10 min) | A model request with no streamed output for this long counts as stalled. It is cancelled and resumed in the same conversation. Slow but progressing requests are never stopped. |
| `stallRetries` | 2 | Stalled requests resumed per session before the session ends with an error. |
| `maxWallMs` | 28800000 (8 h) | Safety limit only. Budgets and stall detection bound normal sessions. |

### `context`
| Key | Default | Meaning |
| --- | --- | --- |
| `handoffTokens` | 100000 | Context size at which the agent writes a handoff and continues in a fresh session. Leave room below the model window for one large turn plus the handoff request (one turn was seen adding ~19k tokens); with the 262,144-token window, 100k leaves over 160k. If the handoff request fails anyway, the harness writes a fallback handoff and the session continues. |
| `maxHandoffBytes` | 65536 | Largest accepted handoff text. |

### `research`
The research stage was removed on 2026-11-11; these keys configure the data
profile that v2's scouts will read.

| Key | Default | Meaning |
| --- | --- | --- |
| `profileTimeoutMs` | 300000 | Time limit for the harness data profile; on timeout the caller continues without it. |
| `profileTextMinPercent` | 90 | Share of text samples in both splits needed for the profile's text layer. |

### `solve`
| Key | Default | Meaning |
| --- | --- | --- |
| `maxIterations` | 6 | Harness training trials the solve agent may start. |
| `seed` | 13 | Root seed; the harness derives every fit's seed from it. |
| `foldPolicy` | `"auto"` | `"auto"` uses `foldRecommendations`; or a fixed `{ "folds": n, "repeats": m }`. |

### `holdout`: sealed confirmation split
| Key | Default | Meaning |
| --- | --- | --- |
| `targetSmallestClassRows` | 200 | Desired rows of the smallest class in the sealed split. |
| `minSmallestClassRows` | 50 | Minimum; below it no sealed split is taken. |
| `maxFraction` | 0.2 | Largest share of training rows sealed. |
| `groupFraction` | 0.1 | Share of groups (families) sealed for group tasks. |

### `foldRecommendations`
Suggested CV design by training size, read from top to bottom: the first entry
whose `belowRows` exceeds the row count applies (`null` is the catch-all). It
is a suggestion to the agent, not a constraint.

### `search`: hyperparameter search trials
| Key | Default | Meaning |
| --- | --- | --- |
| `confirmAboveSeconds` | 900 | Estimated runtime above which the agent must confirm a search. |
| `overrunFactor` | 1.5 | Multiple of the estimate after which a running search pauses. |
| `maxSeconds` | 7200 | Hard cap per search. |
| `validationTimeoutSeconds` | 60 | Time limit for validating a pipeline before any fit. |

### `supervision`: process observation for trials and shell calls
| Key | Default | Meaning |
| --- | --- | --- |
| `linesPerUpdate` | 5 | Output lines carried per update. |
| `minStallMs` | 15000 | Training silence below this never counts as stalled. |
| `stallGapMultiple` | 4 | Multiple of the observed output gap before silence counts. |
| `importPreludeMs` | 12000 | Grace for library import at process start. |
| `idleCpuPercent` | 5 | CPU below this means the training process is idle. |
| `sampleIntervalMs` | 250 | Process sampling interval. |
| `maxConcurrent` | 2 | Training processes at once. |
| `stopGraceMs` | 2000 | Time between SIGTERM and SIGKILL. |
| `outputCapBytes` | 51200 | Most output an agent is shown at once; the log keeps the rest. |
| `memoryReserveBytes` | 1073741824 | Available RAM below this stops the largest running process; memory warnings are measured against it. |
| `swapFullSeconds` | 15 | How long swap must stay full before the largest process is stopped. |
| `overrunMultiple` | 3 | Time-wasting: elapsed beyond this multiple of comparable work's wall time... |
| `overrunMinMs` | 60000 | ...and beyond this. Without comparable history nothing is reported. |

### `setup`
| Key | Default | Meaning |
| --- | --- | --- |
| `timeoutMs` | 30000 | Time limit per preflight check. |
| `modelMaxTokens` | 16 | Output tokens of the tiny live model probe. |

### `subagents`
Bounds helper agents (turn and wait timeouts, concurrency, message sizes).
