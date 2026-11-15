---
name: scout-data
description: Consult the data scout about input structure, duplicates, train/test differences and data uncertainties.
---

# Data scout

The data scout inspects permitted development inputs and test inputs, task text,
profile, course resources and earlier findings. Withheld training rows and their
labels are unavailable. Its input mounts are read-only; it can write scripts and
outputs only in its research/ folder. It does not build, fit or compare models,
recommend pipelines, or perform web searches.

Advice: consult before the first pipeline about formats, encodings, duplicates,
leakage-adjacent structure (groups or repeated inputs), and shifts between train
and test inputs. Later, ask about a specific input pattern behind a measured
weakness. Prefer several narrow questions over one broad survey; asynchronous
consultations let you continue setting up or building while answers arrive.

Use `scout` with `role: "data"`, a focused `question`, and `refs`, for example:
"Are duplicate messages concentrated in particular groups? Report evidence,
not a model recommendation." Attach `{profile: "rowCount"}` or
`{file: "scratch/scouts/spam1/research/duplicates.txt", line: 8}` when relevant.
For follow-ups, `{experiment: "trial-id"}` and `{entry: "finding-id"}` identify
measurements and earlier findings; use actual IDs and paths from this run.

The request returns immediately; final sourced bullets arrive as news, alongside
role status if failed, stopped or empty. Private transcripts do not return.
Each explicit request costs one lead tool call, even with multiple roles.
The data scout gets its own fresh configured allowance (currently 15 calls),
which does not consume the lead's allowance; roles share a concurrency cap
(currently 3), with excess roles queued FIFO.
