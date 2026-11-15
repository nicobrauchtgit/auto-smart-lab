import { trialSupervisionDirectory } from "../training/results.js";
/**
 * Data-scout bash is supervised, bound and cleaned up. Validation has no shell;
 * its file tools and run_checks preserve snapshot identity and observability.
 * Scripted Pi provider; no model calls.
 */
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore, type FauxResponseStep } from "@earendil-works/pi-ai";
import { ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { readPythonEnvironment } from "../run/python_environment.js";
import { findBubblewrap } from "../run/solve_sandbox.js";
import { workspaceTestSandbox } from "../run/testing.js";
import { expertSandbox } from "../run/sandbox.js";
import { agentBashTool, assertSupervisedBash, isAgentShellTool, replaceToolsByName, sandboxShell } from "../run/agent_shell.js";
import { createPiChildFactory } from "../subagents/pi.js";
import { ensureSolutionsRepository, git, resolveCommit } from "../training/git.js";
import { ScoutBudget } from "./budget.js";
import { runScoutSession, scoutToolset, trackScoutTools, validationCheckTool, VALIDATION_SCOUT_TOOLS } from "./runner.js";
import { createTrialResolver } from "./trials.js";
import type { ScoutRole, TaskData } from "./contracts.js";

const prompts = loadPromptSnapshot();
let bubblewrap = false;
try { findBubblewrap(); bubblewrap = true; } catch { bubblewrap = false; }
const sandboxed = test.skipIf(!bubblewrap || process.platform !== "linux");
/** Fast enough for a test: a silent call is reported as stalled after a quarter second. */
const FAST = { sampleIntervalMs: 25, stopGraceMs: 200, minStallMs: 250, importPreludeMs: 250 };

/** Live processes whose command line contains `marker`, from /proc (sandboxed PIDs are visible to the host). */
function processesWith(marker: string): number[] {
 const found: number[] = [];
 for (const entry of readdirSync("/proc")) {
  if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
  try { if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(marker)) found.push(Number(entry)); } catch {}
 }
 return found;
}
/** A sleep duration no other process has: it names this call's processes. */
const uniqueSleep = () => `9${String(process.pid).padStart(7, "0")}.${String(Date.now() % 100_000).padStart(5, "0")}${Math.floor(Math.random() * 10)}`;
/** Supervised calls recorded under `root`: one experiment.json per call. */
const shellRecords = (root: string) => existsSync(root)
 ? readdirSync(root).filter(id => existsSync(join(root, id, "experiment.json"))).map(id => JSON.parse(readFileSync(join(root, id, "experiment.json"), "utf8")))
 : [];

/** A measured trial in a shared solutions repository, as the validation scout gets it. */
async function validationFixture() {
 const state = realpathSync(mkdtempSync(join(tmpdir(), "scout-shell-state-")));
 const live = join(state, "solutions");
 ensureSolutionsRepository(live);
 mkdirSync(join(live, "tasks"), {recursive: true}); mkdirSync(join(live, "checks/fixture"), {recursive: true});
 writeFileSync(join(live, "tasks/model.py"), "VALUE = 1\n");
 git(live, ["add", "-A"]); git(live, ["commit", "-qm", "measured"]);
 const measured = resolveCommit(live, "HEAD")!;
 const trials = join(state, "fixture/solve/training/run-1");
 mkdirSync(join(trials, "exp-1"), {recursive: true});
 mkdirSync(trialSupervisionDirectory(join(trials, "exp-1")), {recursive: true});
 writeFileSync(join(trialSupervisionDirectory(join(trials, "exp-1")), "recovery.json"), JSON.stringify({trial: {id: "exp-1", source: {commit: measured.commit, tree: measured.tree}, worktrees: [join(trials, "exp-1", "solutions")]}, solutionsRoot: live}));
 const solve = join(state, "fixture/solve"), dataRoot = join(state, "fixture/data");
 mkdirSync(join(solve, "agent"), {recursive: true}); mkdirSync(dataRoot, {recursive: true});
 for (const [path, text] of [[join(solve, "task.md"), "UNIT INTRO\n\nTASK TEXT\n"], [join(dataRoot, "profile.json"), '{"rowCount": 2}\n'],
  [join(dataRoot, "development.zip"), "zip"], [join(dataRoot, "development-samples.json"), "{}"], [join(state, "test.zip"), "zip"]]) writeFileSync(path, text);
 const data = {taskId: "fixture", root: solve, solutionsRoot: live, taskPath: join(solve, "task.md"), profilePath: join(dataRoot, "profile.json"),
  devZip: join(dataRoot, "development.zip"), developmentArchive: join(dataRoot, "development.zip"), sampleManifestPath: join(dataRoot, "development-samples.json"),
  developmentManifest: join(dataRoot, "development-samples.json"), testZip: join(state, "test.zip"), testArchive: join(state, "test.zip"), datasetSha256: "dataset"} as unknown as TaskData;
 const trial = await createTrialResolver({roots: () => [trials], solutionsRoot: live}).snapshot("exp-1");
 return {live, trial, sandbox: expertSandbox(data, "validation", readPythonEnvironment(false), trial)};
}

