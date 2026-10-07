import { resolveTask, type TaskSelector } from "./pipeline/resolve_task.js";
import { runOrchestrator } from "./orchestrator/run.js";
export function parseOrchestrateArgs(args: string[]) {
 const selector: TaskSelector = {};
 const options: { targetScore?: number; maxSubmissions?: number; noSubmit?: boolean; checkSetupOnly?: boolean; model?: string; configPath?: string; resumeRunId?: string } = {};
 const positional: string[] = [];
 for (let i = 0; i < args.length; i++) {
  const arg = args[i], value = () => { const next = args[++i]; if (!next || next.startsWith("--")) throw new Error(`Missing value for ${arg}`); return next; };
  if (arg === "unit" || arg === "u") selector.unit = value();
  else if (arg === "task" || arg === "t") selector.task = value();
  else if (arg === "--goal") options.targetScore = Number(value());
  else if (arg === "--max-submissions") options.maxSubmissions = Number(value());
  else if (arg === "--no-submit") options.noSubmit = true;
  else if (arg === "--check-setup") options.checkSetupOnly = true;
  else if (arg === "--model") options.model = value();
  else if (arg === "--config") options.configPath = value();
  else if (arg === "--resume") options.resumeRunId = value();
  else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}`);
  else positional.push(arg);
 }
 if (positional.length === 1 && !selector.unit && !selector.task) selector.taskId = positional[0];
 else if (positional.length === 2 && !selector.unit && !selector.task) [selector.unit, selector.task] = positional;
 else if (positional.length) throw new Error("Use unit <unit> task <task> or one canonical task ID");
 if (!selector.taskId && !(selector.unit && selector.task)) throw new Error("Usage: npm run orchestrate -- unit 1 task 1 [--goal 1] [--no-submit] [--check-setup] [--resume <run-id>]");
 if (options.targetScore !== undefined && (!Number.isFinite(options.targetScore) || options.targetScore < 0 || options.targetScore > 1)) throw new Error("Goal must be in [0,1]");
 if (options.maxSubmissions !== undefined && (!Number.isInteger(options.maxSubmissions) || options.maxSubmissions < 0 || options.maxSubmissions > 3)) throw new Error("Submission cap must be in [0,3]");
 return { selector, options };
}
export async function main(args = process.argv.slice(2)) {
 const parsed = parseOrchestrateArgs(args), task = resolveTask(parsed.selector);
 const controller = new AbortController(), cancel = () => controller.abort();
 process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
 try {
  const result = await runOrchestrator({ ...parsed.options, taskId: task.taskId, signal: controller.signal });
  console.log(`[orchestrator] ${result.pipelineRunId}: ${result.outcome} — ${result.stoppedBecause}`);
  console.log(`[orchestrator] Trace: ${result.localTracePath}`);
  if (result.outcome !== "success") process.exitCode = 1;
 } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
}
if (import.meta.main) main().catch(error => { console.error(`[orchestrator] ${error instanceof Error ? error.message : "Run failed"}`); process.exitCode = 1; });
