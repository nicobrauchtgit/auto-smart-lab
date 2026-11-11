import type { RunPipelineOptions } from "./executor.js";
/**
 * Solve through the pipeline executor.
 *
 * Standalone solve commands use this rather than calling the session directly, so
 * an isolated run produces the same identities, stage lifecycle, and agent traces
 * as a scheduled pipeline run.
 */

import { runPipeline } from "./executor.js";
import type { PipelineRunResult } from "./types.js";

export interface RunSolveStageOptions {
	telemetry?: RunPipelineOptions["telemetry"];
 guidance?: RunPipelineOptions["guidance"]; evidenceCatalog?: RunPipelineOptions["evidenceCatalog"];
	taskId: string;
	model?: string;
	maxIterations?: number;
	echoEvents?: boolean;
	signal?: AbortSignal;
	invokedBy?: Record<string, unknown>;
}

export interface SolveStageRunResult extends PipelineRunResult {
	/** Path to metrics.json when the stage produced a measured champion. */
	metricsPath?: string;
	error?: string;
}

export async function runSolveStage(options: RunSolveStageOptions): Promise<SolveStageRunResult> {
	const result = await runPipeline({
		telemetry: options.telemetry, guidance: options.guidance, evidenceCatalog: options.evidenceCatalog,
		taskId: options.taskId,
		model: options.model,
		entryStage: "solve",
		stopAfter: "solve",
		signal: options.signal,
		echoEvents: options.echoEvents,
		optionOverrides: options.maxIterations === undefined
			? undefined
			: { solve: { maxIterations: options.maxIterations } },
		invokedBy: options.invokedBy ?? { kind: "api", command: "solve-stage" },
	});
	const solve = result.invocations.find((invocation) => invocation.stage === "solve");
	return {
		...result,
		metricsPath: solve?.artifacts.find((artifact) => artifact.kind === "solve_metrics")?.path,
		error: solve?.error,
	};
}
