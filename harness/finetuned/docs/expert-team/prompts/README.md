# Draft expert prompts

Drafts for [expert-team.md](../../expert-team.md). Not registered; P7a moves
them to `agent/prompts/experts/` (orchestrator: `agent/prompts/orchestrator/`),
adds them to the typed registry and tests their variables.

| Draft | Prompt ID | Variables | Replaces |
| --- | --- | --- | --- |
| `workspace.md` | `experts.workspace` | taskId, worktree, findingsPath, dataDir, testArchive | `solve.isolation`, workspace parts of research/solve system prompts |
| `data.md` | `experts.data.system` | taskId, taskKind, targets | research.system (data part) |
| `literature.md` | `experts.literature.system` | taskId, taskKind, metric, maxIdeas, webSearchCalls | research.system (sources part) |
| `modelling.md` | `experts.modelling.system` | taskId, taskContract, foldRecommendation, maxTrials | solve.system, solve.start |
| `validation.md` | `experts.validation.system` | taskId, taskKind, metric | review.system |
| `orchestrator-system.md` | `orchestrator.system` | none | orchestrator.system |

Each expert's system prompt is assembled as: role prompt, `experts.workspace`,
P1's machine prompt, `shared.python-environment`, and the tool prompts it
uses. Opening messages carry typed inputs only (task text, configuration
facts, finding IDs from the orchestrator, guidance). The review guides per
task kind (`review.guide*`) stay and follow the validation prompt.
