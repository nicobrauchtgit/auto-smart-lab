# Langfuse observability replacement

Implemented 2026-10-09. Configured, standalone and orchestrated execution now use
Langfuse Cloud. The custom dashboard, SQL writer, trace APIs, dependencies and
`traces` command are removed. Healthy runs produce no JSONL. See
[telemetry.md](telemetry.md) for the operational contract.

The Bun/OTel gate passed with SDK 5.13.1 and OpenTelemetry 2.12.0. Synthetic Cloud
readback verified session/generation/tool hierarchy, token totals and scores
without model or training calls. Partial rejection, final flush, prerequisites,
context replacement, oversized IO and bounded queues have regression coverage.
Strict type checking, 523 TypeScript tests and 150 Python tests pass (five TS
tests skipped). The final Cloud smoke read back 18 observations and two scores.
The following
records the cutover design; remaining work lives in [cleanup-plan.md](cleanup-plan.md).

## Agreed scope

Use **Langfuse Cloud** for trace storage, inspection, usage/cost views and
observation scores. Keep JSONL **solely as an emergency fallback**. Remove the
custom trace database, schema/migrations, query API, SSE service and dashboard
after proving the replacement works.

Retain pipeline reporting semantics and the small Pi-to-Langfuse adapter needed
to describe this application's execution. Replacing storage and UI does not
remove instrumentation. Keep authoritative harness artifacts, experiment logs,
recovery journals, coordinator state, knowledge storage and the submission
ledger. None of those should depend on querying Langfuse.

Keep authored prompts and their typed loader in `agent/prompts/`. Record their
identities, content hashes and rendered hashes in Langfuse. Moving prompt
authoring to Langfuse, adding hosted datasets or replacing harness selection
with Langfuse experiments is outside this migration.

## Pre-migration baseline (historical)

- `agent/observability.ts` opens Bun SQL, creates/migrates `agent_events`, writes
  every event to PostgreSQL and optionally JSONL, and subscribes to Pi sessions.
- `agent/pipeline/trace.ts` gives the executor, stages and sessions one sink,
  with pipeline, invocation and attempt identities. It always creates a local
  pipeline trace file.
- `agent/run/session_runner.ts` attaches the observer before prompting and
  records prompt snapshots, runtime inputs and context handoffs. Physical
  sessions can be replaced within one logical attempt.
- `agent/pipeline/executor.ts` and `agent/orchestrator/run.ts` own configured and
  dynamic execution respectively. Both use shared preflight/reporting. Dynamic
  execution also resumes durable runs and can have overlapping invocations.
- Training/experiment supervisors report lifecycle, progress, recovery and
  results through callbacks. They also maintain operational records needed for
  process ownership and evidence; those records stay.
- `agent/dashboard/` is a PostgreSQL-only Next.js UI with trace queries and SSE.
  `package.json` and `mise.toml` contain its dependencies and database settings.

The cleanup baseline reports unavailable local trace database access. Do not
make a working old database a prerequisite for validating the new backend.

## Target integration

