import { expect, test } from "bun:test";

import { sessionToolAllowlist } from "./session_runner.js";

test("a scoped session exposes its custom tools alongside its allowed built-ins", () => {
	expect(sessionToolAllowlist(["read", "bash"], [
		{ name: "experiment_start" }, { name: "experiment_status" },
	])).toEqual(["read", "bash", "experiment_start", "experiment_status"]);
	expect(sessionToolAllowlist([], [{ name: "experiment_start" }])).toEqual(["experiment_start"]);
	expect(sessionToolAllowlist(undefined, [{ name: "experiment_start" }])).toBeUndefined();
});


test("concurrent bash tools retain session-local environment without global mutation", async () => {
 const { sessionBashTool } = await import("./session_runner.js");
 const before = process.env.STREAM_B_SESSION_MARKER;
 const logs = (await import("node:fs")).mkdtempSync(`${(await import("node:os")).tmpdir()}/session-shell-`);
 const first = sessionBashTool(import.meta.dir, { STREAM_B_SESSION_MARKER: "first" }, logs);
 const second = sessionBashTool(import.meta.dir, { STREAM_B_SESSION_MARKER: "second" }, logs);
 const outputs = await Promise.all([first.execute("a", { command: 'printf "%s" "$STREAM_B_SESSION_MARKER"' }, undefined, undefined, undefined as any), second.execute("b", { command: 'printf "%s" "$STREAM_B_SESSION_MARKER"' }, undefined, undefined, undefined as any)]);
 expect(JSON.stringify(outputs[0])).toContain("first");
 expect(JSON.stringify(outputs[1])).toContain("second");
 expect(process.env.STREAM_B_SESSION_MARKER).toBe(before);
});

test("web search limits and credentials are frozen separately for each session", async () => {
 const { webSearchExtension } = await import("../tools/web_search.js");
 const collect = (maxCalls: number) => {
  let tool: any;
  webSearchExtension({ maxCalls, maxResults: 1, env: {} })({ registerTool(value: unknown) { tool = value; } } as any);
  return tool;
 };
 const first = collect(0), second = collect(1);
 expect(JSON.stringify(await first.execute("a", { query: "fixture" }))).toContain("call limit");
 expect(JSON.stringify(await second.execute("b", { query: "fixture" }))).toContain("TAVILY_API_KEY is not set");
 expect(JSON.stringify(await second.execute("c", { query: "fixture" }))).toContain("call limit");
});
