import postgres from "postgres";

const globalForDb = globalThis;
export const sql = globalForDb.__traceDb ?? postgres({
	host: "127.0.0.1",
	port: Number(process.env.AGENT_DATABASE_PORT ?? 55433),
	database: process.env.PGDATABASE ?? "postgres",
	username: process.env.PGUSER ?? process.env.USER,
	max: 4,
});

if (process.env.NODE_ENV !== "production") globalForDb.__traceDb = sql;

export const EVENT_CHANNEL = "agent_events_insert";

export function parsePayload(value) {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return { type: "invalid_payload", raw: value };
	}
}

export async function listRuns() {
	const rows = await sql`
		WITH events AS (
			SELECT *, CASE WHEN jsonb_typeof(payload) = 'string'
				THEN (payload #>> '{}')::jsonb ELSE payload END data
			FROM agent_events
		)
		SELECT agent_run_id::text, min(observed_at) started_at,
			max(observed_at) updated_at, count(*)::int event_count,
			max(step_type) step_type,
			(array_agg(data ORDER BY sequence)
				FILTER (WHERE event_type = 'agent_run_start'))[1] start_payload,
			CASE WHEN count(*) FILTER (WHERE event_type = 'runner_error'
				OR (event_type = 'auto_retry_end' AND data->>'success' = 'false')) > 0 THEN 'failed'
				WHEN count(*) FILTER (WHERE event_type = 'agent_settled') > 0 THEN 'settled'
				ELSE 'running' END status
		FROM events GROUP BY agent_run_id ORDER BY updated_at DESC
	`;
	return rows.map(({ start_payload, ...run }) => ({
		...run,
		model: parsePayload(start_payload)?.model,
	}));
}

export async function getRunEvents(runId, after = -1) {
	const rows = await sql`
		SELECT sequence, event_type, observed_at, payload
		FROM agent_events
		WHERE agent_run_id = ${runId}::uuid AND sequence > ${after}
		ORDER BY sequence
	`;
	return rows.map(row => ({ ...row, payload: parsePayload(row.payload) }));
}

export function ensureEventNotifications() {
	globalForDb.__traceNotificationsReady ??= (async () => {
		await sql.unsafe(`
			CREATE OR REPLACE FUNCTION notify_agent_event_insert() RETURNS trigger AS $$
			BEGIN
				PERFORM pg_notify('${EVENT_CHANNEL}', json_build_object(
					'runId', NEW.agent_run_id::text, 'sequence', NEW.sequence
				)::text);
				RETURN NEW;
			END;
			$$ LANGUAGE plpgsql
		`);
		await sql.unsafe(`
			DO $$ BEGIN
				IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'agent_events_notify_insert') THEN
					CREATE TRIGGER agent_events_notify_insert AFTER INSERT ON agent_events
					FOR EACH ROW EXECUTE FUNCTION notify_agent_event_insert();
				END IF;
			END $$
		`);
	})();
	return globalForDb.__traceNotificationsReady;
}
