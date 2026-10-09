import { basename, dirname, join, resolve } from "node:path";
import { readPythonEnvironment } from "../../run/python_environment.js";
import { runRefit, type RefitOptions } from "../../refit/service.js";
import { PROJECT_ROOT, resolveTask } from "../resolve_task.js";
import { stageConfiguration, taskDataPaths, type TaskConfiguration } from "../task_configuration.js";
import type { StageDefinition } from "../types.js";
export { originalRefitData } from "../../refit/service.js";
export interface RefitStageOptions { trainingRoot?: string }
/** Original task data for the terminal fit, named by the task configuration. */
export function refitInputs(taskId: string, configuration: TaskConfiguration, trainingRoot?: string): RefitOptions {
 const paths = taskDataPaths(taskId, configuration);
 const environment = readPythonEnvironment();
 const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
 return { taskId, trainingRoot, projectRoot: PROJECT_ROOT, solutionsRoot: join(PROJECT_ROOT, "solutions"), pythonExecutable: environment.executable,
  environmentFingerprint: environment.fingerprint, env, taskConfiguration: configuration,
  ...(paths.targetsPath ? { labelsPath: paths.targetsPath } : {}), trainZip: paths.trainZip, testZip: paths.testZip };
}
export const refitStage: StageDefinition<RefitStageOptions> = {
 name: "refit", version: 1, setupRequirements: ["observability", "python", "task", "refit"],
 description: "Freeze the authoritative champion and repeat its measured fit on the original data for final test predictions",
 parseOptions(raw) {
  if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) throw new Error("refit options must be an object");
  const options = (raw ?? {}) as Record<string, unknown>;
  if (Object.keys(options).some(k => k !== "trainingRoot")) throw new Error("unknown refit options");
  if (options.trainingRoot !== undefined && (typeof options.trainingRoot !== "string" || !options.trainingRoot.trim())) throw new Error("refit.trainingRoot must be a non-empty path");
  return options.trainingRoot ? { trainingRoot: resolve(options.trainingRoot as string) } : {};
 },
 checkInput(input) { resolveTask({ taskId: input.taskId }); },
 async run(context) {
  const selected = context.input.upstream.filter(a => a.kind === "training_selected_result");
  if (selected.length > 1) throw new Error("Ambiguous controller-selected refit evidence");
  const options = { ...refitInputs(context.input.taskId, stageConfiguration(context.input), context.options.trainingRoot), signal: context.signal, report: context.report,
   ...(selected.length ? { expectedExperimentId: basename(dirname(selected[0].path)) } : {}) };
  // Upstream evidence is resolved from the champion tag, not score-sorted artifacts.
  try { return await runRefit(options); }
  catch (error) { context.signal.throwIfAborted(); return { artifacts: [], validation: { valid: false, errors: [error instanceof Error ? error.message : String(error)] } }; }
 },
};
