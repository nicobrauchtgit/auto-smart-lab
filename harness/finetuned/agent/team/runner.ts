/** Independent observed child sessions; only their final reply crosses the boundary. */
import { join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isolatedSolveTools, sandboxPolicy, type SandboxMount, type SolveSandbox } from "../run/solve_sandbox.js";
import type { AgentObservation } from "../observability.js";
import type { PromptSnapshot, RenderedPrompt } from "../prompts/loader.js";
import type { ScoutRole, TrialSnapshot } from "./contracts.js";
import type { ScoutReply, ScoutSessionInput } from "./scouts.js";
import { scoutRequirements } from "./setup.js";
import { SetupSession, setupChecks } from "../pipeline/setup.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";
import type { Telemetry } from "../telemetry/runtime.js";
import { initializeModel } from "../model_provider.js";
import { loadPipelineConfig } from "../pipeline_config.js";
import { createPiChildFactory, type PiChildSession } from "../subagents/pi.js";
import { preparePythonEnvironment, readPythonEnvironment } from "../run/python_environment.js";
import { HARNESS_CONFIG } from "../harness/config.js";
import { webSearchExtension } from "../tools/web_search.js";
import { runTrialChecks } from "../evaluation/checks.js";
import { guardScoutSession } from "./budget.js";
import { wrapAgentTool } from "../run/agent_shell.js";

export const READ_ONLY_SCOUT_TOOLS = ["read", "grep", "find", "ls"] as const;
/** Results per web search; the ideas scout reads a few sources, not a result page. */
const SEARCH_RESULTS = 4;
const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);
const real = (path: string) => existsSync(path) ? realpathSync(path) : resolve(path);

/** One scout call's view of the controller sandbox, with what its tools need. */
export interface ScoutView {
 sandbox: SolveSandbox; tools: ToolDefinition[];
 /** Session-local extensions (web search) and the tool names they register. */
 extensions: InlineExtension[]; extensionTools: string[];
 /** Validation only: the sandbox its checks run in (live solutions root as cwd, never mounted). */
 checkSandbox?: SolveSandbox;
}

/**
 * The scout's filesystem view of one call's controller sandbox: every mount
 * read-only, plus
 * - data: a writable research/ folder in its cwd;
 * - ideas: nothing writable; read-only file tools and B's web search
 *   extension, capped per session, with its own log in research/;
 * - validation: the trial snapshot read-only as cwd; the live solutions tree
 *   is hidden except checks/ (only checks/<task>/ writable) and this trial's
 *   check and shell-call logs.
 * Every role with bash gets the supervised agent shell (run/agent_shell.ts).
 */
export function scoutToolset(role: ScoutRole, options: {
 sandbox: SolveSandbox; solutionsRoot: string; taskId: string; trial?: TrialSnapshot;
 /** Session environment snapshot for web search; only TAVILY_API_KEY is read. */
 searchEnv?: Readonly<Record<string, string | undefined>>;
}): ScoutView {
 const readOnly = options.sandbox.mounts.map(mount => ({...mount, writable: false}));
 const policy = (mounts: SandboxMount[], cwd: string) => sandboxPolicy({cwd, env: options.sandbox.env, bwrap: options.sandbox.bwrap, scratchRoot: options.sandbox.scratchRoot, mounts});
 if (role === "validation") {
  const trial = options.trial;
  if (!trial) throw new Error("Validation scout requires a resolved trial snapshot");
  const live = real(options.solutionsRoot), source = real(trial.sourceRoot);
  if (!options.sandbox.mounts.some(mount => !mount.writable && real(mount.source) === source)) throw new Error("Validation sandbox must mount the trial snapshot read-only");
  const checks = join(live, "checks", options.taskId), logs = join(live, "scratch", "validation", trial.experimentId);
  for (const path of [checks, logs]) mkdirSync(path, {recursive: true});
  const mounts = [...readOnly.filter(mount => !inside(real(mount.source), live)),
   {source: join(live, "checks")}, {source: checks, writable: true}, {source: logs}];
  const sandbox = policy(mounts, join(source, "solutions"));
  // The scout reads a copy of each shell call's output beside this trial's check logs: gitignored
  // scratch, never checks/<task>/ (its one writable mount), which trial commits would pick up.
  // The logs themselves stay harness-owned, outside every mount; the copy is never read back.
  return {sandbox, tools: isolatedSolveTools(sandbox, {spill: {base: live, directory: join(logs, "shell-calls")}}), extensions: [], extensionTools: [], checkSandbox: policy(mounts, live)};
 }
 const research = join(options.sandbox.cwd, "research");
 if (!existsSync(research)) throw new Error("Scout workspace must have its own research/ folder");
 const sandbox = policy([...readOnly, ...(role === "data" ? [{source: research, writable: true}] : [])], options.sandbox.cwd);
 const tools = isolatedSolveTools(sandbox).filter(tool => role === "data" || (READ_ONLY_SCOUT_TOOLS as readonly string[]).includes(tool.name));
 if (role === "data") return {sandbox, tools, extensions: [], extensionTools: []};
 if (!options.searchEnv?.TAVILY_API_KEY) throw new Error("Ideas scout requires a web search key");
 // One log per scout session, beside the data scout's research; the harness writes it, not the scout.
 const search = webSearchExtension({maxCalls: HARNESS_CONFIG.team.scouts.ideas.webSearches, maxResults: SEARCH_RESULTS,
  logPath: join(research, `web-search-${randomUUID()}.jsonl`), env: {TAVILY_API_KEY: options.searchEnv.TAVILY_API_KEY}});
 return {sandbox, tools, extensions: [{name: "scout-web-search", factory: search}], extensionTools: ["web_search"]};
}

