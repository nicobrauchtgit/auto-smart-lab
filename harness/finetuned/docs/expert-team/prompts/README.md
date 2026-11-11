# Draft prompts (seeds for v2)

Drafts written for the first expert-team design. They are not
registered and not used at runtime. Under
[expert-team-v2.md](../../expert-team-v2.md) they are seeds for the lead and
scout prompts that P7a writes in `agent/prompts/team/`. The literature,
modelling and orchestrator drafts were removed: v2 has no orchestrator, the
lead builds the pipeline, and the ideas scout replaces literature.

| Draft | Seed for (v2) | Notes |
| --- | --- | --- |
| `workspace.md` | shared workspace notes for the lead and scouts | Variables `executionRules` and `predictionRules` come from `execution/` |
| `data.md` | data scout | v2 scouts return bullets with sources, not readers or checks |
| `validation.md` | validation scout | Runs on the champion's trial snapshot; returns `ok` / `fix` / `advice` |
| `execution/inductive.md`, `execution/batch.md` | execution contract fragment | Selected from `configuration.execution` |
| `execution/scalar.md`, `execution/partition.md` | prediction-domain fragment | Selected from the prediction domain |
| `label-free/data.md`, `label-free/validation.md` | P7c evidence-label fragments | See [expert-team.md section 7](../../expert-team.md#7-p7c-verification-beyond-binary-classification) |
| `label-free/orchestrator.md` | P7c label-free text for the lead | Written for the retired orchestrator |

Execution fragments are selected from typed configuration, never free-form
guidance. Every agent receives exactly one execution and one prediction-domain
fragment. P7a tests fully assembled family-clustering batch and label-free
image batch prompts, plus inductive/scalar variants, and rejects a universal
fit ban or raw cluster-ID equality. Every agent also gets the task text and the
unit introduction (v2 section 9). P7c evidence fragments do not override the
execution contract.
