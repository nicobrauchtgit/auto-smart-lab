/**
 * Research through the pipeline executor.
 *
 * Standalone research commands use this helper instead of calling the session
 * directly, so an isolated research run produces the same identities, stage
 * lifecycle, and agent traces as a scheduled pipeline run.
 */

import { runPipeline } from "./executor.js";
import type { PipelineRunResult } from "./types.js";

export interface RunResearchStageOptions {
	taskId: string;
	model?: string;
	injectStartupContext?: boolean;
	echoEvents?: boolean;
	signal?: AbortSignal;
	invokedBy?: Record<string, unknown>;
}

export interface ResearchStageRunResult extends PipelineRunResult {
	/** Path to the validated research document, when the stage succeeded. */
	documentPath?: string;
	error?: string;
}

export async function runResearchStage(options: RunResearchStageOptions): Promise<ResearchStageRunResult> {
	const result = await runPipeline({
		taskId: options.taskId,
		model: options.model,
		entryStage: "research",
		stopAfter: "research",
		signal: options.signal,
		echoEvents: options.echoEvents,
		optionOverrides: options.injectStartupContext === undefined
			? undefined
			: { research: { injectStartupContext: options.injectStartupContext } },
		invokedBy: options.invokedBy ?? { kind: "api", command: "research" },
	});
	const research = result.invocations.find((invocation) => invocation.stage === "research");
	return {
		...result,
		documentPath: research?.artifacts.find((artifact) => artifact.kind === "research_document")?.path,
		error: research?.error,
	};
}
