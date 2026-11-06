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

import { request as httpsRequest } from "node:https";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

export default function webSearchExtension(pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "web_search",
			label: "Web: search",
			description:
				"Search the web for information relevant to the current ML challenge. Use this to research approaches, find Python stdlib implementations, or look up adversarial ML techniques.",
			promptSnippet: "Search the web for ML approaches",
			promptGuidelines: [
				"Use web_search when the task type is unfamiliar, when past validation scores are below 0.95, or when you need to find a stdlib-compatible implementation of a specific algorithm.",
				"Good queries: 'spam detection python stdlib naive bayes', 'network traffic classification no sklearn', 'adversarial feature robustness text classification'.",
			],
			parameters: Type.Object({
				query: Type.String({ description: "Search query" }),
				max_results: Type.Optional(Type.Integer({ description: "Maximum number of results to return (default: 5)", default: 5 })),
			}),
			async execute(_toolCallId, params, signal) {
				const apiKey = process.env.TAVILY_API_KEY;
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

				const maxResults = params.max_results ?? 5;
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
