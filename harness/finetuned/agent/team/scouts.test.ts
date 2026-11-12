import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { ScoutBudget } from "./budget.js";
import { createScouts, finalBullets, bulletRefs, scoutOutcome, type ScoutsOptions } from "./scouts.js";
import { appendFindings, readFindings } from "./journal.js";
import { parseHarnessConfig, HARNESS_CONFIG } from "../harness/config.js";
const prompts = loadPromptSnapshot();
const path = () => join(mkdtempSync(join(tmpdir(), "scouts-")), "journal.jsonl");

test("synchronous report returns only final bullets and repeat gets journal, task and unit once", async () => {
 let calls = 0;
 // task.md as stream B writes it: the unit introduction, then the task text.
 const scope = createScouts({ prepare: async () => {}, prompts, taskId: "fixture", task: "UNIT INTRO\n\nTASK TEXT", dataPaths: "dev.zip", resources: "- none", journalPath: path(), datasetSha256: "dataset", runId: "run", invocationId: "invoke",
  async run(input) {
   expect(input.toolCallId).toBe("call");
   expect(input.opening.text).toContain("TASK TEXT"); expect(input.opening.text.split("UNIT INTRO").length).toBe(2);
   calls++;
   return "Private preamble\n- sourced observation (profile.count)\nPrivate transcript";
  } });
 const result = await scope.report({role: ["data", "ideas"], question: "inspect"}, undefined, "call");
 expect(JSON.stringify(result)).not.toContain("Private");
 expect(JSON.stringify(result)).toContain("sourced observation"); expect(calls).toBe(2);
});
test("empty response always yields a factual bullet and validation fails closed", async () => {
 let validationStarts = 0;
 const scope = createScouts({ prepare: async () => {}, prompts, taskId: "fixture", task: "task", dataPaths: "dev", resources: "- none", journalPath: path(), datasetSha256: "dataset", runId: "run", invocationId: "invoke",
  run: async input => { if (input.role === "validation") validationStarts++; return ""; } });
 expect(await scope.scout({role: "data", question: "inspect"})).toStartWith("- advice:");
 // No experiment reference: refused before any scout starts.
 await expect(scope.scout({role: "validation", question: "check"})).rejects.toThrow("exactly one measured trial");
 // No trial records: the role fails; no session starts and live code is never used.
 expect(await scope.scout({role: "validation", question: "check", refs: [{experiment: "exp-1"}]})).toContain("snapshot unavailable");
 expect(validationStarts).toBe(0);
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
 const system = prompts.render("team.data", {taskId: "fixture", budget: "1", dataPaths: "sample.txt", resources: "- none"});
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
  sharedInstructions: [], childInstructions: prompts.render("team.ideas", {taskId: "fixture", budget: "1", webSearches: "3", resources: "- none"}),
  tools: ["fixture"], customTools: [fixture], extensionFactories: [budget.extension()], env: {}, inputs: [],
  observe: {identity: {}, telemetry: {failures: [], record: event => records.push(event), async close() {}}}});
 const child = await factory({logicalAgentId: "child", parentAgentRunId: "parent", spawnToolCallId: "call"}, new AbortController().signal);
 try {
  const result = await child.prompt(prompts.render("team.start", {task: "task", question: "q", refs: "none", shown: "0", omitted: "0", earlier: "none"}));
  expect(result).toBe("- observed fixture"); expect(executions).toBe(1); expect(budget.used).toBe(1);
  const snapshot = records.find(row => row.eventType === "prompt_snapshot");
  expect(snapshot.payload.system_prompt).not.toContain("SCOUT_FACTORY_EXCLUDED_MARKER");
  expect(snapshot.payload.system_prompt).toContain("ideas scout");
  expect(snapshot.payload.system_prompt).not.toContain("Work on the task assigned by the parent");
 } finally {await child.close();}
});

