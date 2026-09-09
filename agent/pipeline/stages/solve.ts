/**
 * Solve stage: build a model for a task and improve it across measured iterations.
 *
 * The stage owns its artifact contract and nothing about the model. Its outcome
 * comes from what the predictions measured, never from a finished agent session:
 * a run whose canary failed or whose results could not be measured returns its
 * artifacts and a failed validation rather than throwing.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { runSolveSession } from "../../run/solve_session.js";
import { resolveLabelsFile } from "../../solve/workspace.js";
import { resolveTask } from "../resolve_task.js";
import type { StageArtifact, StageDefinition } from "../types.js";

export interface SolveOptions {
	/** Agent passes before the loop stops, whatever the evidence says. */
	maxIterations: number;
	/** Fraction of training rows sealed out of every fold for the whole run. */
	sealedFraction: number;
	/** Seed for the sealed draw. Fold seeds rotate per iteration from the run id. */
	seed: number;
	foldPolicy: "auto" | { folds: number; repeats: number };
}

function artifact(kind: string, path: string): StageArtifact | undefined {
	if (!existsSync(path)) return undefined;
	const content = readFileSync(path);
	return {
		kind,
		path,
		bytes: statSync(path).size,
		sha256: createHash("sha256").update(content).digest("hex"),
	};
}

function parseFoldPolicy(raw: unknown): SolveOptions["foldPolicy"] {
	if (raw === undefined || raw === "auto") return "auto";
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error('solve.foldPolicy must be "auto" or an object with folds and repeats');
	}
	const value = raw as Record<string, unknown>;
	const unknown = Object.keys(value).filter((key) => !["folds", "repeats"].includes(key));
	if (unknown.length > 0) throw new Error(`unknown solve.foldPolicy keys: ${unknown.join(", ")}`);
	for (const key of ["folds", "repeats"] as const) {
		if (!Number.isInteger(value[key]) || (value[key] as number) < 1) {
			throw new Error(`solve.foldPolicy.${key} must be a positive integer`);
		}
	}
	if ((value.folds as number) < 2) throw new Error("solve.foldPolicy.folds must be at least 2");
	return { folds: value.folds as number, repeats: value.repeats as number };
}

export const solveStage: StageDefinition<SolveOptions> = {
	name: "solve",
	version: 1,
	description: "Build and iteratively improve a model, judged on recomputed out-of-fold measurements",
	next: "evaluate",

	parseOptions(raw) {
		if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
			throw new Error("solve options must be an object");
		}
		const options = (raw ?? {}) as Record<string, unknown>;
		const known = new Set(["maxIterations", "sealedFraction", "seed", "foldPolicy"]);
		const unknown = Object.keys(options).filter((key) => !known.has(key));
		if (unknown.length > 0) throw new Error(`unknown solve options: ${unknown.join(", ")}`);

		const maxIterations = options.maxIterations ?? 6;
		if (!Number.isInteger(maxIterations) || (maxIterations as number) < 1) {
			throw new Error("solve.maxIterations must be a positive integer");
		}
		const sealedFraction = options.sealedFraction ?? 0.1;
		if (typeof sealedFraction !== "number" || !(sealedFraction > 0 && sealedFraction < 0.5)) {
			throw new Error("solve.sealedFraction must be a number above 0 and below 0.5");
		}
		const seed = options.seed ?? 13;
		if (!Number.isInteger(seed)) throw new Error("solve.seed must be an integer");

		return {
			maxIterations: maxIterations as number,
			sealedFraction,
			seed: seed as number,
			foldPolicy: parseFoldPolicy(options.foldPolicy),
		};
	},

	checkInput(input) {
		const task = resolveTask({ taskId: input.taskId });
		if (!task.hasData) {
			throw new Error(`Task ${task.taskId} has no local dataset; run \`npm run fetch-unit -- ${task.unitSlug}\``);
		}
		// A labels adapter and a readable labels file are what make the sealed split
		// and every recomputed score possible, so their absence is a contract failure.
		resolveLabelsFile(task.taskId, join(task.taskDir, "data"));
		const research = input.upstream.find((entry) => entry.kind === "research_document");
		if (!research || !existsSync(research.path)) {
			throw new Error(`Task ${task.taskId} has no research document upstream; run the research stage first`);
		}
	},

	async run(context) {
		const result = await runSolveSession(context.input.taskId, context.input.model, {
			maxIterations: context.options.maxIterations,
			sealedFraction: context.options.sealedFraction,
			seed: context.options.seed,
			foldPolicy: context.options.foldPolicy,
			upstream: context.input.upstream,
			prompts: context.prompts,
			report: context.report,
			signal: context.signal,
			// Fold seeds rotate from the invocation id, so two runs of the same
			// task draw different partitions and a fixed split cannot be ground down.
			runId: context.report.agentIdentity(1).stageInvocationId ?? undefined,
		});
		const artifacts = [
			artifact("solve_metrics", join(result.workspace, "metrics.json")),
			artifact("oof_predictions", join(result.workspace, "oof_predictions.csv")),
			artifact("confirmation_predictions", join(result.workspace, "confirmation_predictions.csv")),
			artifact("solve_notes", join(result.workspace, "notes.md")),
			artifact("solve_iterations", join(result.workspace, "iterations.jsonl")),
			...(result.champion ? [artifact("solve_entrypoint", join(result.champion.root, result.champion.module))] : []),
		].filter((entry): entry is StageArtifact => entry !== undefined);

		return {
			artifacts,
			validation: { valid: result.valid, errors: result.errors },
			attempts: result.iterations,
			summary: {
				iterations: result.iterations,
				stop_reason: result.stopReason,
				champion_iteration: result.champion?.iteration,
				champion_mean_bacc: result.champion?.meanBacc,
				champion_approach: result.champion?.approach,
				sealed_bacc: result.sealedBacc,
				sealed_gap: result.sealedGap,
				// A widening gap across iterations is the loop overfitting its folds.
				sealed_gap_trend: result.sealedGapTrend,
			},
		};
	},
};
