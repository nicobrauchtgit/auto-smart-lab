/** Independent observed child sessions; only their final reply crosses the boundary. */
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { isolatedSolveTools, sandboxPolicy, type SolveSandbox } from "../run/solve_sandbox.js";
import type { AgentObservation } from "../observability.js";
import type { PromptSnapshot } from "../prompts/loader.js";
import type { ScoutRole } from "./contracts.js";
import type { ScoutReply, ScoutSessionInput } from "./scouts.js";
import { scoutRequirements } from "./setup.js";
import { SetupSession, setupChecks } from "../pipeline/setup.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";
import type { Telemetry } from "../telemetry/runtime.js";
import { initializeModel } from "../model_provider.js";
import { loadPipelineConfig } from "../pipeline_config.js";
import { createPiChildFactory } from "../subagents/pi.js";
import { preparePythonEnvironment, readPythonEnvironment } from "../run/python_environment.js";
import { HARNESS_CONFIG } from "../harness/config.js";
import { guardScoutSession } from "./budget.js";
import { scoutSearch } from "./search.js";

export const READ_ONLY_SCOUT_TOOLS = ["read", "grep", "find", "ls"] as const;

/**
 * The scout's filesystem view: every controller mount read-only, plus a
 * writable research/ folder for the data scout only. Ideas gets the read-only
 * file tools and its own search budget; nothing that writes or runs code.
 */
export function scoutToolset(role: Exclude<ScoutRole, "validation">, options: {
 sandbox: SolveSandbox; researchRoot: string; searchApiKey?: string;
}): { sandbox: SolveSandbox; tools: ToolDefinition[] } {
 const research = resolve(options.researchRoot);
 if (research !== resolve(options.sandbox.cwd, "research")) throw new Error("Scout workspace must have its own research/ folder");
 const sandbox = sandboxPolicy({cwd: options.sandbox.cwd, env: options.sandbox.env, bwrap: options.sandbox.executable,
  mounts: [...options.sandbox.mounts.map(mount => ({...mount, writable: false})),
   ...(role === "data" ? [{source: research, writable: true}] : [])]});
 const tools = isolatedSolveTools(sandbox).filter(tool => role === "data" || (READ_ONLY_SCOUT_TOOLS as readonly string[]).includes(tool.name));
 if (role === "ideas") {
  if (!options.searchApiKey) throw new Error("Ideas scout requires a web search key");
  tools.push(scoutSearch({apiKey: options.searchApiKey, limit: HARNESS_CONFIG.team.scouts.ideas.webSearches, log: join(research, "web-sources.jsonl")}));
 }
 return {sandbox, tools};
}

export function createScoutRunner(options: {
 prompts: PromptSnapshot; taskId: string; taskConfiguration: TaskConfiguration; telemetry: Telemetry;
 record(event: string, payload: Record<string, unknown>): void;
 /** Controller supplies permitted development inputs only; never withheld targets. */
 sandbox: SolveSandbox; researchRoot: string; observe: AgentObservation;
 parentAgentRunId?: string | (() => string);
 /** Where this run's journal and unit introduction live, when not the task defaults. */
 scoutPaths?: { journal: string; unitIntro: string };
 /** Share passed setup checks with an earlier preflight of the same run. */
 setup?: SetupSession;
}) {
 const setup = options.setup ?? new SetupSession();
 const prepare = async (roles: readonly ScoutRole[], signal = new AbortController().signal) => {
  if (roles.includes("validation")) throw new Error("Stream B snapshot check adapter not integrated");
  await setup.check(setupChecks([...new Set(roles.flatMap(scoutRequirements))], {taskId: options.taskId, taskConfiguration: options.taskConfiguration,
   prompts: options.prompts, telemetry: options.telemetry, scoutPaths: options.scoutPaths}), signal, options.record);
 };
 const run = async (input: ScoutSessionInput): Promise<ScoutReply> => {
  if (input.role === "validation") throw new Error("Stream B snapshot check adapter not integrated");
  const signal = input.signal ?? new AbortController().signal;
  await prepare([input.role], signal);
  mkdirSync(resolve(options.researchRoot), {recursive: true});
  const {sandbox, tools} = scoutToolset(input.role, {sandbox: options.sandbox, researchRoot: options.researchRoot, searchApiKey: process.env.TAVILY_API_KEY});
  const pipeline = await loadPipelineConfig();
  const model = await initializeModel({config: pipeline.config});
  const python = preparePythonEnvironment(options.prompts, readPythonEnvironment());
  const factory = createPiChildFactory({cwd: sandbox.cwd, agentDir: pipeline.agentDir, ...model, prompts: options.prompts,
   sharedInstructions: [input.shared, python.prompt], childInstructions: input.system, inputs: [python.input, {kind: "scout_configuration", version: 1, delivery: "initial_prompt", status: "available",
    taskId: options.taskId, configuration: options.taskConfiguration, role: input.role, toolBudget: input.budget.limit, maxTurns: input.budget.maxTurns,
    guard: HARNESS_CONFIG.team.scoutGuard}], env: {...process.env, ...python.env},
   tools: tools.map(tool => tool.name), customTools: tools, extensionFactories: [input.budget.extension()],
   // The budget bounds turns and calls; guardScoutSession detects stuck sessions.
   observe: options.observe, turnTimeoutMs: null});
  options.record("scout_session_start", {role: input.role, budget: input.budget.limit, maxTurns: input.budget.maxTurns});
  const child = await factory({logicalAgentId: randomUUID(), parentAgentRunId: (typeof options.parentAgentRunId === "function" ? options.parentAgentRunId() : options.parentAgentRunId) ?? options.observe.identity.stageInvocationId ?? "scout-probe", spawnToolCallId: input.toolCallId}, signal);
  let outcome = "failure";
  try {
   const guarded = await guardScoutSession(child.prompt(input.opening), {abort: () => child.abort(), lastActivity: () => input.budget.lastActivity,
    ...HARNESS_CONFIG.team.scoutGuard});
   if (guarded.stopped) {
    outcome = `stopped:${guarded.stopped}`;
    const minutes = Math.round((guarded.stopped === "wall" ? HARNESS_CONFIG.team.scoutGuard.wallMs : HARNESS_CONFIG.team.scoutGuard.stallMs) / 60_000);
    return {text: "", root: sandbox.cwd, stopped: guarded.stopped === "wall" ? `still running after ${minutes} min` : `no progress for ${minutes} min`};
   }
   outcome = input.budget.stopped ? `success:${input.budget.stopped}-limit` : "success";
   return {text: guarded.value, root: sandbox.cwd};
  }
  catch {signal.throwIfAborted(); throw new Error("Scout session failed; inspect its observed run");}
  finally {
   try {
    // A stuck session may never settle; closing it must not block the lead either.
    const closing = child.close().catch(() => undefined);
    if (outcome.startsWith("stopped")) { let timer: ReturnType<typeof setTimeout> | undefined; await Promise.race([closing, new Promise(accept => { timer = setTimeout(accept, 30_000); })]); clearTimeout(timer); }
    else await closing;
   } finally {options.record("scout_session_end", {role: input.role, used: input.budget.used, attempted: input.budget.attempted,
    blocked: input.budget.blocked, turns: input.budget.turns, outcome});}
  }
 };
 return Object.assign(run, {prepare});
}
