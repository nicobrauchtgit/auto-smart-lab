import { basename, dirname, join, resolve } from "node:path";
import { readPythonEnvironment } from "../../run/python_environment.js";
import { resolveLabelsFile } from "../../solve/workspace.js";
import { runRefit, type RefitOptions } from "../../refit/service.js";
import { resolveCppRuntimeLibraryPath } from "../../training/environment.js";
import { PROJECT_ROOT, resolveTask } from "../resolve_task.js";
import type { StageDefinition } from "../types.js";
export interface RefitStageOptions { trainingRoot?: string }
export function refitInputs(taskId: string, trainingRoot?: string): RefitOptions {
 const task = resolveTask({ taskId });
 const labelsPath = resolveLabelsFile(taskId, join(task.taskDir, "data"));
 const environment = readPythonEnvironment();
 const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
 const runtime = resolveCppRuntimeLibraryPath(env);
 if (runtime) env.LD_LIBRARY_PATH = runtime;
 return { taskId, trainingRoot, projectRoot: PROJECT_ROOT, solutionsRoot: join(PROJECT_ROOT, "solutions"), pythonExecutable: environment.executable,
  environmentFingerprint: environment.fingerprint, env, labelsPath,
  trainZip: join(task.taskDir, "data", basename(labelsPath).replace(/-train\.labels$/, "-train.zip")),
  testZip: join(task.taskDir, "data", basename(labelsPath).replace(/-train\.labels$/, "-test.zip")) };
}
export const refitStage: StageDefinition<RefitStageOptions> = {
 name: "refit", version: 1, setupRequirements: ["python", "task", "refit"],
 description: "Freeze the authoritative champion and refit all labelled rows for final test predictions",
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
  const options = { ...refitInputs(context.input.taskId, context.options.trainingRoot), signal: context.signal, report: context.report,
   ...(selected.length ? { expectedExperimentId: basename(dirname(selected[0].path)) } : {}) };
  // Upstream evidence is resolved from the champion tag, not score-sorted artifacts.
  try { return await runRefit(options); }
  catch (error) { context.signal.throwIfAborted(); return { artifacts: [], validation: { valid: false, errors: [error instanceof Error ? error.message : String(error)] } }; }
 },
};
