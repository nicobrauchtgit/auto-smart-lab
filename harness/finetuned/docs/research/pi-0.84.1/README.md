# PI 0.84.1 source investigation

This report set answers a narrow question: what PI actually sends to the model,
how its tools actually work, and which differences matter when recreating the
harness in LangChain. It is based on the exact package installed by Devbox, not
on the current `main` branch or on behavioral guesses.

## Scope and provenance

- Installed package: `@earendil-works/pi-coding-agent` **0.84.1**
- Core packages: `@earendil-works/pi-agent-core` **0.84.1** and
  `@earendil-works/pi-ai` **0.84.1**
- Devbox pin: `pi-coding-agent@0.84.1`
- Upstream tag: [`v0.84.1`](https://github.com/earendil-works/pi/tree/v0.84.1)
- Local installed source:
  `/nix/store/vv5vg1l2q3lcbmhg6m4jvcsk1jdil416-pi-coding-agent-0.84.1/lib/node_modules/pi-monorepo`
- Investigated provider/model: project provider `saia`, API
  `openai-completions`, endpoint `https://chat-ai.academiccloud.de/v1`, model
  `mistral-medium-3.5-128b`

## Bottom line

PI's useful behavior does not come from a large hidden coding prompt. Its
default prompt is short. The meaningful harness behavior is distributed across
four layers:

1. A dynamically generated system prompt names only active tools and adds
   tool-specific guidelines.
2. Small, carefully described TypeBox schemas are sent as ordinary OpenAI
   function tools.
3. Tool outputs have consistent limits and continuation notices: file/search
   tools keep the beginning, while Bash keeps the end and preserves full output
   in a temporary file.
4. A purpose-built loop validates calls, executes them, appends standard tool
   results, and continues until the model emits no tool call. It has no
   LangGraph recursion counter.

PI does **not** rewrite Bash commands, prepend `head`, prohibit `ls -la`, force
one tool call at a time, or set `parallel_tool_calls=false`. When Mistral chose
`... | head`, that string came from the model. PI only limited the output after
the command ran.

The current Python prototype is not an exact port. Its prompt, tool names,
schemas, path policy, default limits, truncation direction, result strings,
editing semantics, sampling parameters, and loop termination differ. Those
differences are large enough that a model can behave differently even with the
same user prompt.

There is also a separate result from the session evidence: PI is not itself a
guardrail system. The inspected runs violated explicit call-count constraints,
used a broad cleanup command, and one run reconstructed deleted measurements
from remembered constants. PI supplied a productive coding loop, but it did not
enforce the task policy.

## Reports

- [Provider and agent pipeline](provider-pipeline.md)
- [Exact tool contracts](tool-contracts.md)
- [Exact model-facing tool catalog](model-facing-tools.json) (all seven PI
  built-ins plus the project web tool; an invocation sends only its allowlisted
  subset)
- [Reconstructed system prompt](reconstructed-system-prompt.md)
- [Comparison, session evidence, and porting recommendation](comparison-and-porting.md)

## Primary upstream files

- [System prompt builder](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/system-prompt.ts)
- [SDK/session construction](https://github.com/earendil-works/pi/blob/v0.84.1/packages/coding-agent/src/core/sdk.ts)
- [Agent loop](https://github.com/earendil-works/pi/blob/v0.84.1/packages/agent/src/agent-loop.ts)
- [OpenAI Chat Completions provider](https://github.com/earendil-works/pi/blob/v0.84.1/packages/ai/src/api/openai-completions.ts)
- [Built-in coding tools](https://github.com/earendil-works/pi/tree/v0.84.1/packages/coding-agent/src/core/tools)

The upstream repository has moved some package paths across releases. The
claims in these reports were verified against the installed compiled JavaScript;
the links above are navigation aids for the corresponding tagged source.
