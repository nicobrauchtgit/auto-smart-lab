# Telemetry operations

Updated: 2026-09-09. The registered pipeline writes stage events and agent sessions to PostgreSQL and mirrors events to `runs/<task-id>/pipeline/<timestamp>-<run-id>.jsonl`. The dashboard reads PostgreSQL. It cannot display fallback-only JSONL traces.

See [pipeline-integration.md](pipeline-integration.md) for instrumentation requirements, [HANDOVER.md](HANDOVER.md) for the latest live evidence, and [WIP.md](WIP.md) for missing experiment supervision and telemetry features.

## Start and check storage

Run from the repository root:

```bash
devbox services start postgresql
devbox services ls
devbox run -- pg_isready -h 127.0.0.1 -p 55433 -d postgres
devbox run -- psql -X -h 127.0.0.1 -p 55433 -d postgres -P pager=off -c \
  'SELECT current_database(), current_user, inet_server_addr(), inet_server_port();'
```

Expected readiness is `127.0.0.1:55433 - accepting connections`. Always specify the TCP host and port. A bare `psql` can use a different Unix socket or server even when the dashboard is healthy. `-X` avoids local `psqlrc` settings changing diagnostic output.

The sink in `agent/observability.ts` and dashboard client in `agent/dashboard/lib/db.js` use:

| Setting | Current value or default |
| --- | --- |
| Host | Hard-coded `127.0.0.1` |
| Port | `AGENT_DATABASE_PORT`, default `55433` |
| Database | `PGDATABASE`, default `postgres` |
| User | `PGUSER`, falling back to `USER` |
| Dashboard port | `3001` from the `traces` script |

Devbox also sets `PGPORT=55433` for PostgreSQL CLI tools. The application uses `AGENT_DATABASE_PORT`, so changing only `PGPORT` does not move it. For custom settings, substitute the same port, database, and user in every diagnostic command. Use `-U <role>` if you need to choose a role explicitly. No password is embedded in the sink URL, and the sink disables TLS. A different host or authentication setup requires changes to both clients.

The event sink creates and migrates `agent_events` when it opens. On a fresh database the dashboard may fail until that schema exists. Starting the dashboard does not create the event table.

## Start and check the dashboard

In a separate terminal:

```bash
devbox run -- bun run traces
```