/** The scout's view as the runner builds it, and where its shell calls keep their output. */
async function scoutView(role: Extract<ScoutRole, "data" | "validation">) {
 if (role === "validation") {
  const f = await validationFixture();
  const view = scoutToolset("validation", {sandbox: f.sandbox, solutionsRoot: f.live, taskId: "fixture", trial: f.trial});
  return {view, live: f.live, trial: f.trial, spill: {base: f.live, directory: join(f.live, "scratch/validation/exp-1/shell-calls")},
   system: prompts.render("team.validation", {taskId: "fixture", budget: "5", experiment: "exp-1", commit: f.trial.commit, checks: "none"})};
 }
 const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-shell-")));
 const workspace = join(root, "workspace"), task = join(root, "task");
 mkdirSync(join(workspace, "research"), {recursive: true}); mkdirSync(task);
 const view = scoutToolset("data", {sandbox: workspaceTestSandbox(workspace, task, readPythonEnvironment(false)), solutionsRoot: join(root, "solutions"), taskId: "fixture"});
 return {view, live: undefined, trial: undefined, spill: {base: join(workspace, "research"), directory: join(workspace, "research/.shell-calls")},
  system: prompts.render("team.data", {taskId: "fixture", budget: "5", dataPaths: "none", resources: "- none"})};
}

/**
 * A scout session as `createScoutRunner` starts one: the role's tools (when
 * present, bash rebuilt from the same sandbox and copy folder with fast limits and a
 * harness-owned log root the test can read), tracked,
 * in an observed Pi child with the scout budget, on a scripted provider.
 */
async function scoutSession(role: Extract<ScoutRole, "data" | "validation">, responses: FauxResponseStep[], budget: ScoutBudget, signal = new AbortController().signal) {
 const {view, spill, system, live, trial} = await scoutView(role);
 const logRoot = realpathSync(mkdtempSync(join(tmpdir(), "scout-shell-logs-")));
 const records: {eventType: string; payload?: unknown}[] = [];
 const base = view.tools.some(tool => tool.name === "bash")
  ? replaceToolsByName<ToolDefinition>(view.tools, [agentBashTool({...sandboxShell(view.sandbox, {root: logRoot, spill}), limits: FAST})]) : view.tools;
 const checks = trial ? validationCheckTool({trial, sandbox: view.checkSandbox!, solutionsRoot: live!, taskId: "fixture", prompts,
  record: (eventType, payload) => records.push({eventType, payload})}) : undefined;
 const tools = trackScoutTools([...base, ...(checks ? [checks.tool] : [])]);
 const faux = fauxProvider({provider: `scout-shell-${Math.random()}`, tokensPerSecond: 1_000_000});
 const runtime = await ModelRuntime.create({credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false});
 runtime.registerNativeProvider(faux.provider);
 faux.setResponses(responses);
 const factory = createPiChildFactory({cwd: view.sandbox.cwd, agentDir: realpathSync(mkdtempSync(join(tmpdir(), "scout-shell-agent-"))), model: faux.getModel(), modelRuntime: runtime,
  prompts, sharedInstructions: [], childInstructions: system,
  tools: tools.tools.map(tool => tool.name), customTools: tools.tools, extensionFactories: [budget.extension()], env: {}, inputs: [],
  observe: {identity: {}, telemetry: {failures: [], record: event => records.push(event as never), async close() {}}}, turnTimeoutMs: null});
 const child = await factory({logicalAgentId: `scout-${role}`, parentAgentRunId: "lead", spawnToolCallId: "call"}, signal);
 return {child, tools, records, logRoot, live, spill, checks, trial};
}

