/**
 * Solve through the pipeline executor.
 *
 * Standalone solve commands use this rather than calling the session directly, so
 * an isolated run produces the same identities, stage lifecycle, and agent traces
 * as a scheduled pipeline run.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { runPipeline } from "./executor.js";
import { PROJECT_ROOT } from "./resolve_task.js";
import type { PipelineRunResult, StageArtifact } from "./types.js";

export interface RunSolveStageOptions {
	taskId: string;
	model?: string;
	maxIterations?: number;
	echoEvents?: boolean;
	signal?: AbortSignal;
	invokedBy?: Record<string, unknown>;
	/**
	 * Enter at solve using the research document already on disk instead of
	 * re-running research. The artifact is seeded, so the trace shows solve as the
	 * only stage this run executed.
	 */
	useExistingResearch?: boolean;
}

/** The research stage's own output location, used when seeding a solve-only run. */
export function existingResearchArtifact(taskId: string): StageArtifact {
	const path = join(PROJECT_ROOT, "runs", taskId, "research", "research.md");
	if (!existsSync(path)) {
		throw new Error(`No research document at ${path}; run \`npm run research -- ${taskId}\` first`);
	}
	return {
		kind: "research_document",
		path,
		bytes: statSync(path).size,
		sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
	};
}

export interface SolveStageRunResult extends PipelineRunResult {
	/** Path to metrics.json when the stage produced a measured champion. */
	metricsPath?: string;
	error?: string;
}

/**
 * Solve needs the research document as an upstream artifact, so the run enters at
 * research and stops after solve rather than starting mid-chain with nothing
 * upstream.
 */
export async function runSolveStage(options: RunSolveStageOptions): Promise<SolveStageRunResult> {
	const seeded = options.useExistingResearch ? [existingResearchArtifact(options.taskId)] : undefined;
	const result = await runPipeline({
		taskId: options.taskId,
		model: options.model,
		entryStage: seeded ? "solve" : "research",
		stopAfter: "solve",
		signal: options.signal,
		echoEvents: options.echoEvents,
		seedArtifacts: seeded,
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