Open [the dashboard](http://localhost:3001). Check its APIs:

```bash
curl -fsS --max-time 10 http://127.0.0.1:3001/api/traces
curl -fsS -N --max-time 3 http://127.0.0.1:3001/api/traces/stream
```

The first request should return HTTP 200 with a JSON array of runs. The second should begin with:

```text
event: ready
data: {"connected":true}
```

The SSE connection stays open. Curl exit code 28 after the three-second limit is expected if it already printed `ready`; a timeout without that event is not a successful check. The server sends a heartbeat every 15 seconds. New database inserts produce `agent_event` notifications containing `runId` and `sequence`; the browser then fetches events from `/api/traces`.

SSE readiness confirms the database subscription, not the completeness of a particular run. The route creates a notification function and trigger, so its database role needs permission to do that. If run queries work but SSE fails, inspect the dashboard terminal for trigger/function permission or missing-table errors. Restart the dashboard after repairing startup or environment errors.

## Find a pipeline and its sessions

List recent pipeline identities without dumping message bodies:

```bash
devbox run -- psql -X -h 127.0.0.1 -p 55433 -d postgres -P pager=off -c "
SELECT pipeline_run_id, task_id, min(observed_at) AS started_at,
       max(observed_at) AS updated_at, count(*) AS events
FROM agent_events
WHERE pipeline_run_id IS NOT NULL
GROUP BY pipeline_run_id, task_id
ORDER BY updated_at DESC LIMIT 20;"
```

Inspect lifecycle events for the completed subagent smoke run:

```bash
devbox run -- psql -X -h 127.0.0.1 -p 55433 -d postgres -P pager=off <<'SQL'
SELECT agent_run_id, stage_invocation_id, stage, attempt, event_type, observed_at
FROM agent_events
WHERE pipeline_run_id = '518cc241-25af-4f71-bdc3-6338aabce978'
  AND event_type IN ('pipeline_run_start', 'stage_started', 'agent_run_start',
                     'agent_run_end', 'stage_finished', 'pipeline_run_end')
ORDER BY observed_at, agent_run_id, sequence;

SELECT agent_run_id,
       count(*) FILTER (WHERE event_type = 'agent_run_start') AS starts,
       count(*) FILTER (WHERE event_type = 'agent_run_end') AS ends
FROM agent_events
WHERE pipeline_run_id = '518cc241-25af-4f71-bdc3-6338aabce978'
  AND event_type IN ('agent_run_start', 'agent_run_end')
GROUP BY agent_run_id ORDER BY agent_run_id;
SQL
```

The second query should show one start and one end for parent `17790127-79c2-46fe-852e-7695db498a70` and child `af21013d-e1f9-4394-b855-2da6f3d9cc26`. Their shared stage invocation is `5889b6fc-6674-492d-b501-abf58b9e4238`. An `agent_run_end` records session closure; inspect `artifact_validation`, `stage_finished`, and the command's validation summary to determine success. The original smoke fixture reported stage success but exited nonzero on a later smoke assertion.

`sequence` is ordered within each `agent_run_id`, not across the whole pipeline. The pipeline's own lifecycle events use the pipeline UUID as their `agent_run_id`; sessions and subagent scope events have separate event sequences. Filter SQL by `pipeline_run_id` to collect the whole hierarchy.

The API's `runId` parameter instead selects one `agent_run_id`. Fetch only the needed row rather than the entire child transcript:

```bash
curl -fsS --max-time 10 \
  'http://127.0.0.1:3001/api/traces?runId=518cc241-25af-4f71-bdc3-6338aabce978&after=-1'
```

Use the largest returned `sequence` as `after` for subsequent requests. Substitute a parent or child UUID to inspect that session. `subagent_link` in the child trace records the parent, logical handle, and spawning tool-call ID.

## Degraded storage and incomplete traces

| Symptom | Check and next action |
| --- | --- |
| Database unavailable at run startup | Check explicit-host readiness and matching application settings. The pipeline can continue with the local mirror and reports degradation. Restore storage before the next run. |
| Dashboard is empty but JSONL contains the run | Query `agent_events` using the run's `pipeline_run_id`. The dashboard cannot import JSONL and there is no automatic replay/backfill. Preserve the file. |
| Database has only part of a run | Inspect CLI persistence warnings and the local mirror. A connected database does not prove every insert succeeded. Check `traceFailures` and `traceDegraded` where a command emits them. |
| Local trace is also missing or incomplete | Inspect local-write failures, filesystem permissions, and disk space. A failed mirror write is recorded as degradation; do not assume JSONL is complete. |
| API returns 500 | Check the dashboard terminal, database settings, schema, and role permissions. Restart after configuration changes. |
| API shows runs but live updates fail | Check `/api/traces/stream`, notification permissions, and proxy buffering. The SSE route uses PostgreSQL LISTEN/NOTIFY. |
| Session has a start but no end | Check the running process and later events before concluding that it is active. A crash can omit cleanup. Durable process recovery is not implemented. |

Do not overwrite failed summaries or edit trace rows to make a run appear successful. Save a reassessment beside the original evidence with its source path and hash. Restoring PostgreSQL does not prove that an earlier degraded run was repaired. The current sink records failures without a durable retry queue.

To exercise the fallback without stopping the real database, use the deterministic tests:

```bash
devbox run -- bun test agent/pipeline/executor.test.ts agent/pipeline/run_pipeline.test.ts
```

These tests deliberately point at unavailable storage. Their degraded-trace warnings are expected. A pipeline `--dry-run` checks configuration and task selection but does not generate a trace.

## Data handling and verification record

Traces currently contain full model messages and tool results. The user removed redaction and retention from the active roadmap on 2026-09-09. No automated redaction or retention policy is provided. Avoid printing full payloads during routine checks or publishing `runs/` and database exports without reviewing their contents. `.gitignore` does not remove previously tracked artifacts. Preserve the original smoke evidence.

On 2026-09-09, explicit-host PostgreSQL readiness succeeded, `/api/traces` returned HTTP 200 and included the live smoke pipeline and both sessions, and SSE emitted `ready` with `connected: true`. SQL confirmed exactly one start/end for each session. These checks validate current storage and delivery; they do not establish experiment supervision or durable recovery.
