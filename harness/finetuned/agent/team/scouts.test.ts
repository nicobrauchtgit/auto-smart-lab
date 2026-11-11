import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { ScoutBudget } from "./budget.js";
import { createScouts, finalBullets, bulletRefs } from "./scouts.js";
import { appendFindings, readFindings } from "./journal.js";
import { parseHarnessConfig, HARNESS_CONFIG } from "../harness/config.js";
const prompts = loadPromptSnapshot();
const path = () => join(mkdtempSync(join(tmpdir(), "scouts-")), "journal.jsonl");

test("hard call cap includes failed calls; every result has counter and last call requests finish", () => {
 const budget = new ScoutBudget(2, prompts);
 expect(budget.admit()).toBeUndefined(); expect(budget.counter()).toContain("1 of 2");
 expect(budget.admit()).toBeUndefined(); expect(budget.counter()).toContain("final sourced bullets");
 for (let n = 0; n < 10; n++) expect(budget.admit()?.block).toBe(true);
 expect(budget.used).toBe(2);
});
test("blocking boundary returns only final bullets and repeat gets journal, task and unit", async () => {
 let calls = 0;
 const scope = createScouts({ prepare: async () => {}, prompts, taskId: "fixture", task: "TASK TEXT", unitIntro: "UNIT INTRO", dataPaths: "dev.zip", journalPath: path(), datasetSha256: "dataset", runId: "run", invocationId: "invoke",
  async run(input) {
   expect(input.toolCallId).toBe("call");
   expect(input.opening.text).toContain("TASK TEXT"); expect(input.opening.text).toContain("UNIT INTRO");
   if (calls++) expect(input.opening.text).toContain("sourced observation");
   return "Private preamble\n- sourced observation (profile.count)\nPrivate transcript";
  } });
 const result = await scope.tool.execute("call", {role: ["data", "ideas"], question: "inspect"}, undefined, undefined, undefined as never);
 expect(JSON.stringify(result)).not.toContain("Private");
 expect(JSON.stringify(result)).toContain("sourced observation"); expect(calls).toBe(2);
});
test("empty response always yields a factual bullet and validation fails closed", async () => {
 const scope = createScouts({ prepare: async () => {}, prompts, taskId: "fixture", task: "task", unitIntro: "intro", dataPaths: "dev", journalPath: path(), datasetSha256: "dataset", runId: "run", invocationId: "invoke", run: async () => "" });
 expect(await scope.scout({role: "data", question: "inspect"})).toStartWith("- advice:");
 await expect(scope.scout({role: "validation", question: "check"})).rejects.toThrow("snapshot/check adapter");
});
test("journal serializes contention, reports and repairs only incomplete tail", async () => {
 const journal = path();
 const input = {kind: "fact" as const, author: {role: "data" as const, runId: "run", invocationId: "invoke"}, title: "test", text: "test", refs: [], datasetSha256: "data"};
 await Promise.all(Array.from({length: 8}, () => appendFindings(journal, [input])));
 expect((await readFindings(journal)).entries.map(entry => entry.cursor)).toEqual([1,2,3,4,5,6,7,8]);
 const fs = await import("node:fs"); fs.appendFileSync(journal, '{"broken":');
 expect((await readFindings(journal)).incompleteTail).toBe(true);
 await appendFindings(journal, [input]); expect((await readFindings(journal)).entries.length).toBe(9);
 writeFileSync(journal, '{}\n'); await expect(readFindings(journal)).rejects.toThrow();
});
test("team rejects invalid budgets and search policy", () => {
 const config = structuredClone(HARNESS_CONFIG); config.team.scouts.data.maxToolCalls = 0;
 expect(() => parseHarnessConfig(config)).toThrow();
 config.team.scouts.data.maxToolCalls = 10; config.team.scouts.ideas.webSearches = 4;
 expect(() => parseHarnessConfig(config)).toThrow();
});

