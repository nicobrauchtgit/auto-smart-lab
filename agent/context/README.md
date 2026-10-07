# Smart context sessions

`SmartContextSession` owns a logical agent request across fresh Pi sessions.
The shared pipeline runner, optional Pi child backend, and `pi_sdk.ts` experiment
use it. Test fixtures that construct raw SDK sessions remain independent.

`harness.config.json` currently sets **5,000 tokens** for handoff testing; the
normal operating value is 120,000. Restart the runner after changing it. A low
threshold may cause frequent handoffs if the base prompt alone is already large.

After each assistant turn and its completed tool batch, the module records Pi's
`getContextUsage()` estimate. At the configured `context.handoffTokens` threshold or more, it stops before the
next normal model request, asks the current session for a handoff using
`context.handoff`, and starts a new in-memory Pi session with `context.resume`.
The replacement receives the original task, current request, handoff, and buffered
updates. The old transcript is retained in observability, not replayed into the
new context. Usage is an estimate; one large tool result can cross the threshold
in one turn. Unknown usage is logged and checked again after the next turn.

Handoffs run with no active tools. Empty, oversized, failed, interrupted, or
unfinished handoff responses fail explicitly; they never count as a task result.
Pi auto-compaction is disabled through in-memory settings so it does not race
with replacement. Models need sufficient context headroom above the threshold to produce
the summary; an already overflowing request can still fail at the provider.

The stage invocation, attempt, workspace, model, tool definitions, prompt
snapshot, Python environment scope, and external services survive replacement.
A new physical session has a new agent-run ID and Pi session ID. Handoff events
link old and new IDs with a handoff ID and logical-session ID under the same
pipeline identity. Stage success still depends on artifact validation. The
shared runner's timeout covers the entire logical request, including all
handoffs; child timeouts similarly cover a complete request, not each session.
Cancellation prevents launching another session.

`SmartContextSession` supplies a stable `Wakeable` facade. Experiment updates
received during a handoff are buffered and delivered to its successor, while
harness-owned training continues. Closing the context does not close the
experiment or subagent scopes; their caller retains that responsibility.

## Parent rebinding

The shared runner calls `onSessionReady` for every physical session after its
observer is attached, passing the stable facade and the current identity:

```ts
onSessionReady: (session, identity) => {
  training.bindSession(session);
  if (identity.agentRunId) subagents.bindParent(identity.agentRunId);
}
```

`subagents.bindParent` can rebind an existing scope. Future spawns use the new
parent agent-run ID. Existing children retain their original spawn parent and
remain available through the same tools, including wait and follow-up. Scope
events distinguish the active parent from an existing child's original parent.
A child's own context replacement updates the agent-run and Pi-session IDs in
its views while retaining its logical child handle and spawn provenance.

The registered pipeline does not automatically enable delegation. Callers that
opt into subagents must bind their scope through this callback.

## Tests

`bun test agent/context agent/subagents agent/run agent/prompts agent/pipeline`
uses the real Pi SDK with a scripted provider. It exercises threshold boundaries,
completed tool batches, tool-free handoffs, fresh contexts, repeated replacement,
buffered updates, identity links, cancellation, failed summaries, parent
rebinding, and continued access to existing children. Development context files
remain excluded while selected module instructions survive replacement.

## Handoff content

The handoff is a few short bullets: artifact references, the next unfinished
step, and only conversation state that cannot be recovered from artifacts.
There is no minimum length or narrative recap. This applies the artifact-reference
principle from [Matt Pocock's handoff skill](https://github.com/mattpocock/skills/blob/main/skills/productivity/handoff/SKILL.md)
as a prompt design reference; the skill is not installed or invoked. The harness
owns session replacement and retains the handoff in its observed event stream.
