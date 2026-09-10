/**
 * Shared helper: run a pi agent session with a given system prompt and initial user message.
 * Returns the collected assistant text from the completed run.
 *
 * Uses the PI SDK: createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	getAgentDir,
	resolveCliModel,
} from "@earendil-works/pi-coding-agent";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, ".."); // agent/run/ → agent/
const PROJECT_ROOT = resolve(AGENT_DIR, ".."); // agent/ → <root>
const TOOLS_DIR = join(AGENT_DIR, "tools");

const EXTENSION_PATHS = [
	join(TOOLS_DIR, "smartlab.ts"),
	join(TOOLS_DIR, "memory.ts"),
	join(TOOLS_DIR, "web_search.ts"),
	join(TOOLS_DIR, "challenge_context.ts"),
];

/** Hard cap on one runSession call, including SDK retries and continue re-prompts. Override with PI_SESSION_TIMEOUT_MS. */
const SESSION_TIMEOUT_MS = Number(process.env.PI_SESSION_TIMEOUT_MS) || 30 * 60 * 1000;
/** How many times to re-prompt the same session after the SDK gives up on a model error. */
const MAX_CONTINUES = 2;
const CONTINUE_PROMPT =
	"The previous model call failed with a transient API error. Your session state and files are intact. " +
	"Continue from exactly where you left off — do not restart the workflow.";

export interface RunSessionOptions {
	/** Path to the markdown instruction file used as system prompt */
	instructionsPath: string;
	/** Initial user message to send */
	prompt: string;
	/** Optional env vars to inject into process.env for this session */
	env?: Record<string, string>;
	/** Label for log lines, e.g. "solver", "eval" */
	label?: string;
}

export interface RunSessionResult {
	/** All assistant text output collected during the run */
	output: string;
}

