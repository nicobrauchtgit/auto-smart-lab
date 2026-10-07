# Runtime task knowledge

The registered research, solve and evaluate sessions explicitly select
`knowledge.task` and `knowledge.refresh` from the immutable prompt snapshot.
Their authored skills are `agent/prompts/knowledge/*/SKILL.md`; tool instructions
are `knowledge/tool.md`. They are repository-versioned runtime resources, not a
host plugin installation. `selectedKnowledge()` is the small explicit skill
registry/loader. Skill IDs and template/rendered hashes are recorded in
`skill_snapshot`, separately from `task_knowledge` typed inputs. Ambient skills,
AGENTS.md and CLAUDE.md remain disabled. This does not isolate the filesystem.

`RunSessionOptions.knowledge` selects the task/dataset service. Tools are appended
to the scoped custom tool allowlist on every physical session replacement.
`PiChildOptions.knowledge` explicitly inherits the same scope for diagnostic
children, creates child-local tools and records each child's logical and physical
identity. Callers that opt into children must pass the parent knowledge options;
registered stages currently do not automatically spawn diagnostic agents. Omit
knowledge for older/non-knowledge session callers; no skill or tool is added.

## Agent-facing API

- `knowledge_search({query, limit?})`: up to 12 relevant active summaries (8 by
  default); matches title/summary/tags for the exact task and dataset, and only
  reusable applicability text for other datasets. No full-store opening injection.
- `knowledge_read({id})`: one bounded note with revision, caveats, history summary,
  origin and current evidence status. Other datasets receive only the separately
  authored reusable abstraction and origin, with no task body or measurement.
  Responses are capped at 32 KiB; metadata sections above 2 KiB expose their hash
  and byte count with details retained in the hashed evidence artifacts.
- `knowledge_capture({draft, experiment?, update?})`: creates a note, deduplicates
  an identical capture, or updates with `{id, expectedRevision}`. Draft fields:
  `title`, `summary`, `body`, `tags`, `status` (`hypothesis`, `observation`,
  `empirical`), `applicability`, `caveats`, optional `lifecycle`
  (`active`, `stale`, `superseded`) and optional `reusable`
  (`lesson`, `applicability`, `caveats`). No score or arbitrary metadata field.
  Empirical capture requires `{rootIndex, id}` referring to an existing experiment
  under controller-supplied roots; agents cannot choose evidence paths or origin.
  Current solve evidence uses root index 0. Ancestor training roots allow retained
  historical receipts to be checked on later invocations, not a new current proof.

Research's identity is its source dataset snapshot. Solve/evaluation use the exact
harness development ZIP+labels fingerprint. These are intentionally different
cohorts: a research finding is not silently promoted to a development measurement.
Use a separately marked reusable lesson to transfer applicability across scopes.
Changed source data, sealed split/seed/cohort, or development archive bytes change
identity. A same-task note from another cohort exposes only its reusable section.

## Evidence and authority

Agent prose, analyses and agent-run fits remain assertions. An empirical receipt
binds the originating task/dataset, producer, experiment, originating pipeline and
invocation (when present in the durable harness recovery record), source
commit/tree, fixed/search-winner parameters, CV scope, completion and artifact
hashes. Source/environment details remain in the hashed invocation/recovery
artifacts. The controller validates the existing training contract, hashes the
development data, and runs `verify_evidence.py` with a 10-second bound. It verifies
checksummed single/search checkpoints, fold identities, persisted predictions and
recomputed aggregate/fold metrics without importing user pipelines, fitting or
reading test/sealed labels. Files must remain unchanged through verification.
Search receipts retain winner parameters and search scope; they are not eligible
confirmation evidence. Pilot scope stays pilot scope. Missing, altered or
no-longer-supplied evidence reads as stale/unavailable; historical text remains.

A verified receipt authenticates that measurement, not the agent's interpretation,
causal explanation, comparison, or applicability on another task. Every retrieval
sets `authoritativeForCurrentRun: false`. There is no promotion/refit/submission or
training action in this service. Existing harness terminal-candidate guards remain
in force. Knowledge cannot supply pseudo-targets, scores or labels to training.

## Storage, setup and observability

Runtime state lives in project `knowledge/` (gitignored), separate from
`solutions/` and `runs/` final artifacts. `index.json` is machine-validated and
checksummed; each revision has an immutable readable `<id>-v<n>.md` mirror checked
against the index. Direct manual edits fail validation; use the service. No legacy
memory store is read or migrated. Store limits: 500 notes, 20 retained revisions
per note, 4 MiB index, bounded field lengths. A full store/history requires explicit
maintenance; it is never silently truncated. A directory lock serializes writers,
Text field limits count UTF-8 bytes, and drafts are limited to 16 KiB serialized,
so multilingual or escaped text cannot be captured beyond the bounded read budget.
Expected revisions prevent lost updates, and fsynced atomic publication prevents
partial index reads. An interrupted writer may leave an unreferenced Markdown
revision and a lock. Inspect the writer and restore state before removing its lock;
the service never steals locks or silently repairs/reset corrupt history.

The shared whole-chain/standalone preflight declares `knowledge`, checks skill/tool
resources, verifier availability, existing Python imports and store accessibility
before agents start. An absent store is valid if its parent is writable; setup
checks do not create it. No credentials, environment or dependencies are added.
`knowledge_search`, `knowledge_read`, and `knowledge_capture` record scoped agent
identities, retrieved input hashes and produced Markdown artifact hashes in the
session observer under the enclosing pipeline/invocation. Retries and handoffs
retain the same selected snapshot and durable state.

This is a local cooperative runtime boundary, not tamper-proof storage or a
filesystem sandbox. Free-text reusable abstractions must omit raw rows, labels,
predictions, sensitive data and provider payloads. Typed fields and basic secret
checks block common accidental dumps, but cannot prove that arbitrary prose is
anonymized. Underlying accessible files and an agent that can rewrite all local
harness artifacts are outside this boundary. There is no autonomous refresh
scheduler, mandatory note write or extra model call. The existing low configured
context threshold can be exceeded by a session's prompt/tool definitions; a
large diagnostic tool set may hand off after each tool batch. This adaptation
does not change the harness context policy.

Upstream attribution, pinned source and differences are recorded in
`agent/prompts/knowledge/PROVENANCE.md`, with Every's MIT `LICENSE` retained.
