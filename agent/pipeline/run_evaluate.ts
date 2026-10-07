import type { RunPipelineOptions } from "./executor.js";
import { join } from "node:path";
import { artifact } from "../evaluation/evidence.js";
import { collectTrainingResults } from "../training/results.js";
import { runPipeline } from "./executor.js";

/** Standalone review uses the same preflight, execution and observation path. */
export async function runEvaluateStage(options: {
 guidance?: RunPipelineOptions["guidance"]; evidenceCatalog?: RunPipelineOptions["evidenceCatalog"];
 taskId: string; trainingRoot: string; model?: string; checkSetupOnly?: boolean;
 signal?: AbortSignal; echoEvents?: boolean;
}) {
 const collection = await collectTrainingResults(options.trainingRoot);
 if (!collection.selected) throw new Error("No valid completed promotion in the supplied training root");
 return runPipeline({ guidance: options.guidance, evidenceCatalog: options.evidenceCatalog, taskId: options.taskId, entryStage: "evaluate", stopAfter: "evaluate",
  model: options.model, checkSetupOnly: options.checkSetupOnly, signal: options.signal, echoEvents: options.echoEvents,
  seedArtifacts: [...collection.artifacts, artifact("training_selected_result", join(collection.selected.directory, "trial-result.json"))],
  invokedBy: { kind: "api", command: "evaluate-stage", trainingRoot: options.trainingRoot } });
}
