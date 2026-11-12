import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { SetupSession, setupChecks } from "../pipeline/setup.js";
import { createScouts } from "./scouts.js";
import { READ_ONLY_SCOUT_TOOLS, runScoutSession, scoutToolset, trackScoutTools } from "./runner.js";
import { ScoutBudget } from "./budget.js";
import { prepareResearchSandbox } from "../run/solve_sandbox.js";
import { readPythonEnvironment } from "../run/python_environment.js";
import { AgentSession } from "@earendil-works/pi-coding-agent";
const prompts = loadPromptSnapshot();

function scoutsBehindSetup(scoutPaths: {journal: string; unitIntro: string; task: string; profile: string}) {
 const starts = {count: 0};
 const scope = createScouts({prompts, taskId: "fixture", task: "task", dataPaths: "dev", resources: "- none", journalPath: scoutPaths.journal,
  datasetSha256: "data", runId: "run", invocationId: "invoke",
  prepare: (_roles, signal) => new SetupSession().check(setupChecks(["scouts"], {taskId: "fixture", prompts, scoutPaths}), signal ?? new AbortController().signal, () => {}),
  run: async () => {starts.count++; return "- result";}});
 return {scope, starts};
}

test("scout-prompts preflight blocks every scout on missing inputs, a task.md without the unit introduction or an unwritable journal", async () => {
 const root = mkdtempSync(join(tmpdir(), "scout-setup-"));
 const unitIntro = join(root, "unit-intro.md"); writeFileSync(unitIntro, "Unit introduction");
 const task = join(root, "task.md"); writeFileSync(task, "Unit introduction\n\nTask text\n");
 const profile = join(root, "profile.json"); writeFileSync(profile, '{"rowCount": 1}');
 const journal = join(root, "task/findings/journal.jsonl");

 const missing = scoutsBehindSetup({journal, unitIntro: join(root, "missing/unit-intro.md"), task, profile});
 await expect(missing.scope.scout({role: ["data", "ideas"], question: "q"})).rejects.toThrow(/scout-(prompts|materialized-inputs)/);
 expect(missing.starts.count).toBe(0);

 const noProfile = scoutsBehindSetup({journal, unitIntro, task, profile: join(root, "missing.json")});
 await expect(noProfile.scope.scout({role: "data", question: "q"})).rejects.toThrow(/scout-(prompts|materialized-inputs)/);
 const bare = join(root, "bare-task.md"); writeFileSync(bare, "Task text only\n");
 const noIntro = scoutsBehindSetup({journal, unitIntro, task: bare, profile});
 await expect(noIntro.scope.scout({role: "data", question: "q"})).rejects.toThrow(/scout-(prompts|materialized-inputs)/);
 expect(noProfile.starts.count + noIntro.starts.count).toBe(0);

 const locked = join(root, "locked"); mkdirSync(locked); chmodSync(locked, 0o500);
 try {
  const unwritable = scoutsBehindSetup({journal: join(locked, "journal.jsonl"), unitIntro, task, profile});
  await expect(unwritable.scope.scout({role: "data", question: "q"})).rejects.toThrow(/scout-(prompts|materialized-inputs)/);
  expect(unwritable.starts.count).toBe(0);
 } finally {chmodSync(locked, 0o700);}

 const ready = scoutsBehindSetup({journal, unitIntro, task, profile});
 expect(await ready.scope.scout({role: "data", question: "q"})).toBe("- result");
 expect(ready.starts.count).toBe(1);
});

