This is a synthetic continuity probe. Do not train or submit anything.

A child is already running; its ID is in children.json. First read packet.txt exactly once. After reading that large log, read children.json and use subagent_wait to collect the existing child's reply. If a wait times out, wait again; do not replace the child. Once its reply contains CHILD_BEFORE_OK, spawn one new child with this exact task: "Reply with CHILD_AFTER_OK and nothing else; no tools are needed." Collect that child's reply too.

Write result.json with beforeChildId, afterChildId, beforeReply, and afterReply, using the actual IDs and replies from the tools. Then return SUBAGENT_PROBE_DONE. Preserve these steps and existing child IDs across a handoff; inspect artifacts and the child list before repeating work. The large log is historical and does not need summarizing.
