# Scout budget evaluation, 2026-11-11

Configured provider: experiment.config.json (mythllm/qwen3.8-flash-next-a5b).
Runs are serial; each scout works alone. Model preflight probes are separate
from scout tool-call counts. No trials, promotions or submissions are made.
Outputs: runs/finetuned/scout-dry-run/; batch launch and logs:
runs/finetuned/scout-budget/. Validation is deferred until stream B's frozen
snapshot/check adapter merges; no live-source substitute was used.

The first spam1/data/10 probe used the migrated standalone opening and
recorded its raw final answer. Later probes use the blocking service, supply
task/unit text inline, and filter headings from the final answer. This is a
context-delivery difference, so those two spam1 data runs do not isolate a
budget effect. All findings are attributed scout observations, not independent
verification or measured model improvements.

Starting budgets remain provisional: data 15, ideas 10 (at most three web
searches), validation 10 pending its snapshot evaluation.

Measurements and finding summaries will be added once the serial matrix ends.
