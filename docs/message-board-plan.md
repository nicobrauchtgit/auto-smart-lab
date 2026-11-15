# Shared agent message board completion plan

Status: implemented and validated on main; Google rollout is next. Requested after the
2026-11-15 journal audit. The landed contract is in
[message-board operations](../harness/finetuned/docs/message-board.md).
Experiment comparability is secondary to making the board useful; it is not a prerequisite for this work.

## Goal and existing commitments

The lead and scouts should be able to leave observations, ideas and decisions,
find earlier contributions, and continue learning across tasks, runs and model
changes within the finetuned arm. A message remains attributed to its producer
and original task; a measurement remains evidence about its original dataset.

This completes the accepted [v2 design, section 10](../harness/finetuned/docs/expert-team-v2.md),
which says the findings journal and shared code carry learning between tasks.
The [journal contract, section 4](../harness/finetuned/docs/expert-team.md)
already specifies append-only records, durable acknowledgements, evidence
references, paged views and superseding entries. The
[kickoff stream C](v2-kickoff.md) stages scout bullet append and repeat-call
recall, but does not stage the complete cross-task board or lead tools.

The original appendix specified a journal per task, while v2 promised learning
between tasks. The landed contract resolves that mismatch with one shared
board and explicit origin task metadata. Per-task adapters remain available
to legacy callers and fixtures.

## Reuse the implementation

Paths below are relative to `harness/finetuned/agent/`.

| Existing component | Keep and extend |
| --- | --- |
| `team/journal.ts` | Kernel locking, cancellation, flushed append, torn-tail recovery, validation and resolution events |
| `team/contracts.ts` | Finding kinds, author identity, evidence references and typed views |
| `team/findings.ts` | Read/add/resolve adapters, pagination and stale/unresolved reference checks |
| `team/scouts.ts` | Automatic capture of final scout bullets and role-specific evidence rules |
| `run/lead_session.ts` | Existing lead tools, measured-result feedback, resume and context replacement |
| `pipeline/setup.ts`, `team/setup.ts` | Shared prerequisites before any agent session, including standalone execution |
| `prompts/team/`, `prompts/registry.ts` | Versioned instructions, bounded recall and prompt trace metadata |

Use this journal service as the board. It needs neither a new orchestrator nor
a replacement knowledge store, vector database or external service.

## Stage 1 — Shared storage and provenance

Use `runs/finetuned/findings/journal.jsonl` as the canonical board across tasks
and runs. Extend the current record format with explicit schema version and
origin task metadata, while retaining run/invocation identity and dataset
fingerprint. Record configured producer model metadata when known; legacy
model identity may remain unknown rather than being inferred from today's
configuration. The harness supplies producer identity and the current task.

Keep the existing writer's locking, flushing and recovery behavior. Give reads
a bounded page with stable continuation, filters for task, kind, run, dataset
and text search, and an explicit way to include earlier tasks. Resolve each
reference through its entry's original task and source, rather than the task
currently reading it. Preserve stale and unresolved references visibly.

Update the contract appendix and path callers together. Preserve compatibility
for existing per-task records and callers until Stage 5 switches production
writes; avoid an intermediate release with two canonical write destinations.

Acceptance: entries from two tasks and multiple runs are discoverable through
one board; filtered pagination neither repeats nor skips matching entries;
concurrent writers, cancellation, torn tails and complete-record corruption
retain the existing guarantees. Cross-task references resolve in their origin
context. The minimal arm remains outside every board path and query.

## Stage 2 — Agent read and contribution tools

Expose the service to the lead and every scout through typed tools:

- `findings_read`: fetch full entries or bounded pages with the Stage 1 filters
  and stable entry IDs. Include source task, producer and evidence status.
- `finding_write`: contribute a short observation, idea or decision, with
  optional references to earlier entries. Preserve the current title/text
  bounds. Keep evidence requirements appropriate to the finding kind; an idea
  need not pretend to have measured support.
- `finding_resolve`: append a superseding event using the existing author
  restriction, without deleting history. Another author can cite and disagree
  with an entry by writing a new contribution.

Keep automatic scout-bullet capture, but prevent duplicate storage when a scout
explicitly posts and cites the same finding in its final answer. Use durable
request identity to make retried writes idempotent. Agents cannot supply a
different producer identity or choose arbitrary journal paths.

Keep existing kind rules: `defect` requires validation evidence; measured
`result` entries come from the harness adapter in Stage 4. All roles can
contribute ordinary observations and ideas, and the lead can record decisions.
Register tools explicitly in each role's allowlist; this does not add shell
execution to validation or write access to frozen pipeline snapshots.

Acceptance: a lead post is readable by a scout and vice versa; contributions
survive restart; duplicate requests append once; unauthorized resolutions and
forged identities are rejected. Each session's existing tool-call budget counts
board calls. No background agent or extra model call is introduced.

## Stage 3 — Useful recall in agent context

Replace same-run-only recall with a bounded board introduction at lead/scout
startup. Include recent contributions from the same task across runs and a
small selection from other tasks relevant to the current task text or question.
Start with deterministic text matching and recency, with documented limits;
full history remains available through `findings_read`.

