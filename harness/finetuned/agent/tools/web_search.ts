import { TOOL_PROMPTS } from "../prompts/tools.js";

/**
 * Web search tool for the SmartLab ML agent.
 *
 * Exposes one pi tool: web_search
 *
 * Uses the Tavily Search API (https://tavily.com).
 * Requires TAVILY_API_KEY environment variable.
 * Degrades gracefully if the key is absent — returns an informative error
 * so the agent can fall back to its built-in knowledge.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { request as httpsRequest } from "node:https";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Append the returned URLs to the log named by WEB_SEARCH_LOG, so the harness
 * can check that cited URLs came from real search results. Best effort: a
 * failed write never fails the search.
 */
function recordResults(query: string, urls: string[], path?: string): void {
	if (!path) return;
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), query, urls })}\n`);
	} catch { /* the validator then reports the URLs as unverified */ }
}

interface TavilyResult {
	title: string;
	url: string;
	content: string;
}

interface TavilyResponse {
	results?: TavilyResult[];
	error?: string;
}

function post(url: string, body: string, headers: Record<string, string>): Promise<string> {
	const parsed = new URL(url);
	return new Promise<string>((resolve, reject) => {
		const req = httpsRequest(
			{
				protocol: parsed.protocol,
				hostname: parsed.hostname,
				port: parsed.port || 443,
				path: parsed.pathname + parsed.search,
				method: "POST",
				headers: {
					...headers,
					"Content-Length": Buffer.byteLength(body),
				},
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c) => chunks.push(c as Buffer));
				res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
			},
		);
		req.on("error", reject);
		req.setTimeout(30_000, () => req.destroy(new Error("request timed out")));
		req.write(body);
		req.end();
	});
}

export function webSearchExtension(options: { maxCalls: number; maxResults: number; logPath?: string; env?: Readonly<Record<string, string | undefined>> }) {
 if (!Number.isSafeInteger(options.maxCalls) || options.maxCalls < 0 || !Number.isSafeInteger(options.maxResults) || options.maxResults < 1) throw new Error("Invalid web search limits");
 const environment = { ...(options.env ?? process.env) };
 const frozen = { ...options };
 return (pi: ExtensionAPI) => registerWebSearch(pi, frozen, environment);
}
export default function legacyWebSearchExtension(pi: ExtensionAPI) {
 return webSearchExtension({ maxCalls: Number(process.env.WEB_SEARCH_MAX_CALLS ?? Number.MAX_SAFE_INTEGER), maxResults: Number(process.env.WEB_SEARCH_MAX_RESULTS ?? 5), logPath: process.env.WEB_SEARCH_LOG })(pi);
}
function registerWebSearch(pi: ExtensionAPI, options: { maxCalls: number; maxResults: number; logPath?: string }, environment: Readonly<Record<string, string | undefined>>) {
	let calls = 0;
	pi.registerTool(
		defineTool({
			name: "web_search",
			label: "Web: search",
			description: TOOL_PROMPTS.web_search.description,
			promptSnippet: TOOL_PROMPTS.web_search.promptSnippet,
			promptGuidelines: TOOL_PROMPTS.web_search.promptGuidelines,
			parameters: Type.Object({
				query: Type.String({ description: TOOL_PROMPTS.web_search.parameters.query }),
				max_results: Type.Optional(Type.Integer({ description: TOOL_PROMPTS.web_search.parameters.max_results, default: 5 })),
			}),
			async execute(_toolCallId, params, signal) {
				const configuredLimit = Number.parseInt(String(options.maxCalls), 10);
				const callLimit = Number.isFinite(configuredLimit) && configuredLimit >= 0
					? configuredLimit
					: undefined;
				if (callLimit !== undefined && calls >= callLimit) {
					return {
						content: [{ type: "text", text: JSON.stringify({ error: `Web search call limit reached (${callLimit})` }) }],
						details: {},
					};
				}
				calls++;
				const apiKey = environment.TAVILY_API_KEY;
				if (!apiKey) {
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify({
									error: "TAVILY_API_KEY is not set. Web search is unavailable. Use your built-in knowledge instead.",
								}),
							},
						],
						details: {},
					};
				}

				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Cancelled" }], details: {} };
				}

				const configuredResults = Number.parseInt(String(options.maxResults), 10);
				const resultLimit = Number.isFinite(configuredResults) && configuredResults > 0
					? configuredResults
					: 5;
				const maxResults = Math.min(params.max_results ?? 5, resultLimit);
				const body = JSON.stringify({
					query: params.query,
					max_results: maxResults,
					search_depth: "basic",
					include_answer: false,
				});

				try {
					const raw = await post("https://api.tavily.com/search", body, {
						"Content-Type": "application/json",
						Authorization: `Bearer ${apiKey}`,
					});

					const data = JSON.parse(raw) as TavilyResponse;

					if (data.error) {
						return {
							content: [{ type: "text", text: JSON.stringify({ error: data.error }) }],
							details: {},
						};
					}

					const results = (data.results ?? []).map((r) => ({
						title: r.title,
						url: r.url,
						snippet: r.content,
					}));

					recordResults(params.query, results.map(result => result.url), options.logPath);
					return {
						content: [{ type: "text", text: JSON.stringify({ results }, null, 2) }],
						details: { results } as unknown as Record<string, unknown>,
					};
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text", text: JSON.stringify({ error: `Search failed: ${message}` }) }],
						details: {},
					};
				}
			},
		}),
	);
}