/** Last part of a check's output, enough to show a traceback or assertion: from the pipes the harness read, never the log file. */
const tail = (text: string, chars = 1_500) => text.length > chars ? `…${text.slice(-chars)}` : text;

/**
 * `run_checks` for the validation scout: stream B's runTrialChecks against the
 * call's snapshot. Checks must be .py files in the task's checks folder; each
 * run records the hash of the bytes it ran, so journaled check refs go stale
 * when the check changes.
 */
export function validationCheckTool(options: {
 trial: TrialSnapshot; sandbox: SolveSandbox; solutionsRoot: string; taskId: string; prompts: PromptSnapshot;
 record?(event: string, payload: Record<string, unknown>): void;
}) {
 const ran: { path: string; sha256: string }[] = [];
 const live = real(options.solutionsRoot), folder = join(live, "checks", options.taskId);
 const tool = defineTool({name: "run_checks", label: "Run checks", description: options.prompts.render("team.check-tool", {}).text,
  parameters: Type.Object({paths: Type.Array(Type.String({minLength: 1}), {minItems: 1, maxItems: 8})}, {additionalProperties: false}),
  async execute(_id, args, signal) {
   const reply = (data: unknown) => ({content: [{type: "text" as const, text: JSON.stringify(data, null, 1)}], details: {}});
   const paths: string[] = [];
   for (const path of args.paths) {
    const absolute = resolve(path.startsWith("checks/") ? live : folder, path);
    if (!existsSync(absolute) || !inside(realpathSync(absolute), folder) || !absolute.endsWith(".py")) return reply({error: `${path}: not a .py file in ${folder}`});
    paths.push(realpathSync(absolute));
   }
   const hashes = new Map(paths.map(path => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]));
   try {
    const result = await runTrialChecks(options.trial, paths, options.sandbox, signal);
    const checks = result.checks.map(check => ({path: relative(live, check.path).split(sep).join("/"), exitCode: check.exitCode, sha256: hashes.get(check.path)!, output: tail(check.output)}));
    for (const check of checks) { const at = ran.findIndex(row => row.path === check.path); if (at >= 0) ran.splice(at, 1); ran.push({path: check.path, sha256: check.sha256}); }
    options.record?.("validation_checks", {experiment_id: options.trial.experimentId, commit: options.trial.commit, passed: result.passed,
     checks: checks.map(({path, exitCode, sha256}, index) => ({path, exitCode, sha256, logPath: result.checks[index].logPath}))});
    return reply({experiment: options.trial.experimentId, passed: result.passed, checks: checks.map(({path, exitCode, output}) => ({path, exitCode, output}))});
   } catch (error) {
    signal?.throwIfAborted();
    return reply({error: (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 300)});
   }
  }});
 return {tool, ran};
}

