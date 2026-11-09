import { runSession, type RunSessionOptions } from "../run/session_runner.js";
import type { StageReporter } from "../pipeline/types.js";
import type { PromptSnapshot } from "../prompts/loader.js";
import { controllerTools } from "./tools.js";
import type { Coordinator } from "./coordinator.js";
import { hash } from "./state.js";
export function orchestrationSessionOptions(options: { coordinator: Coordinator; prompts: PromptSnapshot; report: StageReporter; taskDescription: string; taskFiles?: { name: string; bytes: number }[]; knowledgeSummaries?: unknown; model?: string; signal: AbortSignal; attempt: number }): RunSessionOptions {
 const { coordinator, prompts, report } = options;
 const system = prompts.render("orchestrator.system", {}), tool = prompts.render("orchestrator.tool", {});
 const start = prompts.render("orchestrator.start", { task: options.taskDescription, context: JSON.stringify({ state: coordinator.status(), taskDataFiles: options.taskFiles ?? [], knowledge: options.knowledgeSummaries ?? [], knowledgeAuthority: "Prior work only; revalidate applicability and current evidence" }) });
 report.input({ kind: "orchestrator_state", version: 1, delivery: "initial_prompt", status: "available", revision: coordinator.state.revision, goal: coordinator.state.goal, policy: coordinator.state.policy, capabilities: coordinator.state.config.enabledStages, task_fingerprint: coordinator.state.taskFingerprint });
 report.input({ kind: "task_data_files", version: 1, delivery: "initial_prompt", status: "available", content_sha256: hash(options.taskFiles ?? []), files: (options.taskFiles ?? []).length });
 report.input({ kind: "task_knowledge", version: 1, delivery: "initial_prompt", status: "available", content_sha256: hash(options.knowledgeSummaries ?? []), authoritative_for_current_run: false, selection: "bounded scoped summaries", task_id: coordinator.state.taskId });
 return { prompts, system, prompt: start.text, promptReferences: [system.reference, start.reference, tool.reference],
  tools: [], extensions: false, extensionPaths: [], customTools: controllerTools(coordinator, prompts), observe: { ...report.observation(options.attempt), executionGuard: coordinator.executionGuard }, reportInput: input => report.input(input), model: options.model, signal: options.signal,
  sessionContext: () => JSON.stringify({ controllerState: coordinator.status() }),
  onSessionReady: (_session, identity) => { report.event("orchestrator_session_bound", { logical_owner: coordinator.state.controlInvocationId, ...identity, revision: coordinator.state.revision }); },
 };
}
/** Test seam takes the exact same narrow options as the real Pi adapter. */
export async function runDecisionAgent(options: Parameters<typeof orchestrationSessionOptions>[0], run = runSession) {
 return run(orchestrationSessionOptions(options));
}