sandboxed("every scout with bash gets the supervised agent shell, and tracking keeps it supervised", async () => {
 for (const role of ["data"] as const) {
  const {view} = await scoutView(role);
  const bash = view.tools.find(tool => tool.name === "bash")!;
  expect(isAgentShellTool(bash)).toBe(true);
  const tracked = trackScoutTools(view.tools).tools;
  expect(isAgentShellTool(tracked.find(tool => tool.name === "bash")!)).toBe(true);
  // The child factory's check accepts the tracked set and would refuse a raw bash.
  expect(() => assertSupervisedBash(tracked)).not.toThrow();
  expect(() => assertSupervisedBash([...tracked, {name: "bash"}])).toThrow("agentBashTool");
 }
 const ideas = scoutToolset("ideas", {...(await scoutView("data")).view, solutionsRoot: "/nonexistent", taskId: "fixture", searchEnv: {TAVILY_API_KEY: "fixture"}});
 expect(ideas.tools.some(tool => tool.name === "bash")).toBe(false);
 expect((await scoutView("validation")).view.tools.map(tool => tool.name).sort()).toEqual([...VALIDATION_SCOUT_TOOLS].sort());
}, 30_000);

sandboxed("validation file tools inspect the frozen source without exposing a shell", async () => {
 const {view, live: liveRoot} = await scoutView("validation");
 const live = liveRoot!;
 expect(view.tools.some(tool => tool.name === "bash")).toBe(false);
 const read = view.tools.find(tool => tool.name === "read")!;
 const result = await read.execute("call", {path: "tasks/model.py"}, undefined, undefined, undefined as never);
 expect((result.content[0] as {text: string}).text).toContain("VALUE = 1");
 expect(existsSync(join(live, "scratch/validation/exp-1/shell-calls"))).toBe(false);
 // Its one writable mount (checks/<task>) gets nothing; scratch/ is ignored, so the tree a trial commits is clean.
 expect(existsSync(join(live, "checks/fixture/.shell-calls"))).toBe(false);
 expect(spawnSync("git", ["status", "--porcelain"], {cwd: live, encoding: "utf8"}).stdout).toBe("");
}, 30_000);

sandboxed.each(["data"] as const)("a %s scout's bash runs supervised and bound: a stalled note reaches its session and the budget counts every call", async role => {
 const budget = new ScoutBudget(5, prompts);
 const contexts: string[] = [];
 const {child, tools, records, logRoot} = await scoutSession(role, [
  // Silent for over a second: the supervisor reports it stalled while the call is still running.
  () => fauxAssistantMessage(fauxToolCall("bash", {command: "sleep 1.2"}), {stopReason: "toolUse"}),
  context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage(fauxToolCall("bash", {command: "echo second"}), {stopReason: "toolUse"}); },
  context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage(fauxText("- fact: done")); },
 ], budget);
 const result = await runScoutSession(child, opening(), {lastActivity: () => budget.lastActivity, tools, killMs: 5_000, guard: {stallMs: 20_000, wallMs: 30_000, pollMs: 20, settleMs: 50}});
 expect("value" in result && result.value).toContain("- fact: done");
 expect(result.cleanup).toEqual({forced: false, terminated: true, toolsLeft: 0});
 // The supervisor's finding was delivered to this scout's session, which the model saw on its next turn.
 expect(contexts[0]).toMatch(/\[experiment \S+\] stalled/);
 // Both calls ran as supervised processes in the scout's sandbox, recorded under the scout's own observability.
 const calls = shellRecords(logRoot);
 expect(calls.length).toBe(2);
 for (const call of calls) expect(call.argv).toContain("--unshare-all");
 expect(records.filter(record => record.eventType === "shell_call_returned").length).toBe(2);
 expect(budget.used).toBe(2);
}, 60_000);

