import { guidanceBlock, type StageGuidance } from "../pipeline/guidance.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";
import type { PromptSnapshot, RenderedPrompt } from "./loader.js";

export interface SolveStartInput {
	guidance?: StageGuidance;
	taskId: string;
	configuration: TaskConfiguration;
	workspace: string;
	datasetPaths: string[];
	/** Where the development targets are, or their absence. */
	targets: string;
	rowCount: number;
	targetSummary: string;
	foldRecommendation: string;
	researchState: string;
	maxIterations: number;
}

/** The task contract for the configured kind: input frame, harness calls and scoring. */
function taskContract(prompts: PromptSnapshot, taskId: string, configuration: TaskConfiguration): RenderedPrompt[] {
	const contract = configuration.kind === "binary_classification"
		? prompts.render("solve.task-binary_classification", { taskId })
		: configuration.kind === "clustering"
			? prompts.render("solve.task-clustering", { taskId, execution: configuration.execution })
			: prompts.render("solve.task-anomaly_detection", { taskId, execution: configuration.execution,
				scoreMethod: configuration.anomaly!.scoreMethod, scoreDirection: configuration.anomaly!.scoreDirection.replaceAll("_", " "),
				anomalyLabel: String(configuration.anomaly!.anomalyLabel) });
	return configuration.metric === "none" ? [contract, prompts.render("solve.label-free", {})] : [contract];
}

/** The opening request. Workspace state does not change what is asked for. */
export function prepareSolvePrompts(prompts: PromptSnapshot, input: SolveStartInput) {
	const guidance = guidanceBlock(prompts, input.guidance);
	const system = prompts.render("solve.system", { taskId: input.taskId });
	const contract = taskContract(prompts, input.taskId, input.configuration);
	const start = prompts.render("solve.start", {
		taskId: input.taskId,
        guidance: guidance?.text ?? "",
		workspace: input.workspace,
		datasetPaths: input.datasetPaths.map((path) => `- ${path}`).join("\n"),
		targets: input.targets,
		rowCount: String(input.rowCount),
		targetSummary: input.targetSummary,
		foldRecommendation: input.foldRecommendation,
		researchState: input.researchState,
		maxIterations: String(input.maxIterations),
		taskContract: contract.map(part => part.text).join("\n\n"),
	});
	// The fit policy is a separate, explicitly selected template: it is stable
	// across tasks and iterations, while `solve.start` carries this run's data.
	const fitPolicy = prompts.render("solve.observable-fits", {});
	return {
		system,
		prompt: [start.text, fitPolicy.text].filter(Boolean).join("\n\n"),
		promptReferences: [system.reference, start.reference, ...contract.map(part => part.reference), fitPolicy.reference, ...(guidance ? [guidance.reference] : [])],
	};
}
