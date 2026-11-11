/** Scoped adapter for the blocking scout service. No transcript is returned. */
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { runSession } from "../run/session_runner.js";
import { isolatedSolveTools, sandboxPolicy, type SolveSandbox } from "../run/solve_sandbox.js";
import type { AgentObservation } from "../observability.js";
import type { PromptSnapshot } from "../prompts/loader.js";
import type { ScoutSessionInput } from "./scouts.js";
import { scoutRequirements } from "./setup.js";
import { SetupSession, setupChecks } from "../pipeline/setup.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";
import type { Telemetry } from "../telemetry/runtime.js";
import { ARM_ROOT } from "../paths.js";

export function createScoutRunner(options: {
 prompts: PromptSnapshot;
 taskId: string; taskConfiguration: TaskConfiguration; telemetry: Telemetry;
 record(event: string, payload: Record<string, unknown>): void;
 /** Prepared by controller: development data only, never the withheld targets. */
 sandbox: SolveSandbox;
 researchRoot: string;
 observe: AgentObservation;
 parentAgentRunId?: string;
}) {
 const setup = new SetupSession();
 return async (input: ScoutSessionInput): Promise<string> => {
  if (input.role === "validation") throw new Error("Stream B snapshot check adapter not integrated");
  await setup.check(setupChecks(scoutRequirements(input.role), { taskId: options.taskId, taskConfiguration: options.taskConfiguration,
   prompts: options.prompts, telemetry: options.telemetry }), input.signal ?? new AbortController().signal, options.record);
  const research = resolve(options.researchRoot);
  if (research !== resolve(options.sandbox.cwd, "research")) throw new Error("Scout workspace must have its own research/ folder");
  mkdirSync(research, { recursive: true });
  const sandbox = sandboxPolicy({ cwd: options.sandbox.cwd, env: options.sandbox.env, bwrap: options.sandbox.executable,
   mounts: [...options.sandbox.mounts.map(mount => ({ ...mount, writable: false })),
    ...(input.role === "data" ? [{ source: research, writable: true }] : [])] });
  const customTools = isolatedSolveTools(sandbox).filter(tool => input.role === "data" || ["read", "grep", "find", "ls"].includes(tool.name));
  options.record("scout_session_start", {role: input.role, budget: input.budget.limit});
  const result = await runSession({ prompts: options.prompts, system: input.system, prompt: input.opening.text,
   promptReferences: [input.opening.reference], cwd: sandbox.cwd, tools: input.role === "ideas" ? ["web_search"] : [], customTools,
   extensionFactories: [input.budget.extension()],
   extensionPaths: input.role === "ideas" ? [join(ARM_ROOT, "agent/tools/web_search.ts")] : [],
   env: { WEB_SEARCH_MAX_CALLS: "3", WEB_SEARCH_MAX_RESULTS: "4", WEB_SEARCH_LOG: join(research, "web-sources.jsonl") },
   observe: options.observe, signal: input.signal,
   onSessionReady: (_session, identity) => { options.record("subagent_link", {role: input.role, parentAgentRunId: options.parentAgentRunId, ...identity}); },
  });
  options.record("scout_session_end", {role: input.role, used: input.budget.used, blocked: input.budget.blocked, agentRunId: result.agentRunId});
  return result.output;
 };
}
