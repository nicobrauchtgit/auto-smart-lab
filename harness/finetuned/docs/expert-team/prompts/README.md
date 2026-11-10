# Draft expert prompts

Drafts for [expert-team.md](../../expert-team.md). Not registered. In wave 2,
P7a moves the expert drafts to `agent/prompts/experts/` and registers them; P7b
replaces the content of `agent/prompts/orchestrator/system.md`. The
`label-free/` fragments belong to P7c.

| Draft | Prompt ID | Variables | Replaces | Package |
| --- | --- | --- | --- | --- |
| `workspace.md` | `experts.workspace` | taskId, solutionsRoot, findingsPath, dataDir, testArchive | `solve.isolation`, workspace parts of research/solve prompts | P7a |
| `data.md` | `experts.data.system` | taskId, taskKind, targets | research.system (data part) | P7a |
| `literature.md` | `experts.literature.system` | taskId, taskKind, metric, maxIdeas, webSearchCalls | research.system (sources part) | P7a |
| `modelling.md` | `experts.modelling.system` | taskId, taskContract, foldRecommendation, maxTrials | solve.system, solve.start | P7a |
| `validation.md` | `experts.validation.system` | taskId, taskKind, metric | review.system | P7a |
| `orchestrator-system.md` | `orchestrator.system` | none | orchestrator.system | P7b |
| `label-free/orchestrator.md` | `orchestrator.label-free` | none | the label-free sentences of orchestrator.system | P7c |
| `label-free/data.md` | `experts.data.label-free` | none | none | P7c |
| `label-free/validation.md` | `experts.validation.label-free` | none | none | P7c |

Each expert's system prompt is: role prompt, `experts.workspace`, P1's machine
prompt, `shared.python-environment`, then the tool prompts it uses. Opening
messages carry typed inputs only (task text, configuration facts, finding IDs
from the orchestrator, guidance). The review guides per task kind
(`review.guide*`) stay and follow the validation prompt. The existing
`solve.follow-up` prompt stays for follow-up rounds.
