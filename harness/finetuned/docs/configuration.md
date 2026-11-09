# Configuration reference

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
| `pipeline.entryStage` | First stage of a run (`research`). |
| `pipeline.scheduling` | `"agent"`: the orchestrator picks stages (the default for experiment runs). `"configured"` runs the fixed chain from `entryStage`, for development only. |
| `pipeline.stages.<stage>.enabled` | Makes a stage available. `submit` is available but only used when `online` is true in `experiment.config.json`; offline, the run hands over one refit and uploads nothing. |
| `pipeline.stages.<stage>.options` | Per-stage overrides. Research accepts `injectStartupContext`; solve accepts `maxIterations`, `seed`, `foldPolicy` and `experimentUpdateIntervalSeconds`, overriding the `solve` section below. |
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
| `lessonMaxMs` | 1800000 (30 min) | Time limit for the lesson step after a stage's work (stage report and knowledge capture). It runs after `maxWallMs` stops counting; running out ends only the lesson step, never the stage. |

### `context`
| Key | Default | Meaning |
| --- | --- | --- |
| `handoffTokens` | 100000 | Context size at which the agent writes a handoff and continues in a fresh session. Leave room below the model window for one large turn plus the handoff request (one turn was seen adding ~19k tokens); with the 262,144-token window, 100k leaves over 160k. If the handoff request fails anyway, the harness writes a fallback handoff and the session continues. |
| `maxHandoffBytes` | 65536 | Largest accepted handoff text. |

### `research`
| Key | Default | Meaning |
| --- | --- | --- |
| `maxToolCalls` | 40 | Action budget: tool calls for exploration and writing, shared by the initial and repair attempts. Shown to the agent after every tool result. |
| `focusAtRemainingPercent` | 50 | Below this share of the budget left, the agent is told to stop broad exploration. |
| `wrapUpAtRemainingPercent` | 20 | Below this share, the agent is told to write the brief now. |
| `finalizeToolCalls` | 8 | After the budget: calls left for reading, writing or editing `research.md`, and `check_brief`. Then every tool is blocked. A repair attempt gets this allowance again. |
| `bashTimeoutSeconds` | 600 | Upper bound for one research bash call; a call may ask for less. |
| `maxAttempts` | 2 | Sessions per research stage: the initial one plus one repair with validation feedback. |
| `maxFacts` | 8 | Bullets allowed in Dataset facts. |
| `maxAlternates` | 2 | Alternative routes allowed next to the recommended pipeline. |
| `maxImprovements` | 3 | Atomic next improvements allowed. |
| `maxReportBytes` | 16384 | Loose safety limit on the brief's size. |
| `maxAnalysisArtifactBytes` | 65536 | Largest analysis artifact that can be cited. |
| `webSearchCalls` | 3 | Web searches in the initial attempt (none in repair). |
| `webSearchResults` | 4 | Results per search. |
| `injectStartupContext` | true | Put the training-label counts into the opening prompt. |
| `profileTimeoutMs` | 300000 | Time limit for the harness data profile; on timeout research continues without it. |
| `profileTextMinPercent` | 90 | Share of text samples in both splits needed for the profile's text layer. |

Running out of the research budget never fails the run: the stage hands on a
partial brief (`validation.partial: true`) and solve continues.

### `solve`
| Key | Default | Meaning |
| --- | --- | --- |
| `maxIterations` | 6 | Harness training trials the solve agent may start. |
| `seed` | 13 | Root seed; the harness derives every fit's seed from it. |
| `foldPolicy` | `"auto"` | `"auto"` uses `foldRecommendations`; or a fixed `{ "folds": n, "repeats": m }`. |
| `experimentUpdateIntervalSeconds` | 30 | How often the agent is told about a running trial. |

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

### `supervisor`: training process observation
| Key | Default | Meaning |
| --- | --- | --- |
| `updateIntervalMs` | 5000 | At most one routine update to the agent per interval. |
| `linesPerUpdate` | 5 | Output lines carried per update. |
| `minStallMs` | 15000 | Training silence below this never counts as stalled. |
| `stallGapMultiple` | 4 | Multiple of the observed output gap before silence counts. |
| `importPreludeMs` | 12000 | Grace for library import at process start. |
| `idleCpuPercent` | 5 | CPU below this means the training process is idle. |
| `sampleIntervalMs` | 250 | Process sampling interval. |
| `maxConcurrent` | 2 | Training processes at once. |
| `stopGraceMs` | 2000 | Time between SIGTERM and SIGKILL. |

### `setup`
| Key | Default | Meaning |
| --- | --- | --- |
| `timeoutMs` | 30000 | Time limit per preflight check. |
| `modelMaxTokens` | 16 | Output tokens of the tiny live model probe. |

### `orchestrator`
Bounds one task's controller run. `maxWallMs` (12 h) is the run's deadline; the
orchestrator sees the time left, with notes at 50% and 20%, as information rather
than a reserve. `maxTrials` (24) with 6 trials per solve allows the first solve
round plus three follow-ups; each solve reserves its whole allocation. `maxSessions` (128),
`maxModelRequests` (4000) and `maxToolCalls` (8000) count every agent session,
model request and tool call of the run, stage agents included; they are safety
caps set well above what 12 hours use (research alone took about 100 requests and
one solve hour about 150 on spam1), so the time budget ends a run, not these.
The other keys bound stages, retries, summary sizes and notifications.

### `subagents`
Bounds helper agents (turn and wait timeouts, concurrency, message sizes).
