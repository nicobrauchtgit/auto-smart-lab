/** A solve-session scope for harness-owned training. */

import { createExperiments, type Wakeable } from "../experiments/index.js";
import type { SupervisorOptions } from "../experiments/supervisor.js";
import type { PromptSnapshot } from "../prompts/loader.js";
import { sanitizeTrainingEnvironment } from "./environment.js";
import { TrainingService, type TrainingServiceOptions } from "./service.js";
import { createHarnessTrainingTools } from "./tools.js";

export { ExperimentRequestError, parseExperimentRequest, validateExperimentRequest } from "./contract.js";
export { createGitHistoryGuard, classifyCommand, gitHistoryBlock } from "./git_guard.js";
export { ensureSolutionsRepository } from "./git.js";
export { sanitizeTrainingEnvironment } from "./environment.js";
export { TrainingService } from "./service.js";
export * from "./results.js";
export * from "./seeds.js";
export type * from "./types.js";

export interface HarnessTrainingOptions extends Omit<SupervisorOptions, "deliver" | "onFinished">,
	Omit<TrainingServiceOptions, "supervisor" | "trainingRoot" | "env" | "record" | "caveats" | "runtimeGuidance"> {
	prompts: PromptSnapshot;
	session?: Wakeable;
	signal?: AbortSignal;
}

export function createHarnessTraining(options: HarnessTrainingOptions) {
	const env = sanitizeTrainingEnvironment(options.env, {
		pipelineRunId: options.pipelineRunId,
		stageInvocationId: options.stageInvocationId,
	});
	// The supervisor exists before the service; finalization binds late.
	let service: TrainingService | undefined;
	const processScope = createExperiments({
		root: options.root,
		env,
		onFinished: (id) => service?.workerFinished(id),
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
	service = new TrainingService({
		supervisor: processScope.supervisor,
		pythonExecutable: options.pythonExecutable,
		projectRoot: options.projectRoot,
		trainingRoot: options.root,
        recoveryRoots: options.recoveryRoots,
        environmentFingerprint: options.environmentFingerprint,
        pipelineRunId: options.pipelineRunId,
        stageInvocationId: options.stageInvocationId,
		taskId: options.taskId,
		datasetSha256: options.datasetSha256,
		rootSeed: options.rootSeed,
		zipPath: options.zipPath,
		labelsPath: options.labelsPath,
		measurement: options.measurement,
		allowedModuleRoots: options.allowedModuleRoots,
		maxExperiments: options.maxExperiments,
		solutionsRoot: options.solutionsRoot,
		env,
		validatePipeline: options.validatePipeline,
		search: options.search,
		runtimeGuidance: options.prompts.render("training.runtime-guard", {}).text,
		caveats: options.prompts.render("training.search-caveats", {}).text
			.split("\n").map((line) => line.replace(/^-\s*/, "").trim()).filter(Boolean),
		onTrialStarted: options.onTrialStarted,
		record: options.record,
		workerPath: options.workerPath,
	});
	const tools = createHarnessTrainingTools(service, processScope.supervisor, options.prompts);
	const toolPrompts = (["training.start-tool", "training.status-tool", "training.output-tool", "training.stop-tool",
		"training.search-caveats", "training.runtime-guard", "training.resume-tool"] as const)
		.map((id) => options.prompts.render(id, {}).reference);
	const trainingService = service;
	return {
		service: trainingService,
        ready: () => trainingService.ready(),
		supervisor: processScope.supervisor,
		tools,
		toolPrompts,
		bindSession: processScope.bindSession,
		close: async () => {
			// Mark closure before stop callbacks can attempt recovery.
            trainingService.markClosing();
            await processScope.close();
			await trainingService.close();
		},
	};
}
