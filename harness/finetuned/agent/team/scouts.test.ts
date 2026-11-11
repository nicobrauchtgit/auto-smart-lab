import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { ScoutBudget } from "./budget.js";
import { createScouts } from "./scouts.js";
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
 const scope = createScouts({ prompts, taskId: "fixture", task: "TASK TEXT", unitIntro: "UNIT INTRO", dataPaths: "dev.zip", journalPath: path(), datasetSha256: "dataset", runId: "run", invocationId: "invoke",
  async run(input) {
   expect(input.opening.text).toContain("TASK TEXT"); expect(input.opening.text).toContain("UNIT INTRO");
   if (calls++) expect(input.opening.text).toContain("sourced observation");
   return "Private preamble\n- sourced observation (profile.count)\nPrivate transcript";
  } });
 const result = await scope.tool.execute("call", {role: ["data", "ideas"], question: "inspect"}, undefined, undefined, undefined as never);
 expect(JSON.stringify(result)).not.toContain("Private");
 expect(JSON.stringify(result)).toContain("sourced observation"); expect(calls).toBe(2);
});
test("empty response always yields a factual bullet and validation fails closed", async () => {
 const scope = createScouts({ prompts, taskId: "fixture", task: "task", unitIntro: "intro", dataPaths: "dev", journalPath: path(), datasetSha256: "dataset", runId: "run", invocationId: "invoke", run: async () => "" });
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
