---
name: refresh-task-knowledge
description: Refresh a specific retrieved ML task note when changed evidence, applicability, or contradiction makes its current guidance misleading.
---

Refresh narrowly when a retrieved note conflicts with current verified evidence, references changed artifacts, overlaps materially, or overstates its applicability. No refresh is needed solely because a new run began.

Read the note and inspect its evidence status. Missing, changed or wrong-dataset evidence cannot substantiate a current measured claim. Keep the earlier reasoning as history; update with the expected revision, explain what changed in the caveats, and mark `stale` or `superseded` when appropriate. For replacement empirical claims supply a currently validated harness experiment. Keep uncertain explanations attributed as hypotheses or observations. A version conflict requires rereading rather than overwriting another agent's work.

Reusable applicability may be narrowed without exporting task details. Do not upgrade a reusable lesson to proof on a new dataset. If the correction requires evidence unavailable in this session, mark the limitation rather than starting unrequested training or extra agent sessions. Never rewrite AGENTS.md, CLAUDE.md, scientific artifacts, or model code as a refresh side effect.

Adapted from Every's compound-engineering-plugin targeted refresh patterns; see ../PROVENANCE.md and ../LICENSE.
