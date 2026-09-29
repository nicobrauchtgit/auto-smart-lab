/** A solve-session scope for harness-owned training. */

import { createExperiments, type Wakeable } from "../experiments/index.js";
import type { SupervisorOptions } from "../experiments/supervisor.js";
import type { PromptSnapshot } from "../prompts/loader.js";
import { sanitizeTrainingEnvironment } from "./environment.js";
import { TrainingService, type TrainingServiceOptions } from "./service.js";
import { createHarnessTrainingTools } from "./tools.js";

export { parseExperimentRequest } from "./contract.js";
export { resolveCppRuntimeLibraryPath, sanitizeTrainingEnvironment } from "./environment.js";
export { TrainingService } from "./service.js";
export * from "./results.js";
export * from "./seeds.js";
export type * from "./types.js";

export interface HarnessTrainingOptions extends Omit<SupervisorOptions, "deliver">,
	Omit<TrainingServiceOptions, "supervisor" | "trainingRoot"> {
	prompts: PromptSnapshot;
	session?: Wakeable;
	signal?: AbortSignal;
}

export function createHarnessTraining(options: HarnessTrainingOptions) {
	const processScope = createExperiments({
		root: options.root,
		env: sanitizeTrainingEnvironment(options.env, {
			pipelineRunId: options.pipelineRunId,
			stageInvocationId: options.stageInvocationId,
		}),
		record: options.record,
		limits: options.limits,
		environmentFingerprint: options.environmentFingerprint,
		pipelineRunId: options.pipelineRunId,
		stageInvocationId: options.stageInvocationId,
		memoryCeilingBytes: options.memoryCeilingBytes,
		prompts: options.prompts,
		session: options.session,
		signal: options.signal,
	});
	const service = new TrainingService({
		supervisor: processScope.supervisor,
		pythonExecutable: options.pythonExecutable,
		projectRoot: options.projectRoot,
		trainingRoot: options.root,
		taskId: options.taskId,
		datasetSha256: options.datasetSha256,
		rootSeed: options.rootSeed,
		zipPath: options.zipPath,
		labelsPath: options.labelsPath,
		allowedModuleRoots: options.allowedModuleRoots,
		maxExperiments: options.maxExperiments,
	});
	const tools = createHarnessTrainingTools(service, processScope.supervisor, options.prompts);
	const toolPrompts = (["training.start-tool", "training.status-tool", "training.output-tool", "training.stop-tool"] as const)
		.map((id) => options.prompts.render(id, {}).reference);
	return {
		service,
		supervisor: processScope.supervisor,
		tools,
		toolPrompts,
		bindSession: processScope.bindSession,
		close: processScope.close,
	};
}