export function createScoutRunner(options: {
 prompts: PromptSnapshot; taskId: string; taskConfiguration: TaskConfiguration; telemetry: Telemetry;
 record(event: string, payload: Record<string, unknown>): void;
 /**
  * Builds the sandbox for one scout call, never bound once:
  * `expertSandbox(data, role, python, trial)` in production. The controller
  * supplies permitted development inputs only, never withheld targets.
  */
 sandbox(role: ScoutRole, trial?: TrialSnapshot): SolveSandbox;
 /** The shared solutions tree (TaskData.solutionsRoot). */
 solutionsRoot: string;
 observe: AgentObservation;
 parentAgentRunId?: string | (() => string);
 /** Where this run's journal, unit introduction and task text live, when not the task defaults. */
 scoutPaths: { journal: string; unitIntro: string; task: string; profile: string };
 /** Share passed setup checks with an earlier preflight of the same run. */
 setup?: SetupSession;
}) {
 const setup = options.setup ?? new SetupSession();
 const prepare = async (roles: readonly ScoutRole[], signal = new AbortController().signal) => {
  await setup.check(setupChecks([...new Set(roles.flatMap(scoutRequirements))], {taskId: options.taskId, taskConfiguration: options.taskConfiguration,
   prompts: options.prompts, telemetry: options.telemetry, scoutPaths: options.scoutPaths}), signal, options.record);
 };
 const run = async (input: ScoutSessionInput): Promise<ScoutReply> => {
  const signal = input.signal ?? new AbortController().signal;
  await prepare([input.role], signal);
  if (input.role === "validation" && !input.trial) throw new Error("Validation scout requires a resolved trial snapshot");
  const view = scoutToolset(input.role, {sandbox: options.sandbox(input.role, input.trial), solutionsRoot: options.solutionsRoot, taskId: options.taskId,
   trial: input.trial, searchEnv: {TAVILY_API_KEY: process.env.TAVILY_API_KEY}});
  const checks = input.trial && view.checkSandbox ? validationCheckTool({trial: input.trial, sandbox: view.checkSandbox, solutionsRoot: options.solutionsRoot,
   taskId: options.taskId, prompts: options.prompts, record: options.record}) : undefined;
  const tracked = trackScoutTools([...view.tools, ...(checks ? [checks.tool] : [])]), tools = tracked.tools;
  const sandbox = view.sandbox;
  const pipeline = await loadPipelineConfig();
  const model = await initializeModel({config: pipeline.config});
  const python = preparePythonEnvironment(options.prompts, readPythonEnvironment());
  const factory = createPiChildFactory({cwd: sandbox.cwd, agentDir: pipeline.agentDir, ...model, prompts: options.prompts,
   sharedInstructions: [input.shared, python.prompt], childInstructions: input.system, inputs: [python.input, {kind: "scout_configuration", version: 1, delivery: "initial_prompt", status: "available",
    taskId: options.taskId, configuration: options.taskConfiguration, role: input.role, toolBudget: input.budget.limit, maxTurns: input.budget.maxTurns,
    guard: HARNESS_CONFIG.team.scoutGuard, ...(input.trial ? {experiment_id: input.trial.experimentId, commit: input.trial.commit, tree: input.trial.tree} : {})}],
   env: {...process.env, ...python.env},
   tools: [...tools.map(tool => tool.name), ...view.extensionTools], customTools: tools, extensionFactories: [input.budget.extension(), ...view.extensions],
   extensionTools: view.extensionTools,
   // The budget bounds turns and calls; guardScoutSession detects stuck sessions.
   observe: options.observe, turnTimeoutMs: null});
  options.record("scout_session_start", {role: input.role, tool_call_id: input.toolCallId, budget: input.budget.limit, maxTurns: input.budget.maxTurns,
   cwd: sandbox.cwd, writable: sandbox.mounts.filter(mount => mount.writable).map(mount => mount.source), ...(input.trial ? {experiment_id: input.trial.experimentId} : {})});
  const child = await factory({logicalAgentId: randomUUID(), parentAgentRunId: (typeof options.parentAgentRunId === "function" ? options.parentAgentRunId() : options.parentAgentRunId) ?? options.observe.identity.stageInvocationId ?? "scout-probe", spawnToolCallId: input.toolCallId}, signal);
  const result = await runScoutSession(child, input.opening, {lastActivity: () => input.budget.lastActivity, guard: HARNESS_CONFIG.team.scoutGuard, tools: tracked, signal});
  const outcome = signal.aborted ? "stopped:cancelled" : "value" in result ? (input.budget.stopped ? `success:${input.budget.stopped}-limit` : "success")
   : "stopped" in result ? `stopped:${result.stopped}` : "failure";
  options.record("scout_session_end", {role: input.role, tool_call_id: input.toolCallId, used: input.budget.used, attempted: input.budget.attempted,
   blocked: input.budget.blocked, turns: input.budget.turns, outcome, ...result.cleanup});
  const ran = checks ? {checks: [...checks.ran]} : {};
  if ("value" in result) return {text: result.value, root: sandbox.cwd, ...ran};
  if ("stopped" in result) {
   const minutes = Math.round((result.stopped === "wall" ? HARNESS_CONFIG.team.scoutGuard.wallMs : HARNESS_CONFIG.team.scoutGuard.stallMs) / 60_000);
   return {text: "", root: sandbox.cwd, stopped: result.stopped === "wall" ? `still running after ${minutes} min` : `no progress for ${minutes} min`, ...ran};
  }
  signal.throwIfAborted();
  throw new Error("Scout session failed; inspect its observed run");
 };
 return Object.assign(run, {prepare});
}