test("ideas search is B's session-local extension: three searches, one log per scout, no credential in logs", async () => {
 const https = await import("node:https");
 const { EventEmitter } = await import("node:events");
 const { spyOn } = await import("bun:test");
 const { scoutToolset } = await import("./runner.js");
 const {mkdirSync, readdirSync, readFileSync} = await import("node:fs");
 let requests = 0;
 // B's extension calls node:https; answer locally and restore afterwards.
 const spy = spyOn(https, "request").mockImplementation(((_options: unknown, respond: (res: InstanceType<typeof EventEmitter>) => void) => {
  requests++;
  return Object.assign(new EventEmitter(), {setTimeout() {}, write() {}, end() {
   const response = new EventEmitter(); respond(response);
   response.emit("data", Buffer.from(JSON.stringify({results: [{title: "paper", url: "https://example.org/paper", content: "evidence"}]}))); response.emit("end");
  }});
 }) as never);
 try {
  const root = mkdtempSync(join(tmpdir(), "scout-search-"));
  mkdirSync(join(root, "research"));
  const sandbox = {executable: process.execPath, bwrap: process.execPath, scratchRoot: join(tmpdir(), "scouts-test-scratch"), cwd: root, env: {}, args: () => [], mounts: [{source: root}]};
  const view = () => scoutToolset("ideas", {sandbox, solutionsRoot: join(root, "solutions"), taskId: "fixture", searchEnv: {TAVILY_API_KEY: "FIXTURE_CREDENTIAL"}});
  const search = (scout: ReturnType<typeof view>) => {
   let tool: any;
   expect(scout.extensionTools).toEqual(["web_search"]);
   (scout.extensions[0] as {factory(pi: never): void}).factory({registerTool: (registered: unknown) => { tool = registered; }} as never);
   return (query: string) => tool.execute("id", {query}, undefined, undefined, undefined);
  };
  const first = search(view()), second = search(view());
  for (let i = 0; i < 3; i++) await first(`query ${i}`);
  expect(JSON.stringify(await first("over budget"))).toContain("limit reached (3)");
  await second("other scout"); expect(requests).toBe(4);
  const logs = readdirSync(join(root, "research")).filter(name => name.startsWith("web-search-"));
  expect(logs.length).toBe(2);
  expect(logs.map(name => readFileSync(join(root, "research", name), "utf8").trim().split("\n").length).sort()).toEqual([1, 3]);
  for (const name of logs) expect(readFileSync(join(root, "research", name), "utf8")).not.toContain("FIXTURE_CREDENTIAL");
  expect(() => scoutToolset("ideas", {sandbox, solutionsRoot: join(root, "solutions"), taskId: "fixture", searchEnv: {}})).toThrow("search key");
 } finally { spy.mockRestore(); }
});


