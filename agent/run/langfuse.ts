/**
 * Langfuse run grouping and scores (observability only; nothing here reaches a model).
 *
 * The pi plugin (@langfuse/pi-observability-plugin, loaded by session_runner.ts) traces each pi
 * session on its own, keyed by pi's session id. This module makes one orchestrator run one Langfuse
 * session: every stage (solver, eval, salvage, submit) is a trace we open here with
 * session.id = run id. The plugin's turns attach to it through the LANGFUSE_PI_PARENT_* env vars,
 * the plugin's parent-context hook for pi subagents (in 0.1.2 the only one; later versions add
 * LANGFUSE_PI_TRACEPARENT). They inherit the run id as session and show up as "Subagent Turn"
 * spans. Scores go on stage traces and, at the end of the run, on the session.
 *
 * Same configuration as the plugin (LANGFUSE_* env vars or ~/.pi/agent/langfuse.json); a no-op
 * without keys. Tracing failures are logged and never affect the run.
 */

import { randomUUID } from "node:crypto";
import type { Span, Tracer } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { loadConfig, type LangfuseConfig } from "@langfuse/pi-observability-plugin/src/index.ts";

/** Env vars the plugin reads (parent context) and writes (while a turn is open). */
const PLUGIN_PARENT_ENV = [
	"LANGFUSE_PI_TRACEPARENT",
	"LANGFUSE_PI_PARENT_TRACE_ID",
	"LANGFUSE_PI_PARENT_SPAN_ID",
	"LANGFUSE_PI_PARENT_SESSION_ID",
	"LANGFUSE_PI_PARENT_DEPTH",
	"LANGFUSE_PI_PARENT_EXTERNAL_TRACE",
] as const;

const FLUSH_TIMEOUT_MS = 5000;

type ScoreValue = number | string | boolean;

interface RunState {
	config: LangfuseConfig;
	processor: LangfuseSpanProcessor;
	provider: NodeTracerProvider;
	tracer: Tracer;
	runId: string;
	taskId: string;
	tags: string[];
	metadata: Record<string, string>;
}

let run: RunState | undefined;

/** Snapshot the plugin's parent-context env vars; the returned function restores them. */
export function snapshotPluginParentEnv(): () => void {
	const saved = PLUGIN_PARENT_ENV.map((k) => [k, process.env[k]] as const);
	return () => {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	};
}

/** Start the Langfuse session for one orchestrator run. Returns the session id, or undefined when tracing is off. */
export function startRun(opts: { taskId: string; model?: string; metadata?: Record<string, string> }): string | undefined {
	const config = safe(() => loadConfig());
	if (!config) return undefined;
	const processor = new LangfuseSpanProcessor({
		// Everything on this provider is ours; the default filter only passes the Langfuse SDK's own tracer.
		shouldExportSpan: () => true,
		publicKey: config.publicKey,
		secretKey: config.secretKey,
		baseUrl: config.baseUrl,
		environment: config.environment,
		release: config.release,
	});
	// Used directly, never registered as the global OTel provider.
	const provider = new NodeTracerProvider({ spanProcessors: [processor] });
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
	const runId = `${opts.taskId}-${stamp}-${randomUUID().slice(0, 6)}`;
	const tags = ["auto-smart-lab", `task:${opts.taskId}`, ...(opts.model ? [`model:${opts.model}`] : [])];
	run = {
		config, processor, provider, tracer: provider.getTracer("auto-smart-lab"),
		runId, taskId: opts.taskId, tags,
		metadata: { task: opts.taskId, ...(opts.model ? { model: opts.model } : {}), ...opts.metadata },
	};
	console.log(`[langfuse] run ${runId} → ${config.baseUrl}`);
	return runId;
}

export interface StageTrace {
	/** Langfuse trace id (the OTel trace id). */
	traceId: string;
	/** Set the trace output. */
	output(value: unknown): void;
	/** Attach a score to this stage's trace. */
	score(name: string, value: ScoreValue, comment?: string): void;
}

/**
 * Run `fn` inside one stage trace. While it runs, pi sessions started by runSession attach their
 * turns to this trace (the plugin reads the parent when session_runner loads extensions). Without an active run, `fn` runs untraced (the stage handle is inert).
 */
