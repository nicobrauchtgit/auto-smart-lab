# Pipeline prompts

The repository-maintained knowledge skills live under `knowledge/*/SKILL.md`.
`knowledge.task` and `knowledge.refresh` are explicitly selected runtime snapshot
resources, with `knowledge.tool` supplying their controlled tool description.
They do not enable ambient skills or development context. See
[`agent/knowledge/README.md`](../knowledge/README.md) for the API, evidence rules,
storage and child-session selection, and `knowledge/PROVENANCE.md` for the pinned
Every adaptation and retained MIT license.

Edit authored instructions here. Markdown files contain module prompts;
`tools.json` contains descriptions, guidelines, and parameter descriptions for
the project tools. TypeScript callers supply typed task data and select stable
IDs from `registry.ts`. Dataset measurements and validation errors remain data,
not alternative instruction templates.

`loadPromptSnapshot()` validates and captures all Markdown templates. The
pipeline executor creates one snapshot per run and shares it with stages and
research attempts. Standalone solver and evaluation sessions capture their own
snapshot. Tool definitions are immutable for the process lifetime; restart the
process to adopt edits to `tools.json`.

Research always starts with `research.start`, regardless of document existence
or initial validity. Later attempts append `research.validation-feedback` with
the failed checks. Sound research may remain unchanged if it satisfies the
contract for the current context, including its fingerprint and revision date.

Solve opens with `solve.start` and continues with `solve.iteration`, whose
`signal` variable is rendered from measurements recomputed by
`agent/solve/iteration.py`, never from what the agent reported. Keep it that
way: the iteration prompt reports what the predictions say and states what to do
next, and does not suggest what to try. Advice on modelling belongs to the agent,
which is why `solve.system` describes the output contract and the checks rather
than a workflow.

The `solve.*` and `solver.*` namespaces are different things. `solve.*` drives
the registered pipeline stage; `solver.*` drives the pre-executor
`orchestrate.ts` path and is unchanged.

Observed sessions emit `prompt_snapshot` before the first prompt, including
template IDs and hashes, authored and effective system prompts, the opening
message, rendered hashes, and the tool-definition hash. Research attempt events
also include the prompt references; the pipeline records the full snapshot
fingerprint. Existing standalone solver/evaluation observability gaps remain
until those modules join the executor.

Development `AGENTS.md` and `CLAUDE.md` files are excluded by the shared resource
loader. This is automatic-context exclusion, not a filesystem sandbox.

The optional [subagent module](../subagents/README.md) uses `subagents.*` prompts
for parent/child guidance, assigned tasks, follow-ups, and tool descriptions.
These tool descriptions use the same per-run Markdown snapshot. Delegation is
not enabled in the pipeline. Its caller explicitly chooses the shared runtime
prompts supplied to children.

## Compatibility during the active research run

The old `agent/instructions/` files are retained unchanged for a research process
that started before this migration. New module runners do not read them. They
are legacy copies, not another editable source of truth. Remove them only after
pre-migration processes have finished and remaining external references have
been checked. The `pi_sdk.ts` observability experiment still takes its test
opening prompt from `pipeline.config.json`.

## Verification

Run `bun test agent/prompts agent/run/session_resources.test.ts agent/research
agent/pipeline`. These tests use temporary workspaces and do not run a model,
submit predictions, or write to the live research workspace.

The [smart context module](../context/README.md) uses `context.handoff` and
`context.resume` from the same immutable snapshot. `context.task` identifies a
composed opening request without moving module instructions into application
code. Handoff and resume references and message contents are recorded with the
physical session's trace.

Research also receives `research.test-distribution` on every attempt. It defines
an explicit second pass over unlabeled test inputs to check training-pattern
applicability and possible replacement features. The context provides separate
hashed train/test references; the agent uses its existing inspection tools and
saves split-specific cited evidence. See [research workflow](../research/README.md).

Research, solve and advisory review opening templates declare one optional
`guidance` variable. The loader treats an omitted value as empty; callers render
`shared.stage-guidance` from the invocation's validated typed note. Literal braces
inside note content are never recursively expanded. `shared.stage-feedback` is a
separate live factual message template. Neither edits prompts at runtime. Note
hashes and artifact snapshots use supplied-input metadata, while template and
rendered hashes keep their prompt identities. See the pipeline integration guide
for provenance, bounds, feedback receipt semantics and deterministic-stage refusal.