test("the runner's tool set: ideas is read-only with search, data writes only its research folder", () => {
 const root = mkdtempSync(join(tmpdir(), "scout-tools-"));
 const workspace = join(root, "workspace"), shared = join(root, "shared");
 mkdirSync(join(workspace, "research"), {recursive: true}); mkdirSync(shared);
 // The real policy needs an executable for bubblewrap; no process is started here.
 const sandbox = {executable: process.execPath, cwd: workspace, env: {}, args: () => [],
  mounts: [{source: workspace, writable: true}, {source: shared, writable: true}, {source: join(root, "data")}]};
 const common = {solutionsRoot: shared, taskId: "fixture"};
 const ideas = scoutToolset("ideas", {sandbox, ...common, searchEnv: {TAVILY_API_KEY: "fixture"}});
 expect(ideas.tools.map(tool => tool.name).sort()).toEqual([...READ_ONLY_SCOUT_TOOLS].sort());
 expect(ideas.extensionTools).toEqual(["web_search"]);
 expect(ideas.sandbox.mounts.filter(mount => mount.writable)).toEqual([]);
 expect(ideas.sandbox.args(["true"])).not.toContain("--bind");

 const data = scoutToolset("data", {sandbox, ...common});
 expect(data.tools.map(tool => tool.name)).toContain("bash"); expect(data.extensionTools).toEqual([]);
 expect(data.sandbox.mounts.filter(mount => mount.writable).map(mount => mount.source)).toEqual([join(workspace, "research")]);
 const args = data.sandbox.args(["true"]);
 expect(args[args.indexOf("--bind") + 1]).toBe(join(workspace, "research"));
 expect(args.filter(arg => arg === "--bind").length).toBe(1);

 expect(() => scoutToolset("ideas", {sandbox, ...common})).toThrow("search key");
 expect(() => scoutToolset("data", {sandbox: {...sandbox, cwd: join(root, "elsewhere")}, ...common})).toThrow("research/ folder");
 expect(() => scoutToolset("validation", {sandbox, ...common})).toThrow("snapshot");
});

/** Live processes whose command line contains `marker`, from /proc (sandboxed PIDs are visible to the host). */
function processesWith(marker: string): number[] {
 const found: number[] = [];
 for (const entry of readdirSync("/proc")) {
  if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
  try { if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(marker)) found.push(Number(entry)); } catch {}
 }
 return found;
}

