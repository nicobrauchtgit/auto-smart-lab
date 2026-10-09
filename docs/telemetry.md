# Langfuse Cloud telemetry

Updated 2026-10-09. Langfuse Cloud owns trace storage, inspection, usage/cost
views and scores. The local dashboard, SQL trace writer, query API and routine
JSONL mirror are removed. Harness artifacts, experiment records, feedback
receipts, coordinator state and knowledge records remain local and authoritative.

## Setup

Configure the project's gitignored `.env`:

```dotenv
LANGFUSE_PUBLIC_KEY=<project public key>
LANGFUSE_SECRET_KEY=<project secret key>
LANGFUSE_BASE_URL=https://cloud.langfuse.com
LANGFUSE_TRACING_ENVIRONMENT=development
# Optional release/commit label:
LANGFUSE_RELEASE=<commit or release>
```

Use the Cloud origin for your project's region. Only HTTPS origins are accepted;
credentials, paths, queries and fragments in the URL are rejected. Both keys
must belong to that project. `./dev` loads the project environment. No local
Postgres or web server is required.

Every executing stage declares `observability`. Whole-chain and standalone
preflight check keys, the emergency destination and bounded authenticated,
read-only project access before starting agents. `--check-setup` also performs
other requested features' checks; model checks can make a tiny paid request.

```bash
./dev bun run pipeline -- spam1 --no-fetch --check-setup
```

Configuration/context previews do not require Langfuse. Credentials and raw
service errors are excluded from setup events. Langfuse variables are removed
from built-in agent bash subprocess environments; this is not a filesystem
boundary around `.env`.

## Inspect an execution

Pipeline, orchestration and standalone stage commands print a Cloud trace link
(or trace ID if project access failed). Use `pipelineRunId`, `taskId`,
`stageInvocationId`, `attempt`, `agentRunId` and `piSessionId` metadata to find work.

Each process execution has a root trace. Durable `pipelineRunId` is the Langfuse
session ID. Orchestrator resumes persist the new trace ID in the coordinator
journal and attach `previousTraceId`; physical context replacements remain
separate agent observations within the same attempt and trace.

The hierarchy is execution → stage → attempt → physical Pi session → generations
and tools. Child sessions belong to their parent session. Harness trial spans
belong to the stage, so background fits can outlive the initiating tool/session.
Setup, typed inputs, prompt identities/hashes, artifacts, handoffs, progress,
recovery and controller decisions become bounded observations.

Generations capture the final request after the controller request hook, the
terminal assistant response, model/provider, response start time, usage and
cost. Deltas and tool-result messages do not duplicate token counts. Pi input
is uncached; cache reads/writes are separate categories. Costs are Pi-calculated,
with that source recorded; absent usage/cost remains unknown. Payloads are
bounded and credentials redacted. Traces still contain task/model/tool content,
subject to the Cloud project's access and retention settings. Prompt authoring
stays in `agent/prompts/`.

`artifact_valid` scores distinguish snapshots from final stage validation via
`metadata.final`. `evaluation_readiness` is advisory. Harness metric scores carry
data, fold and source provenance; failed/worse attempts remain visible. Scores
do not select champions, authorize uploads or replace harness measurements.

## Emergency JSONL

Healthy runs create no fallback trace. Failed exports/scores, queue limits or
telemetry mapping activate:

```text
runs/<task-id>/pipeline/<timestamp>-<execution-id>.emergency.jsonl
```

Its coverage header explains that it contains exact failed sanitized observation
batches/scores and subsequent bounded domain events. It is not a full transcript
of observations already accepted by Cloud. There is no fallback UI, automatic
replay or historical backfill. Preserve it for diagnosis. Legacy JSONL and old
database data remain historical archives.

Missing/invalid credentials block execution. Initial network/service outages
block by default; the controller can explicitly allow emergency mode:

```bash
./dev bun run pipeline -- spam1 --allow-telemetry-fallback
```

The same flag exists on `orchestrate`, `research`, `solve-stage`, `evaluate-stage`
and `refit-stage`. It never bypasses invalid credentials or other prerequisites.
Mid-run delivery failures activate fallback automatically, preserving artifact
validation, promotion and process ownership.

Span queues, payload size, retries and timeouts are bounded. Close ends
incomplete scopes, awaits scores and flushes the SDK. Returned `traceDegraded`,
`traceFailures` and optional `localTracePath` include final-flush failures.
Fallback write failures are reported; recovery does not erase a degradation
incident. The artifact root is independent of the optional emergency path.

## Checks and troubleshooting

```bash
# In-memory fixtures; no Cloud/model calls:
./dev bun test agent/telemetry agent/pipeline agent/subagents
# Explicit synthetic write/readback; no model request or training fit:
./dev bun run telemetry:smoke
# Complete validation:
./dev mise run test
```

The smoke verifies observations, parent IDs, token totals and scores after a
bounded ingestion wait, and prints the trace link. The official Langfuse client
supplies SDK version headers required by Cloud routing; HTTP success alone does
not establish trace readback. Partial OTLP rejection preserves the affected batch.

For setup failures, check project credentials, region, network and emergency
permissions without printing keys or headers. For partial traces, inspect CLI
warnings and the emergency file. Do not alter authoritative artifacts to make
telemetry look successful. Langfuse is not a restart-recovery database.

Bun/OTel integration and synthetic Cloud readback were verified on 2026-10-09:
18 observations, two separate validation scores and three synthetic tokens, with
no emergency trace. Strict type checking, 523 TypeScript tests and 150 Python
tests pass; five TypeScript tests are skipped. The final affected-path suite also
passes all 117 checks. These checks do not establish live model/training or lab
readiness. See
[cleanup-plan.md](cleanup-plan.md) for remaining operational work.
