# Provider and agent pipeline

## End-to-end flow

```text
CLI / SDK options
  -> resource loader (extensions, context files, skills, prompt overrides)
  -> active tool registry
  -> buildSystemPrompt(active tool metadata)
  -> Agent state { systemPrompt, messages, tools, model }
  -> convert project-specific messages to PI LLM messages
  -> pi-agent-core loop
  -> pi-ai OpenAI Chat Completions conversion
  -> POST /chat/completions with streaming enabled
  -> assemble streamed text/thinking/tool-call deltas
  -> validate TypeBox arguments
  -> execute tool(s)
  -> append tool-result messages
  -> call provider again
  -> stop when assistant emits no tool call, or on error/abort/explicit stop
```

## 1. Session and prompt construction

`createAgentSession()` defaults to the four active tools `read`, `bash`, `edit`,
and `write`. A CLI/SDK tool allowlist replaces that default. The active tool
array is used both for the model's tool definitions and to rebuild the system
prompt.

Extensions are loaded into a registry first. Their tools only become active if
the CLI/SDK selection permits them. Project settings currently register
`smartlab_submit`, three memory tools, `web_search`, and two challenge-context
tools, but the data-research command allowlists only its chosen tools.

The default system prompt is built from:

- a fixed coding-assistant introduction;
- one line per active tool, using that tool's `promptSnippet`;
- tool-specific `promptGuidelines`;
- two fixed guidelines (concise responses and clear paths);
- pointers to PI's own documentation;
- optional project `AGENTS.md`/`CLAUDE.md` context;
- optional skills; and
- the current working directory.

There were no project context files or PI skills in the inspected repository.
The historical session file does not persist its system prompt or active tool
snapshot, so the precise historical payload cannot be recovered byte-for-byte.
The template and current-config reconstruction are in
[reconstructed-system-prompt.md](reconstructed-system-prompt.md).

## 2. Agent-loop semantics

The core loop owns an in-memory transcript. Before every provider call it:

1. optionally transforms the agent context;
2. converts custom PI messages to ordinary user/assistant/tool-result messages;
3. constructs `{ systemPrompt, messages, tools }`; and
4. calls the configured streaming provider.

After the assistant message completes, PI extracts every `toolCall` content
block. Arguments are normalized when a tool supplies `prepareArguments`, then
validated against the tool's TypeBox schema. Unknown tools and invalid arguments
become error tool results rather than crashing the loop.

Multiple calls in one assistant response are executed in parallel by default.
They become sequential only when the Agent is configured with
`toolExecution="sequential"` or any called tool declares
`executionMode="sequential"`. The standard coding tools declare neither, and
the coding-agent SDK does not override the Agent default, so the inspected PI
configuration is parallel-capable.

Results are placed back into transcript order even when execution was parallel.
Each result has PI's internal form:

```json
{
  "role": "toolResult",
  "toolCallId": "provider-call-id",
  "toolName": "bash",
  "content": [{ "type": "text", "text": "..." }],
  "details": {},
  "isError": false,
  "timestamp": 0
}
```

`details` is for PI/session/UI metadata. The OpenAI provider serializes only the
text/image `content`; details such as a diff or truncation object are not sent as
a separate provider field. Important notices are therefore also included in the
text content when the model must see them.

The loop continues while there are tool calls or queued steering/follow-up
messages. It stops naturally when the assistant response contains no tool call.
There is no numeric graph-recursion limit. This is a fundamental difference from
the LangGraph-based experiments: a long but progressing tool loop is legal in
PI.

If a provider response stops because of output length, PI refuses to execute
all tool calls in that response because their streamed JSON arguments may be
incomplete. It emits error tool results asking the model to reissue complete
calls.

## 3. SAIA OpenAI-compatible request

For the project model, PI resolves this model record:

```json
{
  "provider": "saia",
  "api": "openai-completions",
  "baseUrl": "https://chat-ai.academiccloud.de/v1",
  "id": "mistral-medium-3.5-128b",
  "reasoning": false,
  "input": ["text", "image"],
  "contextWindow": 256000,
  "maxTokens": 16384
}
```