Use the current OpenTelemetry-based JS/TS packages: `@langfuse/tracing`,
`@langfuse/otel`, `@langfuse/client`, `@opentelemetry/api` and the compatible
OpenTelemetry SDK packages. Initialize one provider/processor per process,
before instrumented execution. Pin a tested version combination in `bun.lock`.
Langfuse documents Node.js 20+ for its tracing/export packages; this repository
uses Bun, so Bun compatibility is an explicit first milestone, not an assumed
support guarantee. [SDK reference](https://js.reference.langfuse.com/modules/_langfuse_client.html/),
[SDK setup](https://langfuse.com/docs/observability/sdk/overview).

Use the current v5 SDK line and v4-compatible ingestion rather than starting
with legacy `langfuse.trace()` APIs. At research time Langfuse's Cloud upgrade
guidance specifies JS/TS 5.4.0 or later; recheck and pin exact releases at
implementation time. [Cloud compatibility guidance](https://langfuse.com/faq/all/upgrade-to-langfuse-v4).

Recommended code layout:

- `agent/telemetry/runtime.ts`: typed config, provider/client lifetime, export
  health and bounded flush/shutdown.
- `agent/telemetry/pi.ts`: Pi session/model/tool lifecycle translation.
- `agent/telemetry/metadata.ts`: versioned identity and payload conversion.
- `agent/telemetry/emergency.ts`: minimal failure-only JSONL writing.
- `agent/pipeline/trace.ts`: pipeline/stage reporter facade using observations.

Keep `report.input(...)`, `report.event(...)` and
`report.observation(attempt)` as the integration surface. Replace the
SQL-shaped `EventSink` and `databaseConnected` concepts with an observation
context and delivery status. Avoid retaining the old event database design
behind a renamed exporter. Domain callbacks can remain; translate them at their
shared reporting boundary. Tests use an injected in-memory transport/provider
and require no Cloud credentials.

### Observation hierarchy

One pipeline execution creates a trace with a root workflow observation:

```text
pipeline execution
  setup checks
  orchestrator attempt / physical session (dynamic scheduling)
    model generation
    controller tool -> linked stage invocation
  stage invocation: research / solve / evaluate / refit / submit
    supplied inputs and validation events
    agent attempt
      physical Pi session
        model generation
        tool execution
    harness trial / experiment
      progress events and measurements
    artifact validation and stage outcome
```

This is a logical outline, not a requirement to invent missing lifecycle events.
Stage invocations stay under the execution root; retain the triggering
orchestrator tool/decision as an explicit ID/link rather than parenting long
work to a tool call that may already have ended. Harness trials stay under the
stage even when the requesting tool returns immediately.

Use explicit parent observation/context handles for subscriptions, detached
workers and parallel stages. Never rely on whichever async context happens to
be active when a callback arrives. Langfuse manual observations support explicit
children and require explicit completion. [Instrumentation](https://langfuse.com/docs/observability/sdk/instrumentation).

Preserve existing UUIDs as domain metadata. OTel trace/span IDs have their own
format; do not pass invocation UUIDs directly as span IDs. Persist the current
execution's trace ID alongside coordinator state where resumption needs it.
Each process execution, including a resume, gets a new root trace; group them by
the durable `pipelineRunId` as Langfuse session ID and link previous execution
and invocation IDs. This avoids keeping a completed root open across crashes
or creating duplicate stage lifetimes. Record reconciliation as reconciliation,
not a second execution of already completed work.

### Data mapping

| Existing signal | Langfuse representation |
| --- | --- |
| Pipeline start/end | Root input/output, effective config/fingerprint, scheduling, outcome and stop reason |
| Setup start/check/end | Setup span and bounded check results, including pre-session failures |
| Stage start/end | Invocation span with typed options, upstream references, validated artifacts and explicit outcome |
| Stage inputs | Versioned input metadata/events: kind, delivery, availability and hashes |
| Agent attempts and physical sessions | Separate spans/agent observations with attempt and session identities |
| Prompt snapshots | Selected prompt IDs, template/rendered hashes, authored/effective instructions and opening messages |
| Model requests | Generation observations with captured request/response, model/provider, parameters, usage and cost |
| Tool start/end | One tool observation per call ID with arguments, result, timing and failure |
| Retry, handoff, decision, recovery | Typed point-in-time observations under the owning scope |
| Harness trials and fits | Stage-owned spans; trial/fold/seed/source identities and controller measurements |
| Progress | Bounded periodic events and terminal summaries; keep full worker logs in existing artifacts |
| Validation and review | Validation events and selected observation-scoped scores |

Every applicable observation carries `taskId`, `pipelineRunId`,
`executionId`, `stageInvocationId`, `stage`, `attempt`, `agentRunId`,
`piSessionId` and relevant tool/experiment IDs. Include telemetry schema version,
code revision, environment, dataset/source/fold identities and configuration
fingerprints. Keep stable filter keys separate from large nested payloads.

Pi translation must use authoritative terminal messages for totals, ignore
non-assistant messages when creating generations, and pair tools by call ID.
Do not create a generation for every streamed delta or charge tool-result
messages again. Capture the assembled model request at an appropriate Pi hook;
if subscriptions cannot expose it, add the narrow request hook rather than
guessing the request from a session transcript. Mark unavailable request/usage
data explicitly. Preserve retries/errors and first-response timing when exposed.
End open observations on session error/abort even without a terminal message.

Map Pi input/output/cache token and cost fields deliberately; cached usage is
not necessarily additive to reported input. Prefer reported cost, distinguish
provider-reported from calculated cost, and show unknown cost as unknown.
Test totals against representative Pi messages and the runner's budget totals.

Publish a small score set: artifact validity, advisory evaluation readiness and
harness-measured trial metrics where they exist. Attach scores to the owning
observation with deterministic IDs, metric/objective and dataset/fold provenance.
Langfuse supports observation-targeted scores and caller-supplied IDs.
[Scores API/SDK](https://langfuse.com/docs/evaluation/evaluation-methods/scores-via-sdk).
Do not compare unlike measurement identities, turn a completed agent session
into stage success, or use exported scores to authorize promotion/submission.
Sealed confirmation remains controller-owned and must not be exposed to solve
through a new query tool.

### Delivery and emergency fallback

Healthy runs export only to Cloud. No routine JSONL mirror, local query service,
fallback dashboard or automatic historical backfill remains.

Use SDK batching/retries with bounded queues, export timeouts and shutdown.
End children before parents, flush both observation and score queues, and derive
the final CLI telemetry status **after** flushing. In particular,
`orchestrator/run.ts` currently constructs its result before `finally` closes
the trace; the new result must include any final delivery failures.
Langfuse documents final flush for short-lived processes.
[Batching and lifecycle](https://langfuse.com/docs/observability/features/queuing-batching).

The compatibility spike must identify how the pinned exporter reports failed
batches and how to retain those failed payloads. Do not equate a resolved flush
promise with acknowledged delivery; exporters can report errors outside promise
rejection. Route sanitized SDK diagnostics/export outcomes to a run-scoped
health tracker. Prefer supported hooks; if needed, wrap the supported OTel
exporter boundary without duplicating Langfuse's protocol. This is a cutover
gate: failure detection and recoverable failed records must be demonstrated.

On a detected export failure or queue overflow, append a versioned emergency
journal containing the failed batch where available, affected IDs/time range,
delivery reason, and subsequent observations/events. Maintain only bounded
in-memory pending records, not an unlimited transcript. Include root/stage
context and score records so the file is interpretable. If a supported hook
cannot identify an exact failed batch, dump retained pending context and label
coverage uncertain; do not claim a complete copy. Record dropped-record counts.

Open `runs/<task>/pipeline/<timestamp>-<execution-id>.emergency.jsonl` only
when needed. The journal stays active for that execution once failure occurs;
later successful exports do not erase the incident. Report Cloud trace URL,
degraded status, affected coverage and optional emergency path separately from
the pipeline's validated outcome. A failed emergency write produces a visible
bounded warning too. Hard termination can lose buffered data; an emergency-only
file is not an always-on durable replay queue.

Default policy: after successful startup preflight, a Cloud outage does not
kill harness work or change promotion/submission rules. Keep execution running
with degraded telemetry and emergency recording. Missing/invalid credentials
fail preflight before any agents start. An initial network outage also fails
normal preflight; allow fallback-only execution only via an explicit controller
option such as `--allow-telemetry-fallback`, never by silently treating missing
configuration as an offline run.

### Configuration and preflight

Recommend the EU Cloud endpoint (`https://cloud.langfuse.com`); use the endpoint
matching the actual project region. Set `LANGFUSE_PUBLIC_KEY`,
`LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` and a non-secret environment label
through the existing project `.env`/typed configuration path. The Public API
documents a read-only authenticated projects request suitable for checking
credentials and region. [Public API](https://langfuse.com/docs/api-and-data-platform/features/public-api).

Add a shared `observability` setup requirement for every executing stage and
orchestrator, including deterministic ones. Both whole-chain and standalone
checks validate installed SDK/runtime, endpoint/configuration, writable
emergency destination, and bounded authenticated project access. Collect local
failures before remote probes. `--check-setup` must start no agents and write no
synthetic generation; report local setup failures in CLI/emergency diagnostics
when Cloud cannot receive them. List/dry-run and unrelated utilities need no
Langfuse credentials.

Only the controller owns Cloud credentials. Audit the actual worker/subprocess
environment construction: do not pass keys into solve workspaces, Python workers
or agent-accessible subprocesses by inheritance. Existing filesystem isolation
does not by itself establish credential isolation. Export from the controller
using existing harness callbacks; no Python SDK dependency is needed initially.
Sanitize credential fields/headers and bounded errors consistently before
Cloud export and emergency writing. Preserve the existing rule against raw
provider errors. Store dataset/artifact references and hashes, not wholesale
archives, predictions or environment dumps. Existing local paths are references,
not downloadable Cloud attachments.

## Implementation sequence and gates

1. **Prove the SDK path.** Add pinned dependencies and an injected telemetry
   runtime. Under `./dev bun`, exercise nested/parallel observations, generation
   usage, scores, batching, error detection, emergency writing and clean exit.
   Use a tiny synthetic trace for the live Cloud ingestion/readback check;
   document it as a separate smoke operation from read-only setup. Stop cutover
   if Bun context propagation or failure reporting is unreliable; resolve that
   within the project toolchain before changing production execution.
2. **Replace pipeline reporting.** Wire the root, setup, stage and validation
   observations through the existing executor and reporter. Add shared
   preflight and finalized CLI telemetry results. Cover configured runs,
   standalone deterministic stages, rejected inputs and setup-only runs.
3. **Replace Pi and harness observation.** Attach the new observer before the
   first prompt in the shared runner. Cover attempts, physical handoffs,
   retry/error/cancellation, tools, detached trials, progress and measurements.
   Update dynamic orchestration, recovery and optional subagent paths; preserve
   execution guards and `noContextFiles: true`.
4. **Validate parity and outage behavior.** Compare fixture traces against the
   required signal inventory, then inspect a credentialed small pipeline in
   Cloud. Prove initial invalid credentials prevent execution, mid-run outage
   preserves worker ownership/evidence, final export failure reaches CLI status,
   and healthy runs create no emergency file. Resolve gaps before deletion.
5. **Remove the custom stack.** Delete `agent/dashboard/`, the `traces` script,
   SQL schema/migrations and event-table/notification code. Remove direct
   `next`, `react`, `react-dom`, `postgres`, Tailwind and PostCSS dependencies
   and their dedicated files; update `bun.lock`. Remove trace-only `PG*` and
   `AGENT_DATABASE_PORT` settings after checking all references. Replace old
   `EventSink` imports/test fakes and `databaseConnected`/mandatory local-path
   result fields. Check `pi_sdk.ts`, optional subagent smoke paths and all CLIs.
6. **Finish operations and contracts.** Rewrite `docs/telemetry.md` around Cloud
   setup, trace links and emergency diagnostics; update README, AGENTS.md and
   pipeline integration references. Mark historical dashboard instructions as
   superseded. Run `./dev mise run test` and the bounded Cloud smoke check.

Migration comparison can temporarily use a test-only recording transport or
explicit old-path fixture capture. The completed production path has one Cloud
exporter and the emergency writer, with no dual-write/Postgres mode.

Preserve existing local traces and any old database data as historical archives;
do not drop tables, delete evidence or stop unrelated system services as part
of code cleanup. Remove the application's dependency on that database. No
bulk import of historical transcripts is required for this cutover.

## Acceptance criteria

- Cloud shows root → stage → attempt/session → generation/tool relationships,
  plus stage-owned trials, with correct identities during concurrency/resume.
- Research, solve, evaluation, refit, policy-authorized submission and dynamic
  orchestration use the same reporting path; configured chains still stop
  before submit. Preflight covers the full requested chain.
- Artifact validity determines stage outcome; agent completion and telemetry
  delivery are separately visible. Model/tool errors and cancellation close
  observations without abandoning workers or cleanup.
- Token/cost totals and tool counts match authoritative fixture records; no
  streamed-delta inflation. Prompt/input/config identities remain inspectable.
- Healthy execution writes no fallback trace. Initial setup failures, mid-run
  outage, queue overflow, flush failure and fallback-write failure have tested,
  explicit behavior and bounded resource use.
- Cloud readback verifies the synthetic smoke trace and scores after bounded
  ingestion delay; credentials/headers do not appear in exported or local data.
- Harness evidence, recovery, knowledge and submission authority work without
  reading Cloud. Runtime prompts still exclude repository guidance.
- No custom dashboard, SQL writer, trace query API or tracing dependency on
  Postgres remains. Full project checks pass after dependency removal.

Remaining provisioning inputs: the Cloud project, its region/key pair and an
environment label. EU is the proposed default; provisioning and live tests are
implementation work, not actions performed by this planning change.
