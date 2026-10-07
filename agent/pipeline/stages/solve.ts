/**
 * Solve stage: build a model for a task and improve it across measured iterations.
 *
 * The stage owns its artifact contract and nothing about the model. Its outcome
 * comes from what the predictions measured, never from a finished agent session:
 * a run whose canary failed or whose results could not be measured returns its
 * artifacts and a failed validation rather than throwing.
 */

import { HARNESS_CONFIG } from "../../harness/config.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { runHarnessSolveSession } from "../../run/harness_solve_session.js";
import { resolveLabelsFile } from "../../solve/workspace.js";
import { resolveTask } from "../resolve_task.js";
import type { StageArtifact, StageDefinition } from "../types.js";
import { recordedRepository } from "../../training/development_selection.js";
import { git } from "../../training/git.js";
import type { TrainingTrialResult } from "../../training/results.js";

/**
 * The selected trial's entrypoint, hashed for provenance. The path is the
 * live file, so it is handed over only while it still matches the commit the
 * trial measured; an edited file is not the selected pipeline's code.
 */
export function entrypointArtifact(selected: TrainingTrialResult | undefined): StageArtifact | { mismatch: string } | undefined {
	const module = selected?.request?.pipeline.module;
	const repository = recordedRepository(selected);
	const commit = (selected?.invocation?.source as { commit?: string } | undefined)?.commit;
	if (!module || !repository || !commit) return undefined;
	const path = join(dirname(repository), module);
	if (!existsSync(path)) return { mismatch: `${module} no longer exists` };
	const committed = git(repository, ["rev-parse", "--verify", "--quiet", `${commit}:${relative(repository, path)}`]);
	const live = git(repository, ["hash-object", "--", path]);
	if (committed.status !== 0 || live.status !== 0 || committed.stdout.trim() !== live.stdout.trim()) {
		return { mismatch: `${module} differs from commit ${commit.slice(0, 12)}` };
	}
	const bytes = readFileSync(path);
	return { kind: "solve_entrypoint", path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export interface SolveOptions {
	/** Maximum harness trials the agent may start; it may stop earlier. */
	maxIterations: number;
	/** Fraction of training rows sealed out of every fold for the whole run. */
	sealedFraction: number;
	/** Root seed for the sealed draw and harness-owned training seed lineage. */
	seed: number;
	foldPolicy: "auto" | { folds: number; repeats: number };
	/** Minimum seconds between routine training updates sent to the agent. */
	experimentUpdateIntervalSeconds: number;
}

function parseFoldPolicy(raw: unknown): SolveOptions["foldPolicy"] {
	if (raw === undefined) return HARNESS_CONFIG.solve.foldPolicy;
	if (raw === "auto") return "auto";
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
	setupRequirements: ["knowledge", "model", "python", "task", "training"],
	version: 1,
	description: "Build and iteratively improve a model, judged on recomputed out-of-fold measurements",
	next: "evaluate",

	parseOptions(raw) {
		if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
			throw new Error("solve options must be an object");
		}
		const options = (raw ?? {}) as Record<string, unknown>;
		const known = new Set(["maxIterations", "sealedFraction", "seed", "foldPolicy", "experimentUpdateIntervalSeconds"]);
		const unknown = Object.keys(options).filter((key) => !known.has(key));
		if (unknown.length > 0) throw new Error(`unknown solve options: ${unknown.join(", ")}`);

		const maxIterations = options.maxIterations ?? HARNESS_CONFIG.solve.maxIterations;
		if (!Number.isInteger(maxIterations) || (maxIterations as number) < 1) {
			throw new Error("solve.maxIterations must be a positive integer");
		}
		const sealedFraction = options.sealedFraction ?? HARNESS_CONFIG.solve.sealedFraction;
		if (typeof sealedFraction !== "number" || !(sealedFraction > 0 && sealedFraction < 0.5)) {
			throw new Error("solve.sealedFraction must be a number above 0 and below 0.5");
		}
		const seed = options.seed ?? HARNESS_CONFIG.solve.seed;
		if (!Number.isInteger(seed)) throw new Error("solve.seed must be an integer");
		const experimentUpdateIntervalSeconds = options.experimentUpdateIntervalSeconds ?? HARNESS_CONFIG.solve.experimentUpdateIntervalSeconds;
		if (!Number.isInteger(experimentUpdateIntervalSeconds) || (experimentUpdateIntervalSeconds as number) < 1) {
			throw new Error("solve.experimentUpdateIntervalSeconds must be a positive integer");
		}

		return {
			maxIterations: maxIterations as number,
			sealedFraction,
			seed: seed as number,
			foldPolicy: parseFoldPolicy(options.foldPolicy),
			experimentUpdateIntervalSeconds: experimentUpdateIntervalSeconds as number,
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
		const result = await runHarnessSolveSession(context.input.taskId, context.input.model, {
			maxTrials: context.options.maxIterations,
			sealedFraction: context.options.sealedFraction,
			seed: context.options.seed,
			foldPolicy: context.options.foldPolicy,
			experimentUpdateIntervalSeconds: context.options.experimentUpdateIntervalSeconds,
			upstream: context.input.upstream,
			prompts: context.prompts,
 guidance: context.input.guidance, feedback: context.feedback,
			report: context.report,
			signal: context.signal,
			// Fold seeds rotate from the invocation id, so two runs of the same
			// task draw different partitions and a fixed split cannot be ground down.
			runId: context.report.agentIdentity(1).stageInvocationId ?? undefined,
		});
		const artifacts = result.collection.artifacts.map(({ kind, path, bytes, sha256 }) => ({
			kind, path, bytes, sha256,
		}));
		if (result.collection.selected) {
			const selected = result.collection.selected.artifacts.find(entry => entry.kind === "training_trial_result")!;
			artifacts.push({ kind: "training_selected_result", path: selected.path, bytes: selected.bytes, sha256: selected.sha256 });
		}
		const entrypoint = entrypointArtifact(result.collection.selected);
		if (entrypoint && "kind" in entrypoint) artifacts.push(entrypoint);

		return {
			artifacts,
			validation: { valid: result.valid, errors: result.errors },
			attempts: result.attempts,
			summary: {
				trials: result.collection.trials.length,
				eligible_trials: result.collection.trials.filter((trial) => trial.eligible).length,
				stop_reason: result.stopReason,
				selected_experiment_id: result.collection.selected?.experimentId,
				selected_balanced_accuracy: result.collection.selected?.result?.metrics?.balancedAccuracy,
				session_error: result.sessionError,
				...(entrypoint && "mismatch" in entrypoint ? { entrypoint_mismatch: entrypoint.mismatch } : {}),
				trial_validation_errors: result.collection.errors,
			},
		};
	},
};