sandboxed("a validation child rejects bash and authors and runs a check against the immutable snapshot", async () => {
 const budget = new ScoutBudget(6, prompts), contexts: string[] = [];
 let check = "", marker = "";
 const {child, tools, records, live, checks, trial} = await scoutSession("validation", [
  () => fauxAssistantMessage(fauxToolCall("bash", {command: `echo bypass > ${marker}`}), {stopReason: "toolUse"}),
  context => {
   contexts.push(JSON.stringify(context.messages));
   return fauxAssistantMessage(fauxToolCall("write", {path: check, content: "from solutions.tasks.model import VALUE\nassert VALUE == 1, 'live source was imported'\nprint('snapshot verified')\n"}), {stopReason: "toolUse"});
  },
  () => fauxAssistantMessage(fauxToolCall("run_checks", {paths: ["checks/fixture/check_snapshot.py"]}), {stopReason: "toolUse"}),
  context => { contexts.push(JSON.stringify(context.messages)); return fauxAssistantMessage(fauxText("- ok: snapshot verified with run_checks")); },
 ], budget);
 check = join(live!, "checks/fixture/check_snapshot.py"); marker = join(live!, "checks/fixture/bash-bypass");
 writeFileSync(join(live!, "tasks/model.py"), "VALUE = 999\n");
 const result = await runScoutSession(child, opening(), {lastActivity: () => budget.lastActivity, tools, killMs: 5_000,
  guard: {stallMs: 20_000, wallMs: 30_000, pollMs: 20, settleMs: 50}});
 expect(contexts[0]).toMatch(/Tool bash not found|Unknown tool.*bash|unknown tool.*bash/i);
 const checkReply = JSON.parse(contexts[1]).findLast((message: any) => message.role === "toolResult" && message.toolName === "run_checks");
 expect(JSON.parse(checkReply.content[0].text)).toMatchObject({experiment: "exp-1", passed: true,
  checks: [{exitCode: 0, output: "snapshot verified\n"}]});
 expect(existsSync(marker)).toBe(false);
 expect(readFileSync(check, "utf8")).toContain("VALUE == 1");
 expect(checks!.ran).toHaveLength(1);
 expect(records.filter(row => row.eventType === "validation_checks")).toMatchObject([{payload: {experiment_id: trial!.experimentId,
  commit: trial!.commit, passed: true}}]);
 expect(records.filter(row => row.eventType === "shell_call_returned")).toHaveLength(0);
 expect(budget.used).toBe(3);
 expect("value" in result && result.value).toContain("snapshot verified");
}, 60_000);

sandboxed("a scout stopped by its caller ends its running bash call and leaves no process", async () => {
 const budget = new ScoutBudget(5, prompts);
 const marker = uniqueSleep();
 const stop = new AbortController();
 let reached = false;
 const {child, tools, logRoot} = await scoutSession("data", [
  () => fauxAssistantMessage(fauxToolCall("bash", {command: `sleep ${marker} & sleep ${marker}; echo never`}), {stopReason: "toolUse"}),
  () => { reached = true; return fauxAssistantMessage(fauxText("- fact: not reached")); },
 ], budget, stop.signal);
 const watch = setInterval(() => { if (processesWith(`sleep\0${marker}`).length >= 2) { clearInterval(watch); stop.abort(); } }, 20);
 try {
  const result = await runScoutSession(child, opening(), {lastActivity: () => Date.now(), tools, killMs: 5_000, guard: {stallMs: 20_000, wallMs: 30_000, pollMs: 20, settleMs: 50}});
  expect(stop.signal.aborted).toBe(true);
  expect("value" in result).toBe(false);
  expect(result.cleanup.toolsLeft).toBe(0);
 } finally { clearInterval(watch); }
 expect(reached).toBe(false);
 expect(processesWith(marker)).toEqual([]);
 const [call] = shellRecords(logRoot);
 expect(call.argv).toContain("--unshare-all");
 expect(budget.used).toBe(1);
}, 60_000);