function elapsed(startMs: number): string {
	const s = Math.floor((Date.now() - startMs) / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

/** Extract the concatenated text blocks of an assistant message's content. */
function assistantText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text" && "text" in b)
		.map((b) => String((b as { text: unknown }).text))
		.join("");
}

function truncate(s: string, n = 120): string {
	const oneline = s.replace(/\s+/g, " ").trim();
	return oneline.length > n ? oneline.slice(0, n) + "…" : oneline;
}

/**
 * Run a PI agent session, wait for it to settle, and return the collected output.
 */
export async function runSession(options: RunSessionOptions): Promise<RunSessionResult> {
	const { instructionsPath, prompt, env, label = "agent" } = options;
	const tag = `[${label}]`;
	const sessionStart = Date.now();

	// Optional: dump the exact HTTP request/response to the model API for debugging.
	// Enable with PI_DEBUG_HTTP=1. Patches global fetch (the SDK uses it under the hood).
	if (process.env.PI_DEBUG_HTTP === "1" && !(globalThis as Record<string, unknown>).__piFetchPatched) {
		(globalThis as Record<string, unknown>).__piFetchPatched = true;
		const origFetch = globalThis.fetch;
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const url = typeof input === "string" ? input : (input as Request).url ?? String(input);
			if (/chat\/completions/.test(url) && init?.body) {
				try {
					const parsed = JSON.parse(String(init.body));
					const toolNames = Array.isArray(parsed.tools) ? parsed.tools.map((t: { function?: { name?: string } }) => t.function?.name) : [];
					process.stderr.write(`${tag} [HTTP→] model=${parsed.model} msgs=${parsed.messages?.length} tools=[${toolNames.join(",")}]\n`);
					// Log each message: role + content-type/preview + tool_calls, to find what the API rejects
					if (Array.isArray(parsed.messages)) {
						parsed.messages.forEach((m: Record<string, unknown>, i: number) => {
							const role = m.role;
							const c = m.content;
							let cDesc: string;
							if (c === null || c === undefined) cDesc = String(c);
							else if (typeof c === "string") cDesc = `str(${c.length})`;
							else if (Array.isArray(c)) cDesc = `arr[${c.map((b: { type?: string }) => b.type ?? "?").join(",")}]`;
							else cDesc = typeof c;
							const tc = Array.isArray(m.tool_calls) ? ` tool_calls=${m.tool_calls.length}` : "";
							const tcid = m.tool_call_id ? ` tool_call_id=${m.tool_call_id}` : "";
							const extra = Object.keys(m).filter(k => !["role","content","tool_calls","tool_call_id","name"].includes(k));
							process.stderr.write(`${tag} [HTTP→]   msg[${i}] role=${role} content=${cDesc}${tc}${tcid}${extra.length ? ` +[${extra.join(",")}]` : ""}\n`);
						});
					}
				} catch { /* non-JSON body */ }
			}
			const res = await origFetch(input, init);
			if (/chat\/completions/.test(url) && res.status >= 400) {
				const clone = res.clone();
				const text = await clone.text().catch(() => "");
				process.stderr.write(`${tag} [HTTP←] ${res.status} ${text.slice(0, 500)}\n`);
			}
			return res;
		}) as typeof fetch;
	}

	// Inject env vars before session starts (tools read from process.env)
	const envBackup: Record<string, string | undefined> = {};
	if (env) {
		for (const [key, value] of Object.entries(env)) {
			envBackup[key] = process.env[key];
			process.env[key] = value;
		}
	}

	try {
		const systemPrompt = readFileSync(instructionsPath, "utf8");
		const agentDir = getAgentDir();
		console.log(`${tag} loading extensions...`);

		const resourceLoader = new DefaultResourceLoader({
			cwd: PROJECT_ROOT,
			agentDir,
			additionalExtensionPaths: EXTENSION_PATHS,
			systemPrompt,
			noContextFiles: true,
		});

		await resourceLoader.reload();
		console.log(`${tag} extensions loaded (${elapsed(sessionStart)})`);

		console.log(`${tag} creating model runtime...`);
		const modelRuntime = await ModelRuntime.create({ agentDir });
		console.log(`${tag} model runtime ready (${elapsed(sessionStart)})`);

		// Resolve model from PI_MODEL env var (format: "provider/model-id" or bare "model-id")
		let selectedModel: unknown = undefined;
		const piModel = process.env.PI_MODEL;
		if (piModel) {
			const slash = piModel.indexOf("/");
			const cliProvider = slash > 0 ? piModel.slice(0, slash) : undefined;
			const cliModel = slash > 0 ? piModel.slice(slash + 1) : piModel;
			const resolved = resolveCliModel({ cliProvider, cliModel, modelRuntime });
			if (resolved.error) {
				throw new Error(`Could not resolve model "${piModel}": ${resolved.error}`);
			}
			if (resolved.model) {
				selectedModel = resolved.model;
				console.log(`${tag} model resolved: ${(resolved.model as { provider: string; id: string }).provider}/${(resolved.model as { provider: string; id: string }).id}`);
			} else {
				console.warn(`${tag} WARNING: model "${piModel}" not found in runtime, using default`);
			}
		}

		const { session } = await createAgentSession({
			cwd: PROJECT_ROOT,
			agentDir,
			modelRuntime,
			resourceLoader,
			sessionManager: SessionManager.inMemory(),
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			...(selectedModel ? { model: selectedModel as any } : {}),
		});
		console.log(`${tag} session created, sending prompt (${elapsed(sessionStart)})`);

		// Collect all assistant text deltas
		const textParts: string[] = [];
		let toolCallCount = 0;
		let currentToolName: string | undefined;
		let toolStart = 0;
		let promptSent = false; // guard: ignore agent_settled fired before prompt is sent
		// Per-run error tracking. The SDK retries transient errors itself
		// (settings.retry, default 3 consecutive attempts) and emits
		// auto_retry_start / auto_retry_end. We only need to know whether the
		// run ENDED on an error: that covers both retry exhaustion and
		// non-retryable errors (which never produce auto_retry_* events).
		let lastAssistantWasError = false;
		let lastErrorMessage = "";

		// Heartbeat: log every 30s so we know the session is alive
		const heartbeat = setInterval(() => {
			const status = currentToolName ? `running ${currentToolName}` : "thinking";
			process.stdout.write(`${tag} ⏳ still running (${elapsed(sessionStart)}, ${toolCallCount} tool calls, ${status})\n`);
		}, 30_000);

		const debugEvents = process.env.PI_DEBUG_EVENTS === "1";

		// Verify the selected model has auth configured before sending prompt
		if (selectedModel) {
			const m = selectedModel as { provider: string; id: string };
			const authStatus = modelRuntime.getProviderAuthStatus(m.provider);
			console.log(`${tag} provider auth: ${m.provider} → configured=${authStatus.configured} source=${authStatus.source ?? "none"}`);
			if (!authStatus.configured) {
				clearInterval(heartbeat);
				throw new Error(`Provider "${m.provider}" has no configured auth. Check ~/.pi/agent/models.json`);
			}
		}

		// NOTE: never throw/reject from inside this callback — the SDK emits
		// synchronously and an exception here becomes an unhandled rejection.
		const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			const ev = event as Record<string, unknown>;

			if (debugEvents) {
				const safeVal = (v: unknown) => {
					if (typeof v === "string") return v.slice(0, 60);
					if (typeof v === "object" && v !== null) return JSON.stringify(v).slice(0, 80);
					return String(v);
				};
				const pairs = Object.entries(ev).map(([k, v]) => `${k}=${safeVal(v)}`).join(" ");
				process.stdout.write(`${tag} [EVENT] ${pairs}\n`);
			}

			if (event.type === "agent_settled") {
				if (!promptSent) return; // spurious settle on the idle session before prompt()
				console.log(`${tag} ✓ settled in ${elapsed(sessionStart)} (${toolCallCount} tool calls)`);
				return;
			}

			// The SDK decided to retry a transient error (this is the only
			// place we can truthfully say "retrying").
			if (event.type === "auto_retry_start") {
				const attempt = ev.attempt as number;
				const max = ev.maxAttempts as number;
				const delay = Math.round((ev.delayMs as number) / 1000);
				process.stderr.write(`${tag} ⚠ transient model error, SDK retrying (attempt ${attempt}/${max}, in ${delay}s): ${truncate(String(ev.errorMessage ?? ""), 160)}\n`);
				return;
			}

			if (event.type === "auto_retry_end") {
				if (ev.success === true) {
					process.stderr.write(`${tag} ✓ recovered after ${ev.attempt} retry attempt(s)\n`);
				} else {
					process.stderr.write(`${tag} ✗ SDK gave up after ${ev.attempt} retry attempt(s): ${truncate(String(ev.finalError ?? "unknown error"), 160)}\n`);
				}
				return;
			}

			if (event.type === "message_end") {
				const msg = ev.message as { role?: string; content?: unknown; stopReason?: string; errorMessage?: string } | undefined;
				if (msg?.role === "assistant") {
					if (msg.stopReason === "error") {
						lastAssistantWasError = true;
						lastErrorMessage = msg.errorMessage?.trim() || "unknown error";
					} else {
						lastAssistantWasError = false;
						const text = assistantText(msg.content);
						if (text) process.stdout.write(`${tag} 💬 ${truncate(text)}\n`);
					}
				}
				return;
			}

			// Tool call started
			if (event.type === "tool_execution_start") {
				toolCallCount++;
				currentToolName = (ev.toolName ?? "tool") as string;
				toolStart = Date.now();
				const input = ev.args ?? {};
				const inputStr = typeof input === "object"
					? truncate(JSON.stringify(input).replace(/^{|}$/g, "").replace(/"([^"]+)":/g, "$1:"), 100)
					: truncate(String(input), 100);
				process.stdout.write(`${tag} → ${currentToolName}(${inputStr})\n`);
				return;
			}

			// Tool call finished
			if (event.type === "tool_execution_end") {
				const name = (ev.toolName ?? currentToolName ?? "tool") as string;
				const took = toolStart ? ` ${elapsed(toolStart)}` : "";
				const isError = ev.isError === true;
				const result = ev.result ?? "";
				const resultStr = typeof result === "string"
					? truncate(result.trim().split("\n")[0], 80)
					: typeof result === "object"
						? truncate(JSON.stringify(result), 80)
						: "";
				const suffix = resultStr ? ` → ${isError ? "ERROR: " : ""}${resultStr}` : "";
				process.stdout.write(`${tag} ← ${name}${took}${suffix}\n`);
				currentToolName = undefined;
				toolStart = 0;
				return;
			}

			// Assistant text streaming. Shape: { type: "message_update", message,
			// assistantMessageEvent: { type: "text_delta", delta, ... } }
			if (event.type === "message_update") {
				const ame = ev.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
				if (ame?.type === "text_delta" && typeof ame.delta === "string" && ame.delta) {
					textParts.push(ame.delta);
				}
			}
		});

		// Run one prompt to completion. session.prompt() resolves only after the
		// agent has fully settled (including the SDK's own retries), so a timeout
		// must race it AND abort the session — otherwise the run keeps going.
		const deadline = sessionStart + SESSION_TIMEOUT_MS;
		const runPrompt = async (text: string): Promise<void> => {
			lastAssistantWasError = false;
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`Session timed out after ${elapsed(sessionStart)}`);
			let timer: NodeJS.Timeout | undefined;
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("__timeout__")), remaining);
			});
			const run = session.prompt(text);
			try {
				await Promise.race([run, timeout]);
			} catch (err) {
				if (err instanceof Error && err.message === "__timeout__") {
					process.stderr.write(`${tag} ✗ timed out after ${elapsed(sessionStart)}, aborting session\n`);
					run.catch(() => undefined); // the abandoned run must not become an unhandled rejection
					await session.abort().catch(() => undefined);
					throw new Error(`Session timed out after ${elapsed(sessionStart)} (limit ${Math.round(SESSION_TIMEOUT_MS / 1000)}s)`);
				}
				throw new Error(`session.prompt() failed: ${err}`);
			} finally {
				if (timer) clearTimeout(timer);
			}
		};

		try {
			promptSent = true;
			await runPrompt(prompt);

			// The run ended on a model error (retry budget exhausted, or a
			// non-retryable error). The session state is intact, so try to
			// resume it a bounded number of times before giving up.
			let continues = 0;
			while (lastAssistantWasError && continues < MAX_CONTINUES) {
				continues++;
				process.stderr.write(`${tag} ⚠ run ended on model error: ${truncate(lastErrorMessage, 160)}\n`);
				process.stderr.write(`${tag} ↻ re-prompting session to continue (${continues}/${MAX_CONTINUES})\n`);
				await runPrompt(CONTINUE_PROMPT);
			}
			if (lastAssistantWasError) {
				throw new Error(`model API error (after ${continues} continue attempt(s)): ${lastErrorMessage}`);
			}
		} finally {
			clearInterval(heartbeat);
			unsubscribe();
		}

		// Fallback: if streaming capture yielded nothing, collect text from ALL
		// assistant messages (the sentinel may not be in the last one).
		if (textParts.length === 0) {
			for (const msg of session.messages) {
				if (!msg || typeof msg !== "object" || (msg as { role?: string }).role !== "assistant") continue;
				const text = assistantText((msg as { content?: unknown }).content);
				if (text) textParts.push(text);
			}
		}

		return { output: textParts.join("") };
	} finally {
		if (env) {
			for (const [key, originalValue] of Object.entries(envBackup)) {
				if (originalValue === undefined) delete process.env[key];
				else process.env[key] = originalValue;
			}
		}
	}
}

