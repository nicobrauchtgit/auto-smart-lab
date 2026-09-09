# Optional subagents

This module gives a parent Pi agent independent child sessions. It is not wired
into the pipeline or enabled in configuration. There is no context cutoff,
handover, session replacement, workflow scheduler, or automatic task selection.
Pi's normal session behavior, including its default compaction, still applies.

The parent chooses tasks and receives stable handles. Each child keeps its own
conversation, tools, and final replies. Only an explicit wait returns a bounded
reply to the parent. Bash output and write-tool payloads remain in the child's
context and shared trace, so delegation reduces the parent's context usage.
It does not eliminate the child's token usage or reduce total cost by itself.

## API

`createSubagents` returns tools, parent instructions, a manager, `bindParent`, and
`close`. Tools are available before the parent session is created. Bind the
parent's observed agent run ID before its first prompt. This avoids assigning a
placeholder ID or constructing a second parent session to install tools.

| Tool | Behavior |
| --- | --- |
| `subagent_spawn({ task })` | Starts work and returns a logical handle |
| `subagent_followup({ id, message })` | Queues behind active work, or continues the idle session |
| `subagent_check({ id })` | Returns status and trace IDs without the reply |
| `subagent_list({})` | Lists only this parent's children, without replies |
| `subagent_wait({ id, timeoutMs? })` | Returns running status on timeout, or a bounded final reply |
| `subagent_cancel({ id })` | Discards queued follow-ups, stops work, and releases the session |

An idle child has finished the current request and queued follow-ups. Failed or
cancelled children cannot receive more work. Follow-ups do not interrupt an
active implementation. Cancellation stops it; completed file writes remain.
Repeated waits may read the same result. There is no unsolicited result
injection into the parent's prompt queue, and no direct child-to-child messaging.

Defaults are four active children, 32 retained handles per scope, eight queued
follow-ups per child, 32 KiB per message, and 8 KiB of final reply text. Reply
truncation preserves UTF-8 and is reported through `truncated`; the returned
`agentRunId` and `piSessionId` identify the complete trace. JSON encoding and
status metadata add bytes beyond the reply-text limit. Waits default to 30
seconds and allow at most 60 seconds. Each child request defaults to a 30-minute
timeout. Closing the scope cancels active children and releases idle sessions.

`SubagentManager` and `ChildSessionFactory` can also be used independently for
testing or a different backend. A backend must propagate abort to active tools,
settle its prompt promise after cancellation, and make `close` idempotent.

## Wiring into an observed parent

The following shows the integration order. The existing `runSession` helper
does not yet expose this opt-in path. Its legacy environment mutation remains
unchanged; do not run that helper concurrently to create children.

```ts
const observation = context.report.observation(attempt);
// Prepare once using the existing Python environment helpers. Report these
// inputs through context.report.input, and include the shared Python prompt.
const children = createSubagents({
  cwd, agentDir, model, modelRuntime,
  prompts: context.prompts,
  sharedInstructions, // RenderedPrompt[], selected explicitly for every child
  inputs: suppliedInputs,
  env: subprocessEnvironment, // complete snapshot, including Python PATH/setup
  observe: observation,
  signal,
});

// Add children.parentInstructions to the parent's selected system prompts.
// Include its reference in the parent's prompt_snapshot event.
const parentToolNames = [
  "read", "grep", "find", "ls", ...children.tools.map(tool => tool.name),
];
let parent;
let observer;
try {
  ({ session: parent } = await createAgentSession({
    cwd, agentDir, model, modelRuntime,
    resourceLoader: parentResourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    tools: parentToolNames,
    customTools: children.tools,
  }));
  observer = await observeAgentSession({
    session: parent, model: modelId, ...observation,
  });
  children.bindParent(observer.agentRunId);
  await parent.prompt(task);
} finally {
  try { await children.close(); }
  finally {
    try { await observer?.close(); }
    finally { parent?.dispose(); }
  }
}
```

The caller continues to own parent cancellation, parent prompt/input recording,
the shared trace sink, and stage lifecycle. Close children before that sink.
Child completion does not mean stage success. Keep artifact validation in the
existing executor path for standalone and pipeline commands alike.

## Guidance, tools, and environment

Authored instructions and tool descriptions live under `agent/prompts/subagents`
and use the shared typed prompt snapshot. Children receive selected shared
runtime prompts plus `subagents.child`. They receive the parent's assigned task
and follow-ups, never its full transcript. Shared Python guidance must be passed
explicitly, using the existing Devbox environment and dependency workflow.

The child resource loader disables automatic AGENTS.md/CLAUDE.md, skills,
extensions, prompt templates, and ambient system-prompt additions. A seeded
runtime AGENTS.md can be supplied through the prompt registry as shared guidance;
automatic ancestor discovery stays off. No filesystem sandbox is provided.

Children have an explicit tool allowlist. By default it contains read, grep,
find, ls, bash, write, and edit. Callers can select a subset; model-visible tools
cannot add capabilities, change cwd/model, or spawn grandchildren. Parent tools
are a separate choice, so a coordinating parent can omit bash, write, and edit.
Children share cwd and files. The parent must assign compatible file ownership;
there is no worktree isolation or automatic merge.

Bash uses an immutable environment snapshot in its spawn hook, including child
and pipeline identity. The module never assigns to or restores `process.env`.
Supply environment values directly; they are not read from a process-wide
session override and are never written into trace payloads. Other runtime code
must also avoid concurrent process-wide environment mutation. The configured
Pi model runtime owns provider authentication.

## Observability and verification

Every Pi session attaches `observeAgentSession` before prompting, using the
enclosing pipeline run, stage invocation, and attempt. `subagent_link` connects
the child agent run to its logical handle, parent agent run, and spawning tool
call. Prompt snapshots include rendered/template hashes and the effective
system prompt. Typed input metadata and effective tool/timeout configuration
are recorded separately. The same sink retains full messages, tool results,
usage, errors, and agent completion. Idle sessions stay open for follow-ups and
emit agent_run_end when released.

Scope events use a separate event sequence to avoid colliding with parent or
child observer sequences. Setup failures, queued messages, cancellations, and
settlement are recorded there. This module does not introduce new stage states
or claim to validate implementation artifacts.

Run with the project's Devbox Bun:

```sh
bun test agent/subagents agent/prompts agent/run/session_resources.test.ts
```

Tests include a scripted Pi provider with real bash execution, context retained
across follow-ups, instruction exclusion, environment separation, trace linkage,
bounded output, failure, cancellation, startup races, and queue limits. No live
provider credentials or remote tasks are used. A fixed-task evaluation is still
needed before enabling delegation in solve or research.