sandboxed("a guard-terminated scout: the hung call and what an earlier call left running are stopped, the budget counts both", async () => {
 const budget = new ScoutBudget(5, prompts);
 const left = uniqueSleep(), hung = uniqueSleep();
 let seen = false;
 const {child, tools, logRoot} = await scoutSession("data", [
  // Backgrounded inside the sandbox: it ends with the call's PID namespace when the command returns.
  () => fauxAssistantMessage(fauxToolCall("bash", {command: `nohup sleep ${left} >/dev/null 2>&1 & echo started`}), {stopReason: "toolUse"}),
  () => fauxAssistantMessage(fauxToolCall("bash", {command: `sleep ${hung}; echo never`}), {stopReason: "toolUse"}),
  () => fauxAssistantMessage(fauxText("- fact: not reached")),
 ], budget);
 const watch = setInterval(() => { if (processesWith(`sleep\0${hung}`).length) seen = true; }, 20);
 try {
  const result = await runScoutSession(child, opening(), {lastActivity: () => seen ? 0 : Date.now(), tools, killMs: 5_000,
   guard: {stallMs: 200, wallMs: 30_000, pollMs: 20, settleMs: 50}});
  expect(seen).toBe(true);
  expect("stopped" in result && result.stopped).toBe("stall");
  expect(result.cleanup).toEqual({forced: true, terminated: true, toolsLeft: 0});
 } finally { clearInterval(watch); }
 expect(processesWith(hung)).toEqual([]);
 expect(processesWith(left)).toEqual([]);
 expect(shellRecords(logRoot).length).toBe(2);
 expect(budget.used).toBe(2);
}, 60_000);

/**
 * A host-shell child (the factory's default bash, as generic subagents get it)
 * can leave a process running past its call; the child's `close()` and the
 * scouts' forced `terminate()` both stop it through the supervisor.
 */
test.skipIf(process.platform !== "linux").each(["close", "terminate"] as const)("a child's %s() stops what its shell calls left running", async end => {
 const root = realpathSync(mkdtempSync(join(tmpdir(), `child-${end}-`)));
 const left = uniqueSleep();
 const faux = fauxProvider({provider: `child-${end}-${Math.random()}`, tokensPerSecond: 1_000_000});
 const runtime = await ModelRuntime.create({credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false});
 runtime.registerNativeProvider(faux.provider);
 const results: string[] = [];
 faux.setResponses([
  () => fauxAssistantMessage(fauxToolCall("bash", {command: `setsid sleep ${left} >/dev/null 2>&1 < /dev/null & echo started`}), {stopReason: "toolUse"}),
  context => { results.push(JSON.stringify(context.messages)); return fauxAssistantMessage(fauxText("done")); },
 ]);
 const factory = createPiChildFactory({cwd: root, agentDir: root, model: faux.getModel(), modelRuntime: runtime, prompts, sharedInstructions: [],
  env: {PATH: process.env.PATH}, inputs: [], shellLogRoot: join(root, "shell-calls"),
  observe: {identity: {}, telemetry: {failures: [], record() {}, async close() {}}}});
 const child = await factory({logicalAgentId: "child", parentAgentRunId: "lead", spawnToolCallId: "call"}, new AbortController().signal);
 try {
  expect(await child.prompt(prompts.render("subagents.start", {task: "Run it."}))).toContain("done");
  // The call returned, and told the child its process is still running and tracked.
  expect(results[0]).toContain("still running");
  expect(processesWith(`sleep\0${left}`).length).toBe(1);
 } finally {
  await (end === "close" ? child.close() : child.terminate());
 }
 expect(processesWith(left)).toEqual([]);
}, 30_000);

function opening() {
 return prompts.render("team.start", {task: "task", question: "inspect", refs: "none", shown: "0", omitted: "0", earlier: "none"});
}
