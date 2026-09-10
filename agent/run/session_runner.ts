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
		let modelError: Error | undefined; // set if the model returns a stopReason=error

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
				throw new Error(`Provider "${m.provider}" has no configured auth. Check ~/.pi/agent/models.json`);
			}
		}

		const settled = new Promise<void>((resolve, reject) => {
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
					// Ignore spurious settled events fired before the prompt is sent
					if (!promptSent) return;
					clearInterval(heartbeat);
					unsubscribe();
					console.log(`${tag} ✓ settled in ${elapsed(sessionStart)} (${toolCallCount} tool calls)`);
					resolve();
					return;
				}

				// Detect model/API errors surfaced as an errored assistant message.
				// Record it and let the run settle normally; the caller checks modelError
				// after settling. Do NOT reject here — throwing inside the SDK's synchronous
				// event emit crashes the process with an unhandled rejection.
				if (event.type === "message_end") {
					const msg = ev.message as { role?: string; content?: unknown; stopReason?: string; finishReason?: string; errorMessage?: string } | undefined;
					if (msg?.role === "assistant") {
						const contentLen = Array.isArray(msg.content) ? msg.content.length : 0;
						const stop = msg.stopReason ?? msg.finishReason ?? "?";
						if (debugEvents) {
							process.stdout.write(`${tag} [assistant msg] content_blocks=${contentLen} stopReason=${stop}\n`);
						}
						if (stop === "error" && !modelError) {
							modelError = new Error(`model API error: ${msg.errorMessage?.trim() ?? "unknown error"}`);
							process.stderr.write(`${tag} ⚠ ${modelError.message}\n`);
						}
					}
				}

				// Tool call started
				if (event.type === "tool_call_start" || event.type === "tool_use_start") {
					toolCallCount++;
					currentToolName = (ev.name ?? ev.toolName ?? ev.tool_name ?? "tool") as string;
					toolStart = Date.now();
					// Show tool input truncated — most useful for bash/read/write
					const input = ev.input ?? ev.params ?? ev.arguments ?? {};
					const inputStr = typeof input === "object"
						? truncate(JSON.stringify(input).replace(/^{|}$/g, "").replace(/"([^"]+)":/g, "$1:"), 100)
						: truncate(String(input), 100);
					process.stdout.write(`${tag} → ${currentToolName}(${inputStr})\n`);
					return;
				}

				// Tool call finished
				if (event.type === "tool_call_end" || event.type === "tool_use_end" || event.type === "tool_result") {
					const name = (ev.name ?? ev.toolName ?? currentToolName ?? "tool") as string;
					const took = toolStart ? ` ${elapsed(toolStart)}` : "";
					// Show first line of output — useful for bash results
					const result = ev.result ?? ev.output ?? ev.content ?? "";
					const resultStr = typeof result === "string"
						? truncate(result.trim().split("\n")[0], 80)
						: typeof result === "object"
							? truncate(JSON.stringify(result), 80)
							: "";
					const suffix = resultStr ? ` → ${resultStr}` : "";
					process.stdout.write(`${tag} ← ${name}${took}${suffix}\n`);
					currentToolName = undefined;
					toolStart = 0;
					return;
				}

				// Assistant text streaming — show first chunk of each new message
				if (event.type === "message_update" && "delta" in ev) {
					const delta = ev.delta;
					let text = "";
					if (typeof delta === "string") text = delta;
					else if (delta && typeof delta === "object" && (delta as Record<string,unknown>).type === "text")
						text = String((delta as Record<string,unknown>).text ?? "");
					if (text) {
						textParts.push(text);
						// Print first delta of each assistant turn as a preview
						if (textParts.join("").length === text.length || text.startsWith("SOLVER_DONE") || text.startsWith("EVAL_DECISION")) {
							process.stdout.write(`${tag} 💬 ${truncate(text)}\n`);
						}
					}
				}
			});

			// Safety timeout: 30 minutes
			setTimeout(() => {
				clearInterval(heartbeat);
				unsubscribe();
				reject(new Error("Session timed out after 30 minutes"));
			}, 30 * 60 * 1000);
		});

		promptSent = true;
		try {
			await session.prompt(prompt);
		} catch (promptErr) {
			clearInterval(heartbeat);
			throw new Error(`session.prompt() failed: ${promptErr}`);
		}
		await settled;

		// If the model returned an errored response, fail with a clear message
		if (modelError) {
			throw modelError;
		}

		// Fallback: if we didn't capture text via events, extract from session messages
		if (textParts.length === 0) {
			const messages = session.messages;
			for (let i = messages.length - 1; i >= 0; i--) {
				const msg = messages[i];
				if (msg && typeof msg === "object" && "role" in msg && (msg as { role: string }).role === "assistant") {
					const content = (msg as { content: unknown }).content;
					if (typeof content === "string") { textParts.push(content); break; }
					if (Array.isArray(content)) {
						for (const block of content) {
							if (block && typeof block === "object" && "type" in block &&
								(block as { type: string }).type === "text" && "text" in block)
								textParts.push(String((block as { text: unknown }).text));
						}
						if (textParts.length > 0) break;
					}
				}
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

