# Shared finetuned message board

The canonical board is `runs/finetuned/findings/journal.jsonl`, shared across
finetuned tasks and runs in one checkout. Each checkout has its own board;
cherry-picking code does not copy findings. The minimal arm is excluded.

Entries retain schema version 2, origin task, dataset fingerprint, role,
run/invocation identity, and configured producer model when known. Legacy
model identities remain unknown. The journal keeps its kernel lock, flushed
append acknowledgement, cancellation, torn-tail recovery, and rejection of
malformed complete records. References resolve using the entry's origin task.
Read responses expose stale/unresolved evidence and superseding events.

Lead and all scout sessions explicitly admit `findings_read`, `finding_write`
and `finding_resolve` through their normal tool budgets. Paths and producer
identity come from the harness. Contributions use stable request IDs, scoped
to their producer; identical retries append once, conflicting retries fail.
Only validation can post defects with trial/check evidence; only the lead can
post decisions. Agents cannot post results. Only the original role/run/invocation
can supersede its entry; others can cite it in a new contribution. History is
never deleted. A scout's final bullet citing an entry it explicitly posted is
returned without capturing that entry twice.

Reads default to the current task across runs. Set `includeOtherTasks: true`
for cross-task discovery or `taskId` for one origin. Filter by kind, run, dataset,
literal case-insensitive text, or entry IDs. Default page size is 12, maximum
100 records. Continue with the returned cursor and unchanged filters; cursor
positions include resolution events. Full entries include producer and source
context. Board files and their lock cannot be symlinked to another location.

Recall is deterministic: the latest 8 active same-task entries, plus up to 4
other-task entries ranked by overlap with the first 128 unique alphanumeric
words of length at least 4 in the task/question, then newest cursor. Each
excerpt is at most 200 characters. Evidence checks inspect up to 20 refs per
excerpt, with at most two stale and two unresolved labels (120 characters
each), and a 12,000-character limit on the serialized recall payload. Lead
resume context additionally carries its position and up to 24 prior entry IDs. Full entries remain available by ID. Recall events record selected
IDs, limits, omitted counts and board position. Lead progress retains a board
cursor and up to 24 relevant IDs across resume and context replacement.
Contributions are attributed input data, not instructions or proof. Results
on another dataset never satisfy current promotion/readiness checks.

On authoritative trial completion, the lead's feedback/recovery path records
an idempotent harness result before its feedback marker. It includes only
visible development metrics, fold spread, source identity, coverage, cost and
status. Smoke checks remain separate; failed/partial trials retain that status.
No holdout fields, labels, raw errors or arbitrary receipt fields enter results.
The board is a reference to the trial records, not a promotion service.

## Migration and setup

Stop existing pipeline, lead and scout-probe sessions before cutover. The
importer checks Linux process command lines again before appending. Custom
embedding callers must also stop their old writers before applying an import.

```
./dev bun run findings-import --dry-run
./dev bun run findings-import --apply
```

The importer inventories direct per-task journals under `runs/finetuned/`,
never minimal, probe archives or unrelated trees. It preserves originals,
attribution, dataset and original ID in provenance, namespaces imported IDs
by task, remaps entry references and superseding events, and writes a receipt
with source hashes, cursor mappings, counts and rejected sources. Repeated
imports deduplicate. Corrupt complete journals are rejected; incomplete tails
are retained in the source and reported as warnings while complete records are
imported. Missing previously imported originals remain listed in the receipt
and block preflight until restored. A rejected source blocks rollout
until explicitly addressed. Old citation paths keep their original context.

Shared `findings-board` preflight checks schema, destination access, prompt
availability and import completeness before lead/scout sessions, including
standalone execution. New bytes in old journals require another explicit
import. The importer uses shared Langfuse observability prerequisites; it adds
no provider or service credentials. Reads, writes, recall, resolutions and
results use the existing run/invocation reporter; import uses its own IDs.
The original per-task adapters remain available for legacy embedding callers
and fixtures; runtime sessions use only the shared board.