Include IDs and source context in the introduction, and tell agents how to
read more and post what they learn. Preserve lead board position and relevant
entry IDs through resume and compaction. A repeat scout can see earlier work
without being told that a new run has no history. Record selected IDs, limits
and omitted counts so recall is inspectable.

Keep authored instructions in the prompt registry, resolved once per run.
Board entries are attributed contributions, not system instructions or proof
of correctness. A result on another dataset can motivate a trial but cannot
promote or approve the current candidate. Withheld labels and unreleased
confirmation feedback remain outside board content.

Acceptance: task B receives and can retrieve a relevant task A contribution;
a rerun sees earlier same-task work; lead compaction and scout repetition
retain board access. Fixtures prove bounded prompts, visible attribution and
stale references, and continued exclusion of development AGENTS.md markers.

## Stage 4 — Harness-measured results

Complete the result adapter already required by the journal contract. On
authoritative trial completion, append an idempotent `result` with experiment,
task, dataset and source identity, using only agent-visible harness metrics,
spread, cost and status. Connect this to the existing feedback/recovery path
so a recovered completion is neither lost nor posted twice.

Agent prose cannot manufacture a measured result. Keep smoke checks, failed or
partial trials, completed measurements and promotion decisions distinguishable.
The board remains a reference to authoritative records, not a second promotion
or readiness service. Failed verification cannot become successful validation
because a board entry says `ok`.

Acceptance: recorded values match their harness receipts; replay is
idempotent; partial/failure status is preserved; sealed feedback is absent;
cross-dataset result retrieval never grants current-task promotion evidence.

## Stage 5 — History, preflight and rollout

Inventory existing finetuned per-task journals before switching writes. Add a
dry-run and idempotent importer that preserves original task, author, dataset,
entry identity and evidence links, remaps cursors, and carries superseding
events through their entry mapping. Retain original files unchanged. Record
source-record provenance for deduplication and an import receipt with counts
and rejected records. Import known finetuned journals only; never sweep the
minimal arm or unrelated archives implicitly.

Import is deterministic file processing, without an LLM rewrite or automatic
upgrading of old claims. Missing files and unknown model identities remain
visible. Resolve legacy citation paths in their source context. Import and
new-write cutover must be coordinated so an active old writer cannot silently
leave contributions behind; inspect active sessions before applying the switch.

Declare board-path, schema, read/write destination and prompt/tool requirements
in shared preflight for the lead and scouts, including standalone paths.
Failures must prevent sessions and give actionable instructions. Preserve
bounded, non-destructive setup checks and run/invocation observability; add no
credentials for this local service. Record reads, writes, import outcomes and
reference status through existing telemetry.

Update the design appendix, team/run READMEs and cleanup queue with the landed
contract and migration status. Each checkout keeps its own finetuned board;
cross-checkout copying is a separate explicit operation, not an implied part
of shared learning within one arm.

Acceptance: repeated import produces no duplicates, historical resolutions
still work, existing journals are preserved, setup failures block agents, and
boundary tests prove no access to the other arm. An end-to-end fixture covers
task A post → task B recall/read → reply or correction → later run retrieval,
with a harness result and stale evidence represented truthfully.

## Order and completion gate

Implement Stages 1–4 against fixtures behind the existing production path,
then Stage 5 performs the migration and production cutover. They are staged
packages, not a request for parallel agents or additional runtime orchestration.

Run focused contract, tool, prompt, recovery, setup and boundary tests as each
stage lands; run `./dev bun run test:fast` during development and
`./dev bun run typecheck`. The full `./dev bun test` is required before merging.
Use a deterministic multi-task fixture to establish functionality; any later
live experiment is separately requested work. Comparability reporting may note
the deployment revision but does not block the board.


## Rollout record

The main checkout imported 259 entries from documents1, documents2, spam2 and
spam3, with no rejected records or torn tails. A repeated apply appended zero
records and skipped all 259. Source journals remain unchanged; the local
`runs/finetuned/findings/import-receipt.json` records source hashes and cursor
mappings. Runtime data is not committed or copied between checkouts. The Google
checkout must import its own history after the code cherry-pick.


## Validation

On main, `./dev bun run test:fast` passed 617 tests with 3 skips;
`./dev bun test` passed 747 tests with 3 skips (750 total, 943.61 seconds).
`./dev bun run typecheck` and whitespace checks passed. The 14 board fixtures
cover cross-task discovery, stable paging, identity restrictions, durable retry,
real Pi budgets/context exclusion, recovery, bounded recall, and import of
healthy/corrupt/torn/missing legacy sources. Lead fixtures also verify board IDs
through resume/compaction and exactly-once recovered result publication without
sealed feedback.

The initial baseline exposed unconditional task downloads in source-only stages
and split/recovery tests depending on absent fetched archives. The executor now
prepares data only for requested task requirements, and those tests own
synthetic archives; their affected suites passed before the branch merge.
No live modeling experiment was run for this feature.