test("real Pi guard blocks tool execution at cap, gives finish turn, and excludes fixture instructions", async () => {
 const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
 const { ModelRuntime, createAgentSession, SessionManager, SettingsManager, createReadToolDefinition, defineTool } = await import("@earendil-works/pi-coding-agent");
 const { createPipelineResourceLoader } = await import("../run/session_resources.js");
 const root = mkdtempSync(join(tmpdir(), "scout-pi-"));
 writeFileSync(join(root, "AGENTS.md"), "NEVER_LOAD_SCOUT_DEVELOPMENT_MARKER");
 writeFileSync(join(root, "sample.txt"), "PRIVATE_SCOUT_TOOL_OUTPUT");
 const faux = fauxProvider({provider: "scout-budget-fixture", tokensPerSecond: 1_000_000});
 const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
 runtime.registerNativeProvider(faux.provider);
 let actualReads = 0;
 const read = createReadToolDefinition(root);
 const budget = new ScoutBudget(1, prompts);
 faux.setResponses([
  () => fauxAssistantMessage(fauxToolCall("read", {path: "sample.txt"}), {stopReason: "toolUse"}),
  context => {
   expect(JSON.stringify(context)).toContain("1 of 1");
   return fauxAssistantMessage(fauxToolCall("read", {path: "sample.txt"}), {stopReason: "toolUse"});
  },
  () => fauxAssistantMessage("- fact: observed sample (sample.txt)"),
 ]);
 const system = prompts.render("team.data", {taskId: "fixture", budget: "1", dataPaths: "sample.txt"});
 const settingsManager = SettingsManager.inMemory();
 const resourceLoader = createPipelineResourceLoader({ cwd: root, agentDir: root, settingsManager, systemPrompt: system.text, extensionFactories: [budget.extension()] });
 await resourceLoader.reload();
 const {session} = await createAgentSession({cwd: root, agentDir: root, model: faux.getModel(), modelRuntime: runtime,
  settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(root), tools: ["read"],
  customTools: [defineTool({...read, async execute(...args: Parameters<typeof read.execute>) {actualReads++; return read.execute(...args);} })] });
 try {
  expect(session.systemPrompt).not.toContain("NEVER_LOAD_SCOUT_DEVELOPMENT_MARKER");
  expect(session.systemPrompt).toContain(system.text);
  await session.prompt("Inspect sample");
  expect(actualReads).toBe(1); expect(budget.used).toBe(1); expect(budget.blocked).toBe(1);
 } finally {session.dispose();}
});

test("missing scout prerequisite prevents session start; unused search needs no key", async () => {
 const { SetupSession, setupChecks } = await import("../pipeline/setup.js");
 const { scoutRequirements } = await import("./setup.js");
 expect(scoutRequirements("data")).not.toContain("web-search");
 expect(scoutRequirements("ideas")).toContain("web-search");
 const original = process.env.TAVILY_API_KEY;
 delete process.env.TAVILY_API_KEY;
 let started = false;
 const events: string[] = [];
 try {
  await expect((async () => {
   await new SetupSession().check(setupChecks(["web-search"], {taskId: "fixture", prompts}), new AbortController().signal, event => events.push(event));
   started = true;
  })()).rejects.toThrow("TAVILY_API_KEY");
  expect(started).toBe(false); expect(events).toContain("setup_finished");
 } finally { if (original !== undefined) process.env.TAVILY_API_KEY = original; }
});

test("scout child factory installs scoped tools and budget without generic child prose", async () => {
 const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, Type } = await import("@earendil-works/pi-ai");
 const { ModelRuntime, defineTool } = await import("@earendil-works/pi-coding-agent");
 const { createPiChildFactory } = await import("../subagents/pi.js");
 const root = mkdtempSync(join(tmpdir(), "scout-child-"));
 writeFileSync(join(root, "AGENTS.md"), "SCOUT_FACTORY_EXCLUDED_MARKER");
 const faux = fauxProvider({provider: "scout-child-fixture", tokensPerSecond: 1_000_000});
 const runtime = await ModelRuntime.create({credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false});
 runtime.registerNativeProvider(faux.provider);
 const budget = new ScoutBudget(1, prompts);
 let executions = 0;
 const fixture = defineTool({name: "fixture", label: "Fixture", description: "Fixture", parameters: Type.Object({}),
  async execute() {executions++; return {content: [{type: "text" as const, text: "PRIVATE_SCOUT_CONTEXT"}], details: {}};}});
 faux.setResponses([
  () => fauxAssistantMessage(fauxToolCall("fixture", {}), {stopReason: "toolUse"}),
  () => fauxAssistantMessage(fauxToolCall("fixture", {}), {stopReason: "toolUse"}),
  () => fauxAssistantMessage("- observed fixture"),
 ]);
 const records: any[] = [];
 const factory = createPiChildFactory({cwd: root, agentDir: root, model: faux.getModel(), modelRuntime: runtime, prompts,
  sharedInstructions: [], childInstructions: prompts.render("team.ideas", {taskId: "fixture", budget: "1", webSearches: "3"}),
  tools: ["fixture"], customTools: [fixture], extensionFactories: [budget.extension()], env: {}, inputs: [],
  observe: {identity: {}, telemetry: {failures: [], record: event => records.push(event), async close() {}}}});
 const child = await factory({logicalAgentId: "child", parentAgentRunId: "parent", spawnToolCallId: "call"}, new AbortController().signal);
 try {
  const result = await child.prompt(prompts.render("team.start", {task: "task", unitIntro: "intro", question: "q", refs: "[]", earlier: "[]"}));
  expect(result).toBe("- observed fixture"); expect(executions).toBe(1); expect(budget.used).toBe(1);
  const snapshot = records.find(row => row.eventType === "prompt_snapshot");
  expect(snapshot.payload.system_prompt).not.toContain("SCOUT_FACTORY_EXCLUDED_MARKER");
  expect(snapshot.payload.system_prompt).toContain("ideas scout");
  expect(snapshot.payload.system_prompt).not.toContain("Work on the task assigned by the parent");
 } finally {await child.close();}
});

