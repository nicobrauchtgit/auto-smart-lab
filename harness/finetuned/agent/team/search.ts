/** Session-local Tavily calls: no process-wide counters, logs or environment mutation. */
import { appendFileSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { TOOL_PROMPTS } from "../prompts/tools.js";
export function scoutSearch(options: { apiKey: string; limit: number; log: string }) {
 let used = 0;
 return defineTool({name: "web_search", label: "Web search", description: TOOL_PROMPTS.web_search.description,
  parameters: Type.Object({query: Type.String({description: TOOL_PROMPTS.web_search.parameters.query})}),
  async execute(_id, args, signal) {
   const reply = (data: unknown) => ({content: [{type: "text" as const, text: JSON.stringify(data)}], details: {}});
   if (used >= options.limit) return reply({error: "Web search budget used"});
   used++;
   try {
    const response = await fetch("https://api.tavily.com/search", {method: "POST", redirect: "error",
     headers: {Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json"},
     body: JSON.stringify({query: args.query, max_results: 4, search_depth: "basic", include_answer: false}),
     signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)});
    if (!response.ok) return reply({error: "Search request failed"});
    const data = await response.json() as {results?: {title: string; url: string; content: string}[]};
    const results = (data.results ?? []).slice(0, 4).map(row => ({title: row.title, url: row.url, content: row.content}));
    appendFileSync(options.log, JSON.stringify({query: args.query, urls: results.map(row => row.url)}) + "\n");
    return reply({results});
   } catch { signal?.throwIfAborted(); return reply({error: "Search unavailable"}); }
  }});
}
