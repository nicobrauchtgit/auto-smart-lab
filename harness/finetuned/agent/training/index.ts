/** A solve-session scope for harness-owned training. */

import { createExperiments, type ExperimentView, type Wakeable } from "../experiments/index.js";
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
	/**
	 * Called after a finished worker is finalized (champion tagging done), so
	 * the owner can tell its agent the result. Not called when the worker was
	 * recovered and runs again. Terminal discovery replays this callback once
	 * per owner; owners persist their feedback receipt for restart deduplication.
	 */
	onTrialFinished?: (id: string, view: ExperimentView) => void | Promise<void>;
	/** False when `onTrialFinished` sends the owner's own message; see createExperiments. */
	deliverExits?: boolean;
}

export function createHarnessTraining(options: HarnessTrainingOptions) {
 let service: TrainingService | undefined;
 const finished = new Set<string>();
 const notifyFinished = async (id: string, view: ExperimentView) => {
  const result = service?.describe(id);
  const key = JSON.stringify([id, view.status, result?.status, result?.completedFolds, result?.requestedFolds]);
  if (finished.has(key)) return;
  finished.add(key);
  try { await options.onTrialFinished?.(id, view); }
  catch (error) { finished.delete(key); throw error; }
 };
	const env = sanitizeTrainingEnvironment(options.env, {
		pipelineRunId: options.pipelineRunId,
		stageInvocationId: options.stageInvocationId,
	});
	// The supervisor exists before the service; finalization binds late.
	const processScope = createExperiments({
		root: options.root,
		env,
		onFinished: async (id, view) => {
			service?.recordDuration(id, view);
			await service?.workerFinished(id);
			// A recovered worker runs again; it reports when that run ends.
			if (processScope.supervisor.status(id).status === "running") return;
			await notifyFinished(id, view);
		},
		deliverExits: options.deliverExits,
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
		sandboxCommand: options.sandboxCommand,
		executionBoundaryFingerprint: options.executionBoundaryFingerprint,
		lockPath: options.lockPath,
		prompts: options.prompts,
	});
	const tools = createHarnessTrainingTools(service, processScope.supervisor, options.prompts);
	const toolPrompts = ([service.taskKind ? `training.start-${service.taskKind}` as const : "training.start-tool", "training.smoke-tool", "training.workspace-check-tool", "training.status-tool", "training.output-tool", "training.stop-tool",
		"training.search-caveats", "training.runtime-guard", "training.resume-tool"] as const)
		.map((id) => options.prompts.render(id, {}).reference);
	const trainingService = service;
	return {
		service: trainingService,
        ready: async () => {
   await trainingService.ready();
   // Discovery finalizes terminal workers without a new process exit event.
   // Replay their finalized state to the owner, once per service instance.
   for (const view of processScope.supervisor.list()) {
    if (view.status === "running") continue;
    await trainingService.finalize(view.id);
    await notifyFinished(view.id, view);
   }
  },
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