export async function stage<T>(
	name: string,
	attrs: { iteration?: number; input?: unknown },
	fn: (s: StageTrace) => Promise<T>,
): Promise<T> {
	const r = run;
	if (!r) return fn({ traceId: "", output() {}, score() {} });

	const metadata: Record<string, string> = { ...r.metadata, stage: name, run_id: r.runId };
	if (attrs.iteration !== undefined) metadata.iteration = String(attrs.iteration);
	const span: Span = r.tracer.startSpan(name, { root: true });
	span.setAttributes({
		"langfuse.observation.type": "span",
		"langfuse.trace.name": name,
		"session.id": r.runId,
		"langfuse.trace.tags": [...r.tags, `stage:${name}`],
		...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [`langfuse.trace.metadata.${k}`, v])),
	});
	if (attrs.input !== undefined) {
		const input = json(attrs.input);
		span.setAttribute("langfuse.observation.input", input);
		span.setAttribute("langfuse.trace.input", input);
	}
	const { traceId, spanId } = span.spanContext();

	const restoreEnv = snapshotPluginParentEnv();
	for (const k of PLUGIN_PARENT_ENV) delete process.env[k];
	process.env.LANGFUSE_PI_PARENT_TRACE_ID = traceId;
	process.env.LANGFUSE_PI_PARENT_SPAN_ID = spanId;
	process.env.LANGFUSE_PI_PARENT_SESSION_ID = r.runId;
	const handle: StageTrace = {
		traceId,
		output(value) {
			const out = json(value);
			span.setAttribute("langfuse.observation.output", out);
			span.setAttribute("langfuse.trace.output", out);
		},
		score(scoreName, value, comment) {
			void postScore({ traceId, name: scoreName, value, comment });
		},
	};
	try {
		return await fn(handle);
	} catch (err) {
		span.setAttribute("langfuse.observation.level", "ERROR");
		span.setAttribute("langfuse.observation.status_message", err instanceof Error ? err.message : String(err));
		throw err;
	} finally {
		restoreEnv();
		span.end();
		await flush();
	}
}

/** Attach a score to the whole run (the Langfuse session). */
export function scoreRun(name: string, value: ScoreValue, comment?: string): Promise<void> {
	if (!run) return Promise.resolve();
	return postScore({ sessionId: run.runId, name, value, comment });
}

/** Wait for pending scores, flush spans and shut down. Call before process.exit. */
export async function endRun(): Promise<void> {
	const r = run;
	if (!r) return;
	await Promise.allSettled([...pendingScores]);
	await flush();
	await withTimeout(r.provider.shutdown().catch(() => undefined), FLUSH_TIMEOUT_MS);
	run = undefined;
}

// ---------------------------------------------------------------------------

const pendingScores = new Set<Promise<void>>();

function postScore(body: { traceId?: string; sessionId?: string; name: string; value: ScoreValue; comment?: string }): Promise<void> {
	const r = run;
	if (!r) return Promise.resolve();
	const dataType = typeof body.value === "number" ? "NUMERIC" : typeof body.value === "boolean" ? "BOOLEAN" : "CATEGORICAL";
	const value = typeof body.value === "boolean" ? (body.value ? 1 : 0) : body.value;
	const auth = Buffer.from(`${r.config.publicKey}:${r.config.secretKey}`).toString("base64");
	const p = fetch(`${r.config.baseUrl}/api/public/scores`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
		body: JSON.stringify({
			...body, value, dataType,
			...(r.config.environment ? { environment: r.config.environment } : {}),
		}),
		signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
	})
		.then(async (res) => {
			if (!res.ok) console.warn(`[langfuse] score ${body.name} rejected: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
		})
		.catch((err) => console.warn(`[langfuse] score ${body.name} failed: ${err}`))
		.finally(() => pendingScores.delete(p));
	pendingScores.add(p);
	return p;
}

async function flush(): Promise<void> {
	if (!run) return;
	await withTimeout(run.processor.forceFlush().catch((err) => console.warn(`[langfuse] flush failed: ${err}`)), FLUSH_TIMEOUT_MS);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined;
	return Promise.race([
		p.finally(() => clearTimeout(timer)),
		new Promise<undefined>((res) => { timer = setTimeout(() => res(undefined), ms); timer.unref?.(); }),
	]);
}

function json(v: unknown): string {
	return typeof v === "string" ? v : JSON.stringify(v);
}

function safe<T>(fn: () => T): T | undefined {
	try { return fn(); } catch (err) { console.warn(`[langfuse] disabled: ${err}`); return undefined; }
}