The request is an OpenAI SDK call to `chat.completions.create()`. For the first
turn it is effectively:

```json
{
  "model": "mistral-medium-3.5-128b",
  "messages": [
    { "role": "system", "content": "<generated PI system prompt>" },
    { "role": "user", "content": [{ "type": "text", "text": "<task>" }] }
  ],
  "stream": true,
  "stream_options": { "include_usage": true },
  "store": false,
  "max_completion_tokens": 16384,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read",
        "description": "<exact tool description>",
        "parameters": { "type": "object", "required": ["path"], "properties": {} },
        "strict": false
      }
    }
  ]
}
```

The abbreviated `properties` above is expanded in the extracted
[model-facing tool catalog](model-facing-tools.json); runtime semantics are
documented in [tool-contracts.md](tool-contracts.md). The provider selects the
active allowlisted entries, preserves their active-tool order, wraps each as
`{"type":"function","function":{...}}`, and adds `"strict":false` for this
SAIA compatibility profile. The current data-research allowlist omits `edit`.

Important absences for this model/configuration:

- no `temperature` field;
- no `tool_choice` field;
- no `parallel_tool_calls` field;
- no reasoning field; and
- no custom sampling parameters.

PI's simple-stream wrapper always supplies a context-clamped maximum. With this
large context on early turns that remains 16,384, and because the SAIA URL is
not recognized as one of PI's special compatibility targets, PI uses
`max_completion_tokens`, includes `store: false`, and includes `strict: false`
on function definitions. Undefined fields are omitted by the SDK.

This differs from the Python prototype, which explicitly uses
`temperature=0` and does not configure a 16,384 output limit.

## 4. Message conversion on later turns

Assistant text blocks are concatenated to a plain string. Tool calls become:

```json
{
  "role": "assistant",
  "content": null,
  "tool_calls": [
    {
      "id": "call-id",
      "type": "function",
      "function": {
        "name": "bash",
        "arguments": "{\"command\":\"pwd\"}"
      }
    }
  ]
}
```

Tool results become standard Chat Completions messages:

```json
{
  "role": "tool",
  "content": "/project/path",
  "tool_call_id": "call-id"
}
```

Consecutive tool results are serialized consecutively. Empty results use the
placeholder `(no tool output)`. Images from tool results are moved into a
following user message when the target model accepts images.

PI repairs replay history in several cases. It drops failed/aborted assistant
messages, downgrades unsupported images to text, normalizes cross-provider tool
call IDs, and inserts a synthetic `No result provided` tool result for an
orphaned historical call.

## 5. Streaming and errors

PI consumes Server-Sent Event chunks and incrementally assembles text,
reasoning, and indexed tool-call deltas. Function arguments are accumulated as
text and parsed only when the call ends. Finish reason `tool_calls` maps to PI's
`toolUse`; `stop` maps to `stop`; `length` maps to `length`; content-filter and
unknown reasons become errors.

The provider wrapper disables the OpenAI SDK's own retries (`maxRetries: 0`). A
lower provider-retry helper can retry when configured, but project settings do
not set that retry count. The higher `AgentSession` layer separately retries a
retryable failed assistant turn up to three times by default, with 2, 4, and 8
second delays. It removes the failed assistant message from live context before
continuing, while the failure remains in the persisted session history.

The normal HTTP idle timeout is five minutes. Bash has no timeout unless the
model supplies one.

## 6. Persistence and observability implications

PI session JSONL persists model changes, user/assistant/tool-result messages,
usage, stop reasons, and tool arguments/results. It does not persist the exact
provider request, generated system prompt, active tool schemas, or active tool
order. Consequently, historical sessions are insufficient for exact prompt
replay after configuration changes.

For exact conformance work, capture the provider payload at the existing
`before_provider_request` hook or in LangChain callbacks. That is more useful
than inventing a second bespoke event format: capture the actual request plus
the framework's normal trace.

## Source map

- [`system-prompt.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/system-prompt.ts)
- [`sdk.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/sdk.ts)
- [`agent-loop.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/agent/src/agent-loop.ts)
- [`openai-completions.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/api/openai-completions.ts)
- [`transform-messages.ts`](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/api/transform-messages.ts)