/**
 * Gives every scout tool an abort signal the runner owns, besides Pi's, and
 * tracks each execution until it settles. An aborted bash call stops its tree
 * through its supervisor (run/agent_shell.ts): SIGTERM, a grace period, SIGKILL
 * to what remains, the sandbox launcher last; it settles once that stop
 * returns. The other isolated tools SIGKILL their bubblewrap worker on abort
 * and settle once it has exited. `wrapAgentTool` keeps the supervision brand,
 * so the child factory still validates and binds the tracked bash.
 */
export function trackScoutTools(tools: readonly ToolDefinition[]) {
 const controller = new AbortController();
 const running = new Set<Promise<void>>();
 return {
  tools: tools.map(tool => wrapAgentTool(tool, execute => (id, params, signal, onUpdate, context) => {
   const run = execute(id, params, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, onUpdate, context);
   const settled: Promise<void> = run.then(() => undefined, () => undefined).finally(() => { running.delete(settled); });
   running.add(settled);
   return run;
  })),
  get running() { return running.size; },
  /** Aborts every execution, now and later; returns how many are still running after `ms`. */
  async stop(ms: number): Promise<number> {
   controller.abort();
   let timer: ReturnType<typeof setTimeout> | undefined;
   await Promise.race([Promise.all(running), new Promise(accept => { timer = setTimeout(accept, ms); })]);
   clearTimeout(timer);
   return running.size;
  },
 };
}
export type TrackedScoutTools = ReturnType<typeof trackScoutTools>;

/**
 * One scout prompt under the stall guard, with cleanup that cannot hang. A
 * finished or failed session is closed normally. A stopped one may never
 * settle, so it is terminated: the Pi session is disposed and its observer
 * released without waiting for the prompt, and every tool execution is
 * aborted and awaited (at most `killMs`). `cleanup` reports what remained.
 */
export async function runScoutSession(child: Pick<PiChildSession, "prompt" | "abort" | "close" | "terminate">, opening: RenderedPrompt, options: {
 lastActivity(): number; tools: TrackedScoutTools; killMs?: number; signal?: AbortSignal;
 guard: { stallMs: number; wallMs: number; pollMs?: number; settleMs?: number };
}): Promise<({ value: string } | { stopped: "stall" | "wall" } | { error: unknown }) & { cleanup: { forced: boolean; toolsLeft: number; terminated: boolean } }> {
 const killMs = options.killMs ?? 10_000;
 let result: { value: string } | { stopped: "stall" | "wall" } | { error: unknown };
 const cancelled = new AbortController();
 const abort = () => { void child.abort().catch(() => undefined); cancelled.abort(); };
 options.signal?.addEventListener("abort", abort, { once: true });
 if (options.signal?.aborted) abort();
 try {
  const guarded = await guardScoutSession(Promise.race([child.prompt(opening), new Promise<never>((_, reject) => {
   const stop = () => reject(new Error("Scout cancelled"));
   if (cancelled.signal.aborted) stop(); else cancelled.signal.addEventListener("abort", stop, { once: true });
  })]), {abort: () => child.abort(), lastActivity: options.lastActivity, ...options.guard});
  result = guarded.stopped ? {stopped: guarded.stopped} : {value: guarded.value};
 } catch (error) { result = {error}; }
 options.signal?.removeEventListener("abort", abort);
 const forced = "stopped" in result || cancelled.signal.aborted;
 let terminated = true;
 if (forced) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  terminated = await Promise.race([child.terminate().then(() => true, () => false), new Promise<false>(accept => { timer = setTimeout(() => accept(false), killMs); })]);
  clearTimeout(timer);
 } else await child.close().catch(() => undefined);
 const toolsLeft = await options.tools.stop(killMs);
 return {...result, cleanup: {forced, toolsLeft, terminated}};
}
