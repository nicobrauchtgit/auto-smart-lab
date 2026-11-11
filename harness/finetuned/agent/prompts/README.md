# Pipeline prompts

> Superseded by [expert-team-v2.md](../../docs/expert-team-v2.md) section 11 (P7a: lead and scout prompts in `agent/prompts/team/`) when P6/P7 land. The loading, snapshot and provenance rules below stay.

Edit authored instructions here. Markdown files contain module prompts;
`tools.json` contains descriptions, guidelines, and parameter descriptions for
the project tools. TypeScript callers supply typed task data and select stable
IDs from `registry.ts`. Dataset measurements and validation errors remain data,
not alternative instruction templates.

`loadPromptSnapshot()` validates and captures all Markdown templates. The
pipeline executor creates one snapshot per run and shares it with stages. Tool definitions are immutable for the process lifetime; restart the
process to adopt edits to `tools.json`.

Solve opens with `solve.start` and `solve.observable-fits`. Measurements reach
the agent through the harness training tools (`training.*` prompts), computed by
the harness, never from what the agent reported. Advice on modelling belongs to
the agent, which is why `solve.system` describes the output contract and the
checks rather than a workflow.

Observed sessions emit `prompt_snapshot` before the first prompt, including
template IDs and hashes, authored and effective system prompts, the opening
message, rendered hashes, and the tool-definition hash. The pipeline records
the full snapshot fingerprint.

Development `AGENTS.md` and `CLAUDE.md` files are excluded by the shared resource
loader. This is automatic-context exclusion, not a filesystem sandbox.

The optional [subagent module](../subagents/README.md) uses `subagents.*` prompts
for parent/child guidance, assigned tasks, follow-ups, and tool descriptions.
These tool descriptions use the same per-run Markdown snapshot. Delegation is
not enabled in the pipeline. Its caller explicitly chooses the shared runtime
prompts supplied to children.

The `pi_sdk.ts` observability experiment takes its test opening prompt from
`pipeline.config.json`.

## Verification

Run `bun test agent/prompts agent/run/session_resources.test.ts agent/research
agent/pipeline`. These tests use temporary workspaces and do not run a model or
submit predictions.

The [smart context module](../context/README.md) uses `context.handoff` and
`context.resume` from the same immutable snapshot. `context.task` identifies a
composed opening request without moving module instructions into application
code. Handoff and resume references and message contents are recorded with the
physical session's trace.

The solve opening template declares one optional
`guidance` variable. The loader treats an omitted value as empty; callers render
`shared.stage-guidance` from the invocation's validated typed note. Literal braces
inside note content are never recursively expanded. `shared.stage-feedback` is a
separate live factual message template. Neither edits prompts at runtime. Note
hashes and artifact snapshots use supplied-input metadata, while template and
rendered hashes keep their prompt identities. See the pipeline integration guide
for provenance, bounds, feedback receipt semantics and deterministic-stage refusal.
