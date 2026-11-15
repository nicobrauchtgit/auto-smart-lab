---
name: scout-ideas
description: Consult the ideas scout for sourced feature or representation hypotheses before model choice or after measured weaknesses.
---

# Ideas scout

The ideas scout reads task text, profile, course resources, permitted input
mounts and data-scout research if present, plus earlier findings. It has read-only
file tools and web search; it cannot write code or run shell commands. It cannot
see withheld training rows or labels. It suggests representations, features and
task/metric considerations, with sources; it does not prescribe estimators,
parameter values or an architecture, or compare fitted models.

Advice: consult before choosing a model family, or after a measured weakness
or plateau. Ask for the rationale behind a representation or a focused next
hypothesis. Several narrow asynchronous questions can be more useful than one
broad survey; keep working while results arrive, and avoid answered questions.

Use `scout` with `role: "ideas"`, a focused `question`, and `refs`, for example:
"Given this trial's weakness on short messages, what representation hypothesis
is worth measuring, and why?" Attach `{experiment: "trial-id"}` and
`{entry: "finding-id"}`; add `{profile: "targetSummary"}`,
`{file: "tasks/spam1.py", line: 12}` or `{url: "https://source.example/paper"}`
when they identify relevant evidence. Use actual references from the run.

The request returns immediately. Only final sourced bullets arrive as news,
with failure/stopped/empty status where applicable, not private transcripts.
Measure any resulting comparison in the harness before treating it as evidence.
Each explicit request costs one lead tool call, even with multiple roles.
The ideas scout has a fresh configured allowance (currently 10 calls, at most
3 web searches); its calls do not consume the lead's allowance. Roles share
the configured concurrency cap (currently 3), with excess roles queued FIFO.
