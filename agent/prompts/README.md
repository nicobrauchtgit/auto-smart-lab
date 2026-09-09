# Pipeline prompts

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
