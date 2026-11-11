/** Independent observed child sessions; only their final reply crosses the boundary. */
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { isolatedSolveTools, sandboxPolicy, type SolveSandbox } from "../run/solve_sandbox.js";
import type { AgentObservation } from "../observability.js";
import type { PromptSnapshot } from "../prompts/loader.js";
import type { ScoutRole } from "./contracts.js";
import type { ScoutSessionInput } from "./scouts.js";
import { scoutRequirements } from "./setup.js";
import { SetupSession, setupChecks } from "../pipeline/setup.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";
import type { Telemetry } from "../telemetry/runtime.js";
import { initializeModel } from "../model_provider.js";
import { loadPipelineConfig } from "../pipeline_config.js";
import { createPiChildFactory } from "../subagents/pi.js";
import { preparePythonEnvironment, readPythonEnvironment } from "../run/python_environment.js";
import { HARNESS_CONFIG } from "../harness/config.js";
import { scoutSearch } from "./search.js";

export function createScoutRunner(options: {
 prompts: PromptSnapshot; taskId: string; taskConfiguration: TaskConfiguration; telemetry: Telemetry;
 record(event: string, payload: Record<string, unknown>): void;
 /** Controller supplies permitted development inputs only; never withheld targets. */
 sandbox: SolveSandbox; researchRoot: string; observe: AgentObservation;
 parentAgentRunId?: string | (() => string);
}) {
 const setup = new SetupSession();
 const prepare = async (roles: readonly ScoutRole[], signal = new AbortController().signal) => {
  if (roles.includes("validation")) throw new Error("Stream B snapshot check adapter not integrated");
  await setup.check(setupChecks([...new Set(roles.flatMap(scoutRequirements))], {taskId: options.taskId, taskConfiguration: options.taskConfiguration,
   prompts: options.prompts, telemetry: options.telemetry}), signal, options.record);
 };
 const run = async (input: ScoutSessionInput): Promise<string> => {
  if (input.role === "validation") throw new Error("Stream B snapshot check adapter not integrated");
  const signal = input.signal ?? new AbortController().signal;
  await prepare([input.role], signal);
  const research = resolve(options.researchRoot);
  if (research !== resolve(options.sandbox.cwd, "research")) throw new Error("Scout workspace must have its own research/ folder");
  mkdirSync(research, {recursive: true});
  const sandbox = sandboxPolicy({cwd: options.sandbox.cwd, env: options.sandbox.env, bwrap: options.sandbox.executable,
   mounts: [...options.sandbox.mounts.map(mount => ({...mount, writable: false})),
    ...(input.role === "data" ? [{source: research, writable: true}] : [])]});
  const tools = isolatedSolveTools(sandbox).filter(tool => input.role === "data" || ["read", "grep", "find", "ls"].includes(tool.name));
  if (input.role === "ideas") tools.push(scoutSearch({apiKey: process.env.TAVILY_API_KEY!, limit: HARNESS_CONFIG.team.scouts.ideas.webSearches, log: join(research, "web-sources.jsonl")}));
  const pipeline = await loadPipelineConfig();
  const model = await initializeModel({config: pipeline.config});
  const python = preparePythonEnvironment(options.prompts, readPythonEnvironment());
  const factory = createPiChildFactory({cwd: sandbox.cwd, agentDir: pipeline.agentDir, ...model, prompts: options.prompts,
   sharedInstructions: [python.prompt], childInstructions: input.system, inputs: [python.input, {kind: "scout_configuration", version: 1, delivery: "initial_prompt", status: "available",
    taskId: options.taskId, configuration: options.taskConfiguration, role: input.role, toolBudget: input.budget.limit}], env: {...process.env, ...python.env},
   tools: tools.map(tool => tool.name), customTools: tools, extensionFactories: [input.budget.extension()],
   observe: options.observe, turnTimeoutMs: null});
  options.record("scout_session_start", {role: input.role, budget: input.budget.limit});
  const child = await factory({logicalAgentId: randomUUID(), parentAgentRunId: (typeof options.parentAgentRunId === "function" ? options.parentAgentRunId() : options.parentAgentRunId) ?? options.observe.identity.stageInvocationId ?? "scout-probe", spawnToolCallId: input.toolCallId}, signal);
  let outcome = "failure";
  try { const output = await child.prompt(input.opening); outcome = "success"; return output; }
  catch {signal.throwIfAborted(); throw new Error("Scout session failed; inspect its observed run");}
  finally {
   try {await child.close();} finally {options.record("scout_session_end", {role: input.role, used: input.budget.used, blocked: input.budget.blocked, outcome});}
  }
 };
 return Object.assign(run, {prepare});
}