test("search budgets and logs are session-local, cap network calls and sanitize failures", async () => {
 const { scoutSearch } = await import("./search.js");
 const original = globalThis.fetch;
 let requests = 0;
 globalThis.fetch = (async () => {requests++; return new Response(JSON.stringify({results: [{title: "paper", url: "https://example.org/paper", content: "evidence"}]}), {status: 200});}) as unknown as typeof fetch;
 const root = mkdtempSync(join(tmpdir(), "scout-search-"));
 const first = scoutSearch({apiKey: "FIXTURE_CREDENTIAL", limit: 3, log: join(root, "first.jsonl")});
 const second = scoutSearch({apiKey: "FIXTURE_CREDENTIAL", limit: 3, log: join(root, "second.jsonl")});
 const call = (tool: typeof first) => tool.execute("id", {query: "paper"}, undefined, undefined, undefined as never);
 try {
  for (let i = 0; i < 5; i++) await call(first);
  await call(second); expect(requests).toBe(4);
  const {readFileSync} = await import("node:fs");
  expect(readFileSync(join(root, "first.jsonl"), "utf8").trim().split("\n").length).toBe(3);
  expect(readFileSync(join(root, "first.jsonl"), "utf8")).not.toContain("FIXTURE_CREDENTIAL");
  globalThis.fetch = (async () => {throw new Error("RAW_PROVIDER_ERROR_WITH_CREDENTIAL");}) as unknown as typeof fetch;
  expect(JSON.stringify(await call(second))).not.toContain("RAW_PROVIDER_ERROR");
 } finally {globalThis.fetch = original;}
});


test("all requested roles pass preflight before the first scout can start", async () => {
 let starts = 0;
 const scope = createScouts({prompts, taskId: "fixture", task: "task", unitIntro: "intro", dataPaths: "dev", journalPath: path(), datasetSha256: "data", runId: "run", invocationId: "invocation",
  prepare: async roles => {expect(roles).toEqual(["data", "ideas"]); throw new Error("ideas missing prerequisite");},
  run: async () => {starts++; return "- result";}});
 await expect(scope.scout({role: ["data", "ideas"], question: "inspect"})).rejects.toThrow("missing prerequisite");
 expect(starts).toBe(0);
});

test("findings views page cursors, retain supersessions, and report torn or changed references", async () => {
 const {createFindings, createFindingsReader} = await import("./findings.js");
 const root = mkdtempSync(join(tmpdir(), "findings-view-"));
 const api = createFindings(root);
 const entry = {kind: "fact" as const, author: {role: "data" as const, runId: "r", invocationId: "i"}, title: "observation", text: "attributed", refs: [{file: "missing.py", line: 1}], datasetSha256: "dataset"};
 expect((await api.status("task")).cursor).toBe(0);
 const first = await api.add("task", entry);
 const second = await api.add("task", {...entry, title: "replacement"});
 await expect(api.resolve("task", {id: first.id, status: "superseded"}, "ideas")).rejects.toThrow("author");
 await api.resolve("task", {id: first.id, status: "superseded", supersededBy: second.id}, "data");
 const page = await api.read("task", {limit: 1});
 expect(page.cursor).toBe(1); expect(page.entries.length).toBe(1); expect(page.staleRefs.length).toBe(1);
 const rest = await api.read("task", {since: page.cursor});
 expect(rest.entries.length).toBe(1); expect(rest.resolutions.length).toBe(1); expect(rest.cursor).toBe(3);
 const status = await createFindingsReader(root).status("task");
 expect(status.counts.fact).toBe(1); expect(status.newEntries[0].id).toBe(second.id);
 await expect(api.read("task", {since: -1})).rejects.toThrow("cursor");
 await expect(api.read("../outside")).rejects.toThrow("task ID");
 const {appendFileSync} = await import("node:fs");
 appendFileSync(join(root, "task/findings/journal.jsonl"), '{"partial":');
 expect((await api.status("task")).staleRefs).toContain("incomplete-journal-tail");
 await api.add("task", entry); expect((await api.read("task")).cursor).toBe(4);
});

test("changed check hashes are stale without rewriting the original finding", async () => {
 const {createFindings} = await import("./findings.js");
 const {createHash} = await import("node:crypto");
 const {mkdirSync} = await import("node:fs");
 const root = mkdtempSync(join(tmpdir(), "findings-check-"));
 mkdirSync(join(root, "solutions"));
 const check = join(root, "solutions/check.py");
 writeFileSync(check, "original");
 const api = createFindings(root);
 const entry = await api.add("task", {kind: "fact", author: {role: "data", runId: "run", invocationId: "invoke"}, title: "check", text: "observed",
  refs: [{check: "check.py", sha256: createHash("sha256").update("original").digest("hex")}], datasetSha256: "dataset"});
 expect((await api.status("task")).staleRefs).toEqual([]);
 writeFileSync(check, "changed");
 expect((await api.status("task")).staleRefs.length).toBe(1);
 expect((await api.read("task")).entries[0]).toEqual(entry);
});


test("long final bullets retain their trailing evidence links", () => {
 const source = "https://example.org/evidence";
 const bullet = finalBullets("- " + "observation ".repeat(90) + source, "- none")[0];
 expect(bullet).toEndWith(source);
 expect(bulletRefs(bullet)).toContainEqual({url: source});
});
