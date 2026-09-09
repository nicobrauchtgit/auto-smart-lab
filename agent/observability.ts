import { appendFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

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

// Stage events have no PI session, so pi_session_id becomes optional and the
// shared pipeline identifiers are added to existing installations in place.
const MIGRATIONS = [
	"ALTER TABLE agent_events ALTER COLUMN pi_session_id DROP NOT NULL",
	"ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS pipeline_run_id uuid",
	"ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS stage text",
	"ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS stage_invocation_id uuid",
	"ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS attempt integer",
	"ALTER TABLE agent_events ADD COLUMN IF NOT EXISTS task_id text",
	"CREATE INDEX IF NOT EXISTS agent_events_pipeline_run_idx ON agent_events (pipeline_run_id, observed_at)",
];

/** Shared identity that links stage events, agent attempts, and tool events. */
export interface EventIdentity {
	pipelineRunId?: string | null;
	stageInvocationId?: string | null;
	stage?: string | null;
	attempt?: number | null;
	taskId?: string | null;
}

export interface EventRecord {
	agentRunId: string;
	sequence: number;
	piSessionId: string | null;
	eventType: string;
	observedAt: string;
	payload: unknown;
	identity?: EventIdentity;
}

export interface EventSink {
	/** False when the trace database could not be reached; recording is degraded. */
	readonly databaseConnected: boolean;
	/** Local mirror of every event, written regardless of database availability. */
	readonly localPath?: string;
	/** Human-readable recording failures. Never empty when the trace is incomplete. */
	readonly failures: string[];
	record(record: EventRecord): void;
	close(): Promise<void>;
}

export interface EventSinkOptions {
	/** Append every event as JSON lines here as well as to the database. */
	localPath?: string;
	/** Print each serialized event to stdout (used by the standalone experiment). */
	echo?: boolean;
	/** Throw instead of degrading when the database is unreachable. */
	requireDatabase?: boolean;
}

function databaseUrl(): string {
	const database = process.env.PGDATABASE ?? "postgres";
	const databaseUser = process.env.PGUSER ?? process.env.USER;
	const databasePort = Number(process.env.AGENT_DATABASE_PORT ?? 55433);
	if (!databaseUser) throw new Error("PGUSER or USER must be set");
	return `postgresql://${encodeURIComponent(databaseUser)}@127.0.0.1:${databasePort}/${encodeURIComponent(database)}?sslmode=disable`;
}

/**
 * Open the shared event sink. Recording never blocks pipeline execution: when the
 * database is unavailable the sink stays usable, reports `databaseConnected: false`,
 * and keeps the local mirror so an incomplete trace is visible rather than silent.
 */
export async function createEventSink(options: EventSinkOptions = {}): Promise<EventSink> {
	const failures: string[] = [];
	const { localPath, echo = false } = options;
	if (localPath) mkdirSync(dirname(localPath), { recursive: true });

	let db: SQL | undefined;
	try {
		db = new SQL(databaseUrl());
		await db.unsafe(CREATE_EVENTS_TABLE);
		for (const migration of MIGRATIONS) await db.unsafe(migration);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (options.requireDatabase) throw error;
		try {
			await db?.close();
		} catch { /* the connection never opened */ }
		db = undefined;
		failures.push(`trace database unavailable: ${message}`);
	}

	let pendingWrites = Promise.resolve();
	let closed = false;
	const connection = db;

	return {
		databaseConnected: connection !== undefined,
		localPath,
		failures,
		record(record: EventRecord) {
			if (closed) {
				const message = `event ${record.eventType} recorded after the sink was closed`;
				failures.push(message);
				console.error(`[trace] ${message}`);
				return;
			}
			// A session event that cannot be serialized must not take down the run it
			// is describing, so the failure is recorded in its place.
			let serialized: string;
			try {
				serialized = JSON.stringify(record.payload) ?? "null";
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				failures.push(`event ${record.eventType} could not be serialized: ${message}`);
				console.error(`[trace] event ${record.eventType} could not be serialized: ${message}`);
				serialized = JSON.stringify({ type: record.eventType, serialization_failed: true, message });
			}
			if (echo) console.log(serialized);
			const identity = record.identity ?? {};
			if (localPath) {
				try {
					// The mirror uses the same column names as the events table so both
					// views of a run can be read the same way.
					appendFileSync(localPath, `${JSON.stringify({
						agent_run_id: record.agentRunId,
						sequence: record.sequence,
						pi_session_id: record.piSessionId ?? null,
						event_type: record.eventType,
						observed_at: record.observedAt,
						pipeline_run_id: identity.pipelineRunId ?? null,
						stage: identity.stage ?? null,
						stage_invocation_id: identity.stageInvocationId ?? null,
						attempt: identity.attempt ?? null,
						task_id: identity.taskId ?? null,
						payload: JSON.parse(serialized),
					})}\n`);
				} catch (error) {
					failures.push(`local trace write failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (!connection) return;
			pendingWrites = pendingWrites
				.then(() => connection.unsafe(
					`INSERT INTO agent_events (
						agent_run_id, sequence, pi_session_id, process_id, worker_id,
						step_type, event_type, observed_at, payload,
						pipeline_run_id, stage, stage_invocation_id, attempt, task_id
					) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb,
						$10::uuid, $11, $12::uuid, $13, $14)`,
					[
						record.agentRunId, record.sequence, record.piSessionId, process.pid, hostname(),
						identity.stage ?? null, record.eventType, record.observedAt, serialized,
						identity.pipelineRunId ?? null, identity.stage ?? null,
						identity.stageInvocationId ?? null, identity.attempt ?? null, identity.taskId ?? null,
					],
				))
				.then(() => undefined)
				.catch((error) => {
					failures.push(`event persistence failed: ${error instanceof Error ? error.message : String(error)}`);
				});
		},
		async close() {
			if (closed) return;
			closed = true;
			await pendingWrites;
			await connection?.close();
			for (const failure of failures) console.error(`[trace] ${failure}`);
		},
	};
}

export interface ObservabilityOptions {
	session: AgentSession;
	model: string;
	stepType?: string | null;
	/** Pipeline/stage/attempt identity for this agent session. */
	identity?: EventIdentity;
	/** Reuse an open sink. The caller keeps ownership and closes it. */
	sink?: EventSink;
	/** Print each serialized event to stdout. Defaults to true for owned sinks. */
	echo?: boolean;
}

export async function observeAgentSession(options: ObservabilityOptions) {
	const { session, model, identity } = options;
	const agentRunId = crypto.randomUUID();
	const stepType = options.stepType ?? identity?.stage ?? process.env.AGENT_STEP_TYPE ?? null;
	const ownsSink = options.sink === undefined;
	const sink = options.sink ?? await createEventSink({ echo: options.echo ?? true });
	const eventIdentity: EventIdentity = { ...identity, stage: identity?.stage ?? stepType };

	let sequence = 0;
	let closed = false;

	function record(eventType: string, payload: unknown): void {
		sink.record({
			agentRunId,
			sequence: sequence++,
			piSessionId: session.sessionId,
			eventType,
			observedAt: new Date().toISOString(),
			payload,
			identity: eventIdentity,
		});
	}

	const unsubscribe = session.subscribe((event) => {
		record(event.type, event);
	});

	record("agent_run_start", {
		type: "agent_run_start",
		agentRunId,
		piSessionId: session.sessionId,
		processId: process.pid,
		workerId: hostname(),
		stepType,
		model,
		...eventIdentity,
	});

	return {
		agentRunId,
		databaseConnected: sink.databaseConnected,
		record,
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
			record("agent_run_end", { type: "agent_run_end", agentRunId });
			if (ownsSink) await sink.close();
		},
	};
}

/** Everything a session runner needs to attach the shared observer to a session. */
export interface AgentObservation {
	identity: EventIdentity;
	sink: EventSink;
}