/** A data scout as the runner builds it: the real sandboxed tool set, tracked, in an observed Pi child on a scripted provider. */
async function sandboxedScout(responses: Parameters<Awaited<ReturnType<typeof import("@earendil-works/pi-ai")["fauxProvider"]>>["setResponses"]>[0], budget: ScoutBudget) {
 const { fauxProvider, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
 const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
 const { createPiChildFactory } = await import("../subagents/pi.js");
 const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-guard-")));
 const workspace = join(root, "workspace"), task = join(root, "task");
 mkdirSync(join(workspace, "research"), {recursive: true}); mkdirSync(task);
 const sandbox = prepareResearchSandbox(workspace, task, readPythonEnvironment(false));
 const tools = trackScoutTools(scoutToolset("data", {sandbox, solutionsRoot: join(root, "solutions"), taskId: "fixture"}).tools);
 const faux = fauxProvider({provider: `scout-guard-${Math.random()}`, tokensPerSecond: 1_000_000});
 const runtime = await ModelRuntime.create({credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false});
 runtime.registerNativeProvider(faux.provider);
 faux.setResponses(responses);
 const records: {eventType: string}[] = [];
 const factory = createPiChildFactory({cwd: workspace, agentDir: root, model: faux.getModel(), modelRuntime: runtime, prompts, sharedInstructions: [],
  childInstructions: prompts.render("team.data", {taskId: "fixture", budget: String(budget.limit), dataPaths: "none", resources: "- none"}),
  tools: tools.tools.map(tool => tool.name), customTools: tools.tools, extensionFactories: [budget.extension()], env: {}, inputs: [],
  observe: {identity: {}, telemetry: {failures: [], record: event => records.push(event), async close() {}}}, turnTimeoutMs: null});
 const child = await factory({logicalAgentId: "scout", parentAgentRunId: "lead", spawnToolCallId: "call"}, new AbortController().signal);
 const opening = prompts.render("team.start", {task: "task", question: "inspect", refs: "none", shown: "0", omitted: "0", earlier: "none"});
 return {child, tools, records, opening};
}

/** Records every disposed Pi session, and unsubscriptions, for the duration of `body`. */
async function watchSessions<T>(body: (life: {disposed: AgentSession[]; unsubscribed: number}) => Promise<T>): Promise<T> {
 const proto = AgentSession.prototype as unknown as {dispose(): void; subscribe(listener: unknown): () => void};
 const original = {dispose: proto.dispose, subscribe: proto.subscribe};
 const life = {disposed: [] as AgentSession[], unsubscribed: 0};
 proto.dispose = function (this: AgentSession) { life.disposed.push(this); return original.dispose.call(this); };
 proto.subscribe = function (this: AgentSession, listener: unknown) { const off = original.subscribe.call(this, listener); return () => { life.unsubscribed++; off(); }; };
 try { return await body(life); } finally { Object.assign(proto, original); }
}

test("a hung provider: the guard stops the scout, disposes its session, releases its observer and leaves no tool process", async () => {
 await watchSessions(async life => {
  const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
  const budget = new ScoutBudget(5, prompts);
  const marker = `scout-hung-provider-${process.pid}-${Date.now()}`;
  let reached = false;
  const {child, tools, records, opening} = await sandboxedScout([
   () => fauxAssistantMessage(fauxToolCall("bash", {command: `echo ${marker}`}), {stopReason: "toolUse"}),
   // The provider never answers, even after abort.
   () => { reached = true; return new Promise(() => {}); },
  ], budget);
  const result = await runScoutSession(child, opening, {lastActivity: () => reached ? budget.lastActivity : Date.now(), tools, killMs: 5_000,
   guard: {stallMs: 300, wallMs: 20_000, pollMs: 20, settleMs: 50}});
  expect("stopped" in result && result.stopped).toBe("stall");
  expect(result.cleanup).toEqual({forced: true, terminated: true, toolsLeft: 0});
  expect(budget.used).toBe(1); expect(reached).toBe(true);
  // Disposed once, with no session listener (the observer's) left.
  expect(life.disposed.length).toBe(1);
  expect((life.disposed[0] as unknown as {_eventListeners: unknown[]})._eventListeners).toEqual([]);
  expect(life.unsubscribed).toBeGreaterThanOrEqual(1);
  expect(records.at(-1)?.eventType).toBe("agent_run_end");
  expect(tools.running).toBe(0); expect(processesWith(marker)).toEqual([]);
  // close() after the forced path returns at once instead of waiting for the hung prompt.
  await child.close();
 });
});

test("a hung sandboxed bash command: the guard kills its whole process tree before the lead gets its stop bullet", async () => {
 await watchSessions(async life => {
  const { fauxAssistantMessage, fauxToolCall, fauxText } = await import("@earendil-works/pi-ai");
  const budget = new ScoutBudget(5, prompts);
  // A unique sleep duration identifies this test's processes; bash runs it as a child so the tree has depth.
  const marker = `9${String(process.pid).padStart(7, "0")}.${Date.now() % 100_000}`;
  const {child, tools, opening} = await sandboxedScout([
   () => fauxAssistantMessage(fauxToolCall("bash", {command: `sleep ${marker}; echo never`}), {stopReason: "toolUse"}),
   () => fauxAssistantMessage(fauxText("- fact: not reached")),
  ], budget);
  // Silent until the sleep is seen running, then stalled.
  let seen = false;
  const watch = setInterval(() => { if (processesWith(`sleep\0${marker}`).length) seen = true; }, 20);
  try {
   const result = await runScoutSession(child, opening, {lastActivity: () => seen ? 0 : Date.now(), tools, killMs: 5_000,
    guard: {stallMs: 200, wallMs: 20_000, pollMs: 20, settleMs: 50}});
   expect(seen).toBe(true);
   expect("stopped" in result && result.stopped).toBe("stall");
   expect(result.cleanup).toEqual({forced: true, terminated: true, toolsLeft: 0});
   expect(life.disposed.length).toBe(1);
   expect(processesWith(marker)).toEqual([]);
  } finally { clearInterval(watch); }
 });
});
