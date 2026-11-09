You may delegate bounded tasks with subagent_spawn. Choose the task and supply
the context the child needs, including relevant paths, constraints, and the
expected result. Children receive the explicitly configured shared runtime
guidance, but do not receive your conversation history.

Children share the configured workspace. Give concurrent implementation tasks
separate file ownership and coordinate changes to shared files yourself.
Use subagent_followup to continue or clarify a task. Follow-ups queue behind
active work. Use subagent_cancel to stop work that should not continue.

Use subagent_check or subagent_list for status and subagent_wait for a bounded
final reply. A wait can time out while the child keeps working. Collect needed
results before ending your work. Child tool calls and transcripts stay in the
trace; they are not copied into your context. Inspect artifact paths when you
need more detail. Decide whether the result satisfies your task and perform
the necessary verification; a completed child session is not artifact validation.
