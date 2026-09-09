import type { PromptSnapshot } from "./loader.js";

export interface SolveStartInput {
	taskId: string;
	workspace: string;
	datasetPaths: string[];
	labelsPath: string;
	rowCount: number;
	classBalance: string;
	foldRecommendation: string;
	researchState: string;
	maxIterations: number;
}

/** The opening request. Workspace state does not change what is asked for. */
export function prepareSolvePrompts(prompts: PromptSnapshot, input: SolveStartInput) {
	const system = prompts.render("solve.system", { taskId: input.taskId });
	const start = prompts.render("solve.start", {
		taskId: input.taskId,
		workspace: input.workspace,
		datasetPaths: input.datasetPaths.map((path) => `- ${path}`).join("\n"),
		labelsPath: input.labelsPath,
		rowCount: String(input.rowCount),
		classBalance: input.classBalance,
		foldRecommendation: input.foldRecommendation,
		researchState: input.researchState,
		maxIterations: String(input.maxIterations),
	});
	return {
		system,
		prompt: start.text,
		promptReferences: [system.reference, start.reference],
	};
}

/**
 * The follow-up request. `signal` is rendered from recomputed measurements; the
 * guidance line states what to do next without suggesting what to try.
 */
export function prepareIterationPrompt(
	prompts: PromptSnapshot,
	input: { signal: string; guidance: string },
) {
	return prompts.render("solve.iteration", input);
}