test("all requested roles pass preflight before the first scout can start", async () => {
 let starts = 0;
 const scope = createScouts({prompts, taskId: "fixture", task: "task", dataPaths: "dev", resources: "- none", journalPath: path(), datasetSha256: "data", runId: "run", invocationId: "invocation",
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

const scoutOptions = (overrides: Partial<Parameters<typeof createScouts>[0]> = {}): Parameters<typeof createScouts>[0] => ({
 prompts, taskId: "fixture", task: "task", dataPaths: "dev", resources: "- none", journalPath: path(), datasetSha256: "data",
 runId: "run", invocationId: "invoke", prepare: async () => {}, run: async () => "- result", ...overrides});

test("lead refs with extra keys are rejected at the tool boundary before any scout starts", async () => {
 const { validateToolArguments } = await import("@earendil-works/pi-ai");
 let prepared = 0, started = 0;
 const scope = createScouts(scoutOptions({prepare: async () => {prepared++;}, run: async () => {started++; return "- x";}}));
 const args = {role: "data", question: "inspect", refs: [{experiment: "e1", note: "extra"}]};
 // Pi validates the schema before execute: extra keys never reach the service.
 expect(() => validateToolArguments(scope.tool as never, {type: "toolCall", id: "c", name: "scout", arguments: args} as never)).toThrow();
 expect(() => validateToolArguments(scope.tool as never, {type: "toolCall", id: "c", name: "scout", arguments: {...args, refs: [{file: "a.py", line: 0}]}} as never)).toThrow();
 // Validation is in the schema; the service refuses it without exactly one trial reference.
 expect(() => validateToolArguments(scope.tool as never, {type: "toolCall", id: "c", name: "scout", arguments: {role: ["data", "ideas", "validation"], question: "q", refs: [{experiment: "e1"}]}} as never)).not.toThrow();
 await expect(scope.scout({role: "validation", question: "q", refs: [{experiment: "e1"}, {experiment: "e2"}]})).rejects.toThrow("exactly one measured trial");
 await expect(scope.tool.execute("c", args as never, undefined, undefined, undefined as never)).rejects.toThrow("Invalid scout request: refs[0]");
 await expect(scope.scout({role: "data", question: "q", refs: [{file: "a.py", line: 0}]})).rejects.toThrow("refs[0]");
 await expect(scope.scout({role: "data", question: " "})).rejects.toThrow("question");
 expect(prepared).toBe(0); expect(started).toBe(0);
 expect(scope.tool.description.replace(/\s+/g, " ")).toContain("validation checks one measured trial");
});

test("unparseable citations stay text and never cost the other bullets", async () => {
 const journal = path();
 const scope = createScouts(scoutOptions({journalPath: journal, run: async () => "- fact: zero line (`out.txt:0`)\n- fact: valid (`research/out.txt:4`) https://example.org/x."}));
 const output = await scope.scout({role: "data", question: "inspect", refs: [{experiment: "e1"}]});
 expect(output).toContain("zero line"); expect(output).toContain("valid");
 const {entries} = await readFindings(journal);
 expect(entries.map(entry => entry.refs)).toEqual([[], [{url: "https://example.org/x"}, {file: "research/out.txt", line: 4}]]);
 expect(bulletRefs("`a.txt:x` `b.py:2` `../c.md` `profile/profile.json`")).toEqual([{file: "b.py", line: 2}, {file: "../c.md", line: 1}, {profile: "profile/profile.json"}]);
 // With the scout's folder, paths outside the state root stay text only.
 expect(bulletRefs("`../../../escape.txt` `research/a.txt`", {root: "/state/scouts/s1", base: "/state"})).toEqual([{file: "scouts/s1/research/a.txt", line: 1}]);
});

test("valid findings are appended even when others in the batch are rejected", async () => {
 const {appendValidFindings} = await import("./journal.js");
 const journal = path();
 const good = {kind: "fact" as const, author: {role: "data" as const, runId: "run", invocationId: "invoke"}, title: "good", text: "good", refs: [], datasetSha256: "data"};
 const result = await appendValidFindings(journal, [good, {...good, title: "bad", refs: [{file: "x", line: 0}]}, {...good, kind: "result"}, {...good, title: "second"}]);
 expect(result.appended.map(entry => entry.title)).toEqual(["good", "second"]);
 expect(result.rejected.map(row => row.index)).toEqual([1, 2]); expect(result.rejected[0].reason).toContain("refs[0]");
 // The lead still gets every bullet, plus a line naming what was not journaled.
 const output = await createScouts(scoutOptions({datasetSha256: "", journalPath: journal, run: async () => "- one\n- two"})).scout({role: "data", question: "q"});
 expect(output).toStartWith("- one\n- two\n- journal: 2 bullet(s) above were returned but not journaled");
});

test("numbered lists and indented source lines survive bullet normalization", () => {
 const text = "Preamble\n1. First finding\n   Source: `research/a.txt:3`\n2) Second finding\n   - nested detail\n\n   continued after blank\nPrivate trailing prose\n  orphan indented line\n10. Tenth";
 expect(finalBullets(text, "- none")).toEqual([
  "- First finding\n  Source: `research/a.txt:3`", "- Second finding\n  - nested detail\n  continued after blank", "- Tenth"]);
 expect(finalBullets("* a\n  * b\n* c", "- none")).toEqual(["- a\n  * b", "- c"]);
 expect(finalBullets("No list here", "- none")).toEqual(["- none"]);
});

test("validation findings written as labelled lines or paragraphs without list markers are kept", () => {
 // The two reply shapes of the empty spam2 and spam3 validation probes at budget 20.
 const lines = "\n\n**ok:** reads only member bytes (`tasks/spam2.py:8-20`).\n**ok:** CV checked\n  in `checks/spam2/cv_metric.py`.\n**advice:** drop `class_weight`.";
 expect(finalBullets(lines, "", {labelled: true})).toEqual([
  "- **ok:** reads only member bytes (`tasks/spam2.py:8-20`).", "- **ok:** CV checked\n  in `checks/spam2/cv_metric.py`.", "- **advice:** drop `class_weight`."]);
 const paragraphs = "`ok:` only declared inputs.\n\n`fix:` a defect.\n\n`advice:` watch the score.\nTrailing prose is dropped.";
 expect(finalBullets(paragraphs, "", {labelled: true})).toEqual(["- `ok:` only declared inputs.", "- `fix:` a defect.", "- `advice:` watch the score."]);
 // Without the option, and for prose that merely mentions a label, nothing is a bullet.
 expect(finalBullets(paragraphs, "")).toEqual([""]);
 expect(finalBullets("OK — here is what I found.\nFixing this needs a rerun.", "", {labelled: true})).toEqual([""]);
 // Listed bullets are unchanged.
 expect(finalBullets("- ok: a\n- advice: b", "", {labelled: true})).toEqual(["- ok: a", "- advice: b"]);
});

test("a later role's failure keeps earlier bullets and reports the failed role", async () => {
 const journal = path();
 const scope = createScouts(scoutOptions({journalPath: journal, async run(input) {
  if (input.role === "ideas") throw new Error("Scout session failed; inspect its observed run");
  return "- fact: data bullet";
 }}));
 const output = await scope.scout({role: ["data", "ideas"], question: "q"});
 expect(output).toBe("- fact: data bullet\n- error: The ideas scout failed (Scout session failed; inspect its observed run); it returned no bullets.");
 expect((await readFindings(journal)).entries.length).toBe(1);
 const aborted = new AbortController();
 const cancelling = createScouts(scoutOptions({async run() {aborted.abort(); throw new Error("cancelled");}}));
 await expect(cancelling.scout({role: "data", question: "q"}, aborted.signal)).rejects.toThrow();
});

test("every role gets the shared label-suffix fact; validation is told it is not a defect", async () => {
 const seen: string[] = [];
 await createScouts(scoutOptions({async run(input) {seen.push(input.shared.text); return "- x";}})).scout({role: ["data", "ideas"], question: "q"});
 expect(seen.length).toBe(2);
 for (const raw of seen) {const text = raw.replace(/\s+/g, " "); expect(text).toContain("end in their label"); expect(text).toContain("`.x`"); expect(text).toContain("not leakage");}
 const validation = prompts.render("team.validation", {taskId: "t", budget: "1", experiment: "e", commit: "c", checks: "/checks"}).text.replace(/\s+/g, " ");
 expect(validation).toContain("Reading training labels from archive member names"); expect(validation).toContain("never a defect");
 // The code2 validation probes reported a fit_predict-only clustering pipeline as a contract break.
 expect(validation).toContain("For batch clustering the harness calls only `fit_predict`");
 expect(prompts.render("team.data", {taskId: "t", budget: "1", dataPaths: "d", resources: "- none"}).text.replace(/\s+/g, " ")).not.toContain("end in their label");
});

test("a repeat call sees only a bounded view of this run's current findings", async () => {
 const journal = path();
 const {appendFindings, resolveFinding} = await import("./journal.js");
 const entry = (runId: string, datasetSha256: string, text: string) => ({kind: "fact" as const, author: {role: "data" as const, runId, invocationId: "i"}, title: text.slice(0, 100), text, refs: [], datasetSha256});
 const [superseded] = await appendFindings(journal, [entry("run", "data", "SUPERSEDED_MARKER")]);
 await resolveFinding(journal, {id: superseded.id, status: "superseded"}, "data");
 await appendFindings(journal, [entry("other-run", "data", "OTHER_RUN_MARKER"), entry("run", "other-data", "OTHER_DATA_MARKER")]);
 await appendFindings(journal, Array.from({length: 20}, (_, i) => entry("run", "data", `entry-${i} ${"long ".repeat(100)}`)));
 let opening = "";
 await createScouts(scoutOptions({journalPath: journal, async run(input) {opening = input.opening.text; return "- x";}})).scout({role: "data", question: "q"});
 for (const marker of ["SUPERSEDED_MARKER", "OTHER_RUN_MARKER", "OTHER_DATA_MARKER", "entry-7 "]) expect(opening).not.toContain(marker);
 expect(opening).toContain("entry-8 "); expect(opening).toContain("entry-19 ");
 expect(opening).toContain("newest 12 shown and\n8 older not shown");
 expect(opening.length).toBeLessThan(5_000);
});

test("status pages new entries and its cursor resumes after the last one returned", async () => {
 const {createFindings} = await import("./findings.js");
 const api = createFindings(mkdtempSync(join(tmpdir(), "findings-page-")));
 const entry = {kind: "idea" as const, author: {role: "ideas" as const, runId: "r", invocationId: "i"}, text: "t", refs: [], datasetSha256: "d"};
 for (let i = 1; i <= 15; i++) await api.add("task", {...entry, title: `idea ${i}`});
 const first = await api.status("task");
 expect(first.newEntries.length).toBe(12); expect(first.cursor).toBe(12);
 const second = await api.status("task", first.cursor);
 expect(second.newEntries.map(row => row.title)).toEqual(["idea 13", "idea 14", "idea 15"]); expect(second.cursor).toBe(15);
 expect((await api.status("task", second.cursor)).newEntries).toEqual([]);
});

test("scout citations resolve in the scout's folder; lead experiment refs stay off bullets and unknown ones are unresolved", async () => {
 const {createFindings} = await import("./findings.js");
 const {mkdirSync} = await import("node:fs");
 const root = mkdtempSync(join(tmpdir(), "findings-roots-"));
 const scoutRoot = join(root, "solutions/scratch/scouts/s1");
 mkdirSync(join(scoutRoot, "research"), {recursive: true}); writeFileSync(join(scoutRoot, "research/out.txt"), "1\n2\n3\n");
 const scope = createScouts(scoutOptions({journalPath: join(root, "task/findings/journal.jsonl"), citationBase: root,
  run: async () => ({text: "- fact: counted (`research/out.txt:3`)", root: scoutRoot})}));
 await scope.scout({role: "data", question: "q", refs: [{experiment: "exp-1"}]});
 const api = createFindings(root);
 const page = await api.read("task");
 expect(page.entries[0].refs).toEqual([{file: "solutions/scratch/scouts/s1/research/out.txt", line: 3}]);
 expect((await api.status("task")).staleRefs).toEqual([]);
 await api.add("task", {kind: "decision", author: {role: "lead", runId: "r", invocationId: "i"}, title: "chosen", text: "chosen", refs: [{experiment: "exp-1"}], datasetSha256: "d"});
 const status = await api.status("task");
 expect(status.staleRefs).toEqual([]); expect(status.unresolvedRefs).toEqual(["experiment:exp-1"]);
});

test("failed, guard-stopped and empty scouts are reported as such; harness lines are neither bullets nor findings", async () => {
 const journal = path();
 const scouts = (run: ScoutsOptions["run"]) => createScouts({prepare: async () => {}, prompts, taskId: "fixture", task: "task", dataPaths: "dev", resources: "- none",
  journalPath: journal, datasetSha256: "dataset", runId: "run", invocationId: "invoke", run});
 // createScouts turns a backend exception (e.g. a failed model request) into an error line.
 const failed = await scouts(async () => { throw new Error("Scout session failed; inspect its observed run"); }).report({role: "data", question: "q"});
 expect(failed.text).toStartWith("- error: The data scout failed");
 expect(failed.roles).toEqual([{role: "data", status: "failed", bullets: 0, reason: "Scout session failed; inspect its observed run"}]);
 expect(scoutOutcome(failed)).toEqual({outcome: "failure", bullets: 0, reasons: ["data failed: Scout session failed; inspect its observed run"]});

 const stopped = await scouts(async () => ({text: "", stopped: "no progress for 5 min"})).report({role: "data", question: "q"});
 expect(stopped.text).toContain("The harness stopped this scout (no progress for 5 min)");
 expect(stopped.roles).toEqual([{role: "data", status: "stopped", bullets: 0, reason: "no progress for 5 min"}]);
 expect(scoutOutcome(stopped)).toMatchObject({outcome: "stopped", bullets: 0});

 const empty = await scouts(async () => "prose only").report({role: "data", question: "q"});
 expect(empty.text).toStartWith("- advice:");
 expect(scoutOutcome(empty)).toMatchObject({outcome: "empty", bullets: 0});

 const completed = await scouts(async () => "- fact: one\n- fact: two").report({role: "data", question: "q"});
 expect(scoutOutcome(completed)).toEqual({outcome: "success", bullets: 2, reasons: []});

 // One failed role makes the whole call unsuccessful; the other role's bullets still count.
 const mixed = await scouts(async input => { if (input.role === "ideas") throw new Error("model request failed"); return "- fact: three"; })
  .report({role: ["data", "ideas"], question: "q"});
 expect(mixed.roles.map(role => role.status)).toEqual(["completed", "failed"]);
 expect(scoutOutcome(mixed)).toMatchObject({outcome: "failure", bullets: 1});

 // Only scout-written bullets were journaled.
 expect((await readFindings(journal)).entries.map(entry => entry.title)).toEqual(["fact: one", "fact: two", "fact: three"]);
});

const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(accept => {resolve = accept;}); return {promise, resolve}; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { for(let i=0;i<2000 && !check();i++) await new Promise(accept=>setTimeout(accept,1)); expect(check()).toBe(true); }
const callScout = (scope: ReturnType<typeof createScouts>, role: "data" | "ideas" | ("data" | "ideas")[], question = "inspect") => scope.tool.execute("call", {role,question}, undefined,undefined,undefined as never);

test("tool returns immediately, roles run concurrently, and only bullets wake the inbox; one budget call", async () => {
 const {LeadInbox} = await import('../run/lead_session.js');
 const inbox = new LeadInbox(), finish = deferred<string>(); const started:string[]=[];
 const scope=createScouts(scoutOptions({run:async input=>{started.push(input.role); return finish.promise;},
  news:async(id,roles,report)=>inbox.steer(prompts.render('team.lead-scout-news',{id,roles:roles.join(', '),statuses:report.roles.map(row=>`${row.role}: ${row.status}`).join('; '),bullets:report.text}).text)}));
 const budget=new ScoutBudget(10,prompts);budget.assistant({role:'assistant',content:[{type:'toolCall',id:'call',name:'scout'}]});
 expect(budget.admit('call','scout')).toBeUndefined();
 const toolController=new AbortController();
 const reply=await scope.tool.execute('call',{role:['data','ideas'],question:'inspect'},toolController.signal,undefined,undefined as never);toolController.abort();expect(JSON.stringify(reply)).toContain('Consultation');
 expect(scope.pending).toBe(1);expect(inbox.size).toBe(0);
 await until(()=>started.length===2);expect(started).toEqual(['data','ideas']);
 const waiting=inbox.wait(1000);finish.resolve('PRIVATE TRANSCRIPT\n- final sourced bullet\nPRIVATE TOOL OUTPUT');await waiting;
 const news=inbox.take().join('\n');expect(news).toContain('final sourced bullet');expect(news).not.toContain('PRIVATE');
 await until(()=>scope.pending===0);expect(budget.used).toBe(1);
});

test("cap queues FIFO across consultations; synchronous validation bypasses saturation", async () => {
 const releases=[deferred<string>(),deferred<string>(),deferred<string>()];const started:string[]=[];
 const scope=createScouts(scoutOptions({maxConcurrent:1,solutionsRoot:'/fixture',trials:{status:async()=>({status:'resolved'}),snapshot:async()=>({experimentId:'exp',commit:'commit',sourceRoot:'/fixture',tree:'tree'})} as any,
  run:async input=>{if(input.role==='validation')return '- ok: snapshot checked';const index=started.length;started.push(input.opening.text);return releases[index].promise;}}));
 await callScout(scope,['data','ideas'],'first');await callScout(scope,'data','second');
 await until(()=>started.length===1);
 const validation=await scope.report({role:'validation',question:'check',refs:[{experiment:'exp'}]});
 expect(validation.roles[0].status).toBe('completed');expect(started.length).toBe(1);
 releases[0].resolve('- one');await until(()=>started.length===2);expect(started[1]).toContain('first');
 releases[1].resolve('- two');await until(()=>started.length===3);expect(started[2]).toContain('second');
 releases[2].resolve('- three');await until(()=>scope.pending===0);
});
for(const mode of ['cancel','abort'] as const)test(`${mode} stops running and queued consultations and records their lifecycle`,async()=>{
 const controller=new AbortController();const events:{event:string,payload:any}[]=[];let started=0,stopped=0;const reports:any[]=[];
 const scope=createScouts(scoutOptions({maxConcurrent:1,signal:controller.signal,record:(event,payload)=>events.push({event,payload}),news:async(_id,_roles,report)=>{reports.push(report);},
 run:async input=>{started++;return new Promise<string>((resolve,reject)=>input.signal!.addEventListener('abort',()=>{stopped++;if(mode==='abort')resolve('');else reject(new Error('cancelled'));},{once:true}));}}));
 await callScout(scope,['data','ideas']);await until(()=>started===1);
 if(mode==='abort')controller.abort();await scope.cancel();
 expect(scope.pending).toBe(0);expect(started).toBe(1);expect(stopped).toBe(1);
 expect(events.map(row=>row.event)).toEqual(['scout_consultation_started','scout_consultation_cancelled']);
 expect(events[1].payload.duration_ms).toBeGreaterThanOrEqual(0);expect(reports[0].roles.map((role:any)=>role.status)).toEqual(['stopped','stopped']);
});

test('scout concurrency cap rejects nonpositive or fractional values',()=>{
 for(const value of [0,-1,1.5]){const config=structuredClone(HARNESS_CONFIG);config.team.scouts.maxConcurrent=value;expect(()=>parseHarnessConfig(config)).toThrow('positive integer');}
});

test('completed consultation steers news into a running lead and records role outcomes',async()=>{
 const {LeadInbox}=await import('../run/lead_session.js');const steered:string[]=[];const events:{event:string,payload:any}[]=[];
 const inbox=new LeadInbox({isStreaming:true,steer:async text=>{steered.push(text);},sendCustomMessage:async()=>{}});
 const scope=createScouts(scoutOptions({run:async()=> 'PRIVATE\n- final finding\nPRIVATE',record:(event,payload)=>events.push({event,payload}),
  news:async(id,roles,report)=>inbox.steer(prompts.render('team.lead-scout-news',{id,roles:roles.join(', '),statuses:report.roles.map(row=>`${row.role}: ${row.status}`).join('; '),bullets:report.text}).text)}));
 await callScout(scope,'data');await until(()=>scope.pending===0);
 expect(inbox.size).toBe(0);expect(steered[0]).toContain('final finding');expect(steered[0]).not.toContain('PRIVATE');
 expect(events.map(row=>row.event)).toEqual(['scout_consultation_started','scout_consultation_finished']);
 expect(events[1].payload.statuses).toEqual([{role:'data',status:'completed',bullets:1}]);
});
