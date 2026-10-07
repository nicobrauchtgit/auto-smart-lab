import { runPipeline } from "./executor.js";
/** Standalone terminal refit uses the shared instrumented executor and preflight. */
export function runRefitStage(options: { taskId: string; trainingRoot?: string; checkSetupOnly?: boolean; signal?: AbortSignal; echoEvents?: boolean; configPath?: string; runsDir?: string }) {
 return runPipeline({ configPath: options.configPath, runsDir: options.runsDir, taskId: options.taskId, entryStage: "refit", stopAfter: "refit", checkSetupOnly: options.checkSetupOnly,
  signal: options.signal, echoEvents: options.echoEvents, optionOverrides: options.trainingRoot === undefined ? undefined : { refit: { trainingRoot: options.trainingRoot } },
  invokedBy: { kind: "api", command: "refit-stage" } });
}
