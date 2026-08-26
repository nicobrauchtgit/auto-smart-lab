import { hostname } from "node:os";

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { SQL } from "bun";

const CREATE_EVENTS_TABLE = `
	CREATE TABLE IF NOT EXISTS agent_events (
		agent_run_id uuid NOT NULL,
		sequence integer NOT NULL,
		pi_session_id text NOT NULL,
		process_id integer NOT NULL,
		worker_id text NOT NULL,
		step_type text,
		event_type text NOT NULL,
		observed_at timestamptz NOT NULL,
		payload jsonb NOT NULL,
		PRIMARY KEY (agent_run_id, sequence)
	)
`;

export interface ObservabilityOptions {
	session: AgentSession;
	model: string;
	stepType?: string | null;
}

export async function observeAgentSession(options: ObservabilityOptions) {
	const { session, model } = options;
	const agentRunId = crypto.randomUUID();
	const processId = process.pid;
	const workerId = hostname();
	const stepType = options.stepType ?? process.env.AGENT_STEP_TYPE ?? null;
	const database = process.env.PGDATABASE ?? "postgres";
	const databaseUser = process.env.PGUSER ?? process.env.USER;
	const databasePort = Number(process.env.AGENT_DATABASE_PORT ?? 55433);
	if (!databaseUser) throw new Error("PGUSER or USER must be set");

	const db = new SQL(
		`postgresql://${encodeURIComponent(databaseUser)}@127.0.0.1:${databasePort}/${encodeURIComponent(database)}?sslmode=disable`,
	);
	await db.unsafe(CREATE_EVENTS_TABLE);

	let sequence = 0;
	let pendingWrites = Promise.resolve();
	let writeError: unknown;
	let closed = false;

	function record(eventType: string, payload: unknown): void {
		const eventSequence = sequence++;
		const observedAt = new Date().toISOString();
		const serialized = JSON.stringify(payload);
		console.log(serialized);
		pendingWrites = pendingWrites
			.then(() => db.unsafe(
				`INSERT INTO agent_events (
					agent_run_id, sequence, pi_session_id, process_id, worker_id,
					step_type, event_type, observed_at, payload
				) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb)`,
				[agentRunId, eventSequence, session.sessionId, processId, workerId,
					stepType, eventType, observedAt, serialized],
			))
			.then(() => undefined)
			.catch((error) => { writeError ??= error; });
	}

	const unsubscribe = session.subscribe((event) => {
		record(event.type, event);
	});

	record("agent_run_start", {
		type: "agent_run_start",
		agentRunId,
		piSessionId: session.sessionId,
		processId,
		workerId,
		stepType,
		model,
	});

	return {
		agentRunId,
		recordError(error: unknown) {
			record("runner_error", {
				type: "runner_error",
				message: error instanceof Error ? error.message : String(error),
			});
		},
		async close() {
			if (closed) return;
			closed = true;
			unsubscribe();
			await pendingWrites;
			await db.close();
			if (writeError) console.error("Event persistence failed:", writeError);
		},
	};
}
