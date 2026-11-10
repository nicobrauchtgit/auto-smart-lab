import { runPipeline } from "./executor.js";
/** Standalone terminal refit uses the shared instrumented executor and preflight. */
export function runRefitStage(options: { telemetry?: import("./executor.js").RunPipelineOptions["telemetry"]; taskId: string; trainingRoot?: string; checkSetupOnly?: boolean; signal?: AbortSignal; echoEvents?: boolean; configPath?: string; runsDir?: string }) {
 return runPipeline({ telemetry: options.telemetry, configPath: options.configPath, runsDir: options.runsDir, taskId: options.taskId, entryStage: "refit", stopAfter: "refit", checkSetupOnly: options.checkSetupOnly,
  signal: options.signal, echoEvents: options.echoEvents, optionOverrides: options.trainingRoot === undefined ? undefined : { refit: { trainingRoot: options.trainingRoot } },
  invokedBy: { kind: "api", command: "refit-stage" } });
}
