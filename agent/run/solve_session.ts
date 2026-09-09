/**
 * Solve session: build a model, train it under cross-validation, and improve it
 * across iterations against measured signals.
 *
 * The agent owns the implementation entirely. This runner prepares inputs, runs
 * the agent, has `agent/solve/iteration.py` measure what the predictions actually
 * say, and feeds that back. Promotion follows the evidence rather than the
 * headline score: a challenger replaces the champion only when its paired delta
 * clears its own uncertainty interval, so the loop cannot chase fold noise.
 */

import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

import { iterationSeed } from "../solve/folds.js";
import { evaluateIteration, renderIterationSignal, type IterationSignal } from "../solve/results.js";
import { prepareSolveWorkspace, type SolveWorkspace } from "../solve/workspace.js";
import { PROJECT_ROOT } from "../pipeline/resolve_task.js";
import type { StageArtifact, StageReporter } from "../pipeline/types.js";
import { loadPromptSnapshot, type PromptSnapshot } from "../prompts/loader.js";
import { prepareIterationPrompt, prepareSolvePrompts } from "../prompts/solve.js";
import { readPythonEnvironment } from "./python_environment.js";
import { runSession, SESSION_TIMEOUT_MS } from "./session_runner.js";

export type StopReason = "agent_declared" | "no_measurable_gain" | "budget" | "cancelled" | "never_measured";

export interface Champion {
	iteration: number;
	meanBacc: number;
	approach: string;
	module: string;
	factory: string;
	/** Snapshot root the champion is re-run from, so later edits cannot change it. */
	root: string;
}

export interface SolveResult {
	workspace: string;
	valid: boolean;
	errors: string[];
	iterations: number;
	stopReason: StopReason;
	champion?: Champion;
	sealedBacc?: number;
	sealedGap?: number;
	sealedGapTrend?: number[];
}

export interface RunSolveOptions {
	maxIterations?: number;
	sealedFraction?: number;
	seed?: number;
	foldPolicy?: "auto" | { folds: number; repeats: number };
	upstream?: StageArtifact[];
	prompts?: PromptSnapshot;
	report?: StageReporter;
	signal?: AbortSignal;
	/** Identity the rotating fold seed is derived from. */
	runId?: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export interface IterationDecision {
	promote: boolean;
	flatIterations: number;
	stop?: StopReason;
}

/**
 * Whether this iteration becomes the champion and whether the loop continues.
 *
 * Promotion follows the paired evidence, not the headline score. Taking the
 * highest cross-validation number instead would be exactly the behaviour the
 * rotating seed and the paired interval exist to prevent: at a high score most
 * apparent gains are fold noise, and a loop that chases them drifts away from
 * its own estimate while appearing to improve.
 */
export function decideIteration(input: {
	signal: IterationSignal;
	hasChampion: boolean;
	flatIterations: number;
	iteration: number;
	maxIterations: number;
}): IterationDecision {
	const { signal, hasChampion } = input;
	const atBudget = input.iteration >= input.maxIterations;
	if (!signal.ok) {
		// An unmeasurable iteration says nothing about the model, so it neither
		// promotes nor counts towards the no-progress streak.
		return { promote: false, flatIterations: input.flatIterations, stop: atBudget ? "budget" : undefined };
	}
	const canaryPassed = signal.canary?.passed === true;
	const paired = signal.paired?.available === true ? signal.paired : undefined;
	const clears = paired ? paired.clears_zero === true && (paired.delta ?? 0) > 0 : true;
	const promote = canaryPassed && (!hasChampion || clears);
	const flatIterations = paired ? (clears ? 0 : input.flatIterations + 1) : input.flatIterations;

	let stop: StopReason | undefined;
	if (signal.reported?.done === true) stop = "agent_declared";
	else if (flatIterations >= 2) stop = "no_measurable_gain";
	else if (atBudget) stop = "budget";
	return { promote, flatIterations, stop };
}

export async function runSolveSession(
	taskId: string,
	model?: string,
	options: RunSolveOptions = {},
): Promise<SolveResult> {
	const maxIterations = options.maxIterations ?? 6;
	const report = options.report;
	const prompts = options.prompts ?? loadPromptSnapshot();
	const runId = options.runId ?? crypto.randomUUID();

	const workspace = prepareSolveWorkspace(taskId, {
		sealedFraction: options.sealedFraction,
		seed: options.seed,
		upstream: options.upstream,
	});
	const shape = options.foldPolicy && options.foldPolicy !== "auto"
		? options.foldPolicy
		: { folds: workspace.recommendation.folds, repeats: workspace.recommendation.repeats };

	console.log(`[solve] Workspace: ${workspace.root}`);
	console.log(`[solve] ${workspace.rowCount} development rows, ${workspace.split.sealedIds.length} sealed; suggested ${shape.folds}-fold x ${shape.repeats}`);
	if (workspace.archivedPrevious) console.log(`[solve] previous run's outputs moved to ${workspace.archivedPrevious}`);

	reportInputs(report, workspace, shape, maxIterations);
	report?.event("solve_workspace_prepared", {
		workspace: workspace.root,
		solutions_root: relative(PROJECT_ROOT, workspace.solutionsRoot),
		development_rows: workspace.rowCount,
		sealed_rows: workspace.split.sealedIds.length,
		sealed_sha256: workspace.split.sha256,
		fold_recommendation: shape,
		archived_previous: workspace.archivedPrevious,
	});

	const python = readPythonEnvironment();
	const opening = prepareSolvePrompts(prompts, {
		taskId,
		workspace: workspace.root,
		datasetPaths: workspace.datasetPaths,
		labelsPath: workspace.devLabelsPath,
		rowCount: workspace.rowCount,
		classBalance: workspace.classBalance,
		foldRecommendation: `${shape.folds}-fold stratified, ${shape.repeats} repeat(s)`,
		researchState: workspace.researchState,
		maxIterations,
	});

	let champion: Champion | undefined;
	let flatIterations = 0;
	let iterations = 0;
	let stopReason: StopReason = "budget";
	let latest: IterationSignal | undefined;
	const sealedGapTrend: number[] = [];
	let nextPrompt = opening.prompt;
	let promptReferences = opening.promptReferences;

	while (iterations < maxIterations) {
		if (options.signal?.aborted) { stopReason = "cancelled"; break; }
		iterations++;
		const seed = iterationSeed(runId, iterations);

		report?.event("agent_attempt_start", {
			attempt: iterations,
			reason: iterations === 1 ? "initial" : "iteration",
			model: model ?? "pipeline-default",
			fold_seed: seed,
			prompt_snapshot_sha256: prompts.fingerprint,
			prompts: promptReferences,
		});

		let sessionError: string | undefined;
		try {
			const { output, agentRunId } = await runSession({
				prompts,
				system: opening.system,
				prompt: nextPrompt,
				promptReferences,
				reportInput: report ? (input) => report.input(input) : undefined,
				model,
				cwd: PROJECT_ROOT,
				// No PYTHONPATH: smartlab_eval is an installed distribution, so the
				// stage no longer hands the agent a path into the harness tree.
				env: { SOLVE_WORKSPACE: workspace.root, SOLVE_FOLD_SEED: String(seed) },
				tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
				extensionPaths: [],
				...(options.signal ? { signal: options.signal } : {}),
				...(report ? { observe: report.observation(iterations) } : {}),
			});
			report?.event("agent_attempt_end", {
				attempt: iterations,
				agent_run_id: agentRunId,
				output_received: output.trim().length > 0,
			});
		} catch (error) {
			// A session that fails after writing usable artifacts is still worth
			// measuring; the measurement decides, not the session's exit state.
			sessionError = error instanceof Error ? error.message : String(error);
			report?.event("agent_attempt_error", { attempt: iterations, message: sessionError });
		}

		const signal = await evaluateIteration({
			workspace: workspace.root,
			labelsPath: workspace.fullLabelsPath,
			sealedPath: workspace.sealedPath,
			zipPath: workspace.trainZip,
			pythonExecutable: python.executable,
			seed,
			folds: shape.folds,
			sessionSeconds: SESSION_TIMEOUT_MS / 1000,
			entrypointModule: relative(PROJECT_ROOT, workspace.entrypointPath),
			champion: champion ? { module: champion.module, factory: champion.factory, root: champion.root } : undefined,
			...(options.signal ? { signal: options.signal } : {}),
		});
		latest = signal;

		const decision = decideIteration({
			signal, hasChampion: champion !== undefined, flatIterations,
			iteration: iterations, maxIterations,
		});
		flatIterations = decision.flatIterations;
		if (decision.promote) {
			champion = snapshotChampion(workspace, signal, iterations);
			report?.event("champion_promoted", {
				attempt: iterations,
				mean_bacc: signal.recomputed!.mean_bacc,
				delta: signal.paired?.delta,
				snapshot: relative(PROJECT_ROOT, champion.root),
			});
		}
		if (signal.ok && signal.sealed) sealedGapTrend.push(signal.sealed.gap);
		const promoted = decision.promote;

		recordIteration(workspace, {
			run_id: runId,
			iteration: iterations,
			seed,
			ok: signal.ok,
			errors: signal.errors,
			promoted,
			session_error: sessionError,
			mean_bacc: signal.recomputed?.mean_bacc,
			pooled_bacc: signal.recomputed?.pooled_bacc,
			fold_low: signal.recomputed?.fold_low,
			fold_high: signal.recomputed?.fold_high,
			roc_auc: signal.roc_auc,
			estimated_cv_seconds: signal.cost?.estimated_cv_seconds,
			seconds_per_1000_rows: signal.cost?.seconds_per_1000_rows,
			sealed_bacc: signal.sealed?.bacc,
			sealed_gap: signal.sealed?.gap,
			canary_passed: signal.canary?.passed,
			delta: signal.paired?.delta,
			delta_low: signal.paired?.low,
			delta_high: signal.paired?.high,
			clears_zero: signal.paired?.clears_zero,
			corrected: signal.paired?.corrected,
			introduced: signal.paired?.introduced,
			approach: signal.reported?.approach,
			variants_compared: signal.reported?.variants_compared,
		});
		report?.event("solve_iteration", {
			attempt: iterations,
			fold_seed: seed,
			ok: signal.ok,
			errors: signal.errors,
			promoted,
			recomputed: signal.recomputed
				? { mean_bacc: signal.recomputed.mean_bacc, pooled_bacc: signal.recomputed.pooled_bacc,
					fold_low: signal.recomputed.fold_low, fold_high: signal.recomputed.fold_high }
				: undefined,
			discrepancies: signal.discrepancies,
			sealed: signal.sealed,
			paired: signal.paired,
			roc_auc: signal.roc_auc,
			cost: signal.cost,
		});
		if (signal.canary) report?.event("leakage_canary", { attempt: iterations, ...signal.canary });

		if (decision.stop) { stopReason = decision.stop; break; }

		const rendered = renderIterationSignal(signal, {
			iteration: iterations,
			maxIterations,
			seed,
			// The sealed score is a measurement of the run, revealed once the loop
			// can no longer optimise against it.
			revealSealed: iterations + 1 === maxIterations,
			isChampion: promoted,
		});
		const next = prepareIterationPrompt(prompts, { signal: rendered, guidance: guidanceFor(signal, iterations + 1, maxIterations) });
		nextPrompt = next.text;
		promptReferences = [opening.system.reference, next.reference];
	}

	if (!champion && stopReason === "budget") stopReason = "never_measured";

	const errors = champion
		? []
		: [latest?.ok === false
			? `no measurable iteration: ${latest.errors.join("; ")}`
			: "no iteration produced a champion with a passing leakage canary"];

	report?.event("solve_finished", {
		iterations,
		stop_reason: stopReason,
		champion: champion ? { iteration: champion.iteration, mean_bacc: champion.meanBacc, approach: champion.approach } : undefined,
		sealed_gap_trend: sealedGapTrend,
		valid: champion !== undefined,
		errors,
	});

	return {
		workspace: workspace.root,
		valid: champion !== undefined,
		errors,
		iterations,
		stopReason,
		champion,
		sealedBacc: latest?.sealed?.bacc,
		sealedGap: latest?.sealed?.gap,
		sealedGapTrend,
	};
}

/** One remedy per canary failure the harness can attribute to the agent's code. */
const CANARY_REMEDIES: Record<string, string> = {
	id_dependence: "Remove whatever reads the id, then rerun.",
	entrypoint_failed: "Correct the entrypoint declared in metrics.json so the harness can load it, then rerun.",
	fit_failed: "Make the factory return an estimator that fits an id/text frame on its own, then rerun.",
};

/**
 * What to do next, without suggesting what to try.
 *
 * The instruction has to match the failure. A canary that failed to load the
 * entrypoint and a canary that caught the pipeline reading the id are the same
 * boolean and completely different problems, and telling an agent to "remove
 * whatever reads the id" when its module path was wrong sends it looking for a
 * leak that does not exist.
 */
function guidanceFor(signal: IterationSignal, next: number, maxIterations: number): string {
	const canary = signal.canary;
	if (canary && !canary.passed) {
		const remedy = CANARY_REMEDIES[canary.kind ?? ""];
		if (remedy) return `${remedy} Nothing is promoted while the canary cannot pass.`;
		// A failure the harness cannot attribute gets the reason and no instruction,
		// which is better than an instruction aimed at the wrong cause.
		if (canary.kind !== "sample_unusable") return `The leakage canary did not pass: ${canary.reason}`;
	}
	if (!signal.ok) {
		return "Write the results files again so this iteration can be measured. The listed errors are about the files, not the model, so the work behind them is not lost.";
	}
	const remaining = maxIterations - next + 1;
	return `You have ${remaining} iteration(s) left. Improve the model, or set "done": true in metrics.json if further work is unproductive.`;
}

/**
 * Copy the solution tree so the champion is re-run from the code that produced
 * it, not from whatever the agent writes next.
 */
function snapshotChampion(workspace: SolveWorkspace, signal: IterationSignal, iteration: number): Champion {
	const root = join(workspace.root, "iterations", String(iteration));
	rmSync(root, { recursive: true, force: true });
	mkdirSync(root, { recursive: true });
	cpSync(workspace.solutionsRoot, join(root, "solutions"), {
		recursive: true,
		filter: (source) => !source.includes("__pycache__"),
	});
	return {
		iteration,
		meanBacc: signal.recomputed!.mean_bacc,
		approach: signal.reported?.approach ?? "",
		module: signal.entrypoint!.module,
		factory: signal.entrypoint!.factory,
		root,
	};
}

function recordIteration(workspace: SolveWorkspace, entry: Record<string, unknown>): void {
	appendFileSync(join(workspace.root, "iterations.jsonl"),
		`${JSON.stringify({ recorded_at: new Date().toISOString(), ...entry })}\n`);
}

function reportInputs(
	report: StageReporter | undefined,
	workspace: SolveWorkspace,
	shape: { folds: number; repeats: number },
	maxIterations: number,
): void {
	if (!report) return;
	report.input({
		kind: "task_prompt", version: 1, delivery: "workspace_file", status: "available",
		artifact: workspace.taskPath, content_sha256: sha256(readFileSync(workspace.taskPath, "utf8")),
	});
	const document = join(workspace.researchDir, "research.md");
	report.input({
		kind: "research_document", version: 1, delivery: "workspace_file",
		status: existsSync(document) ? "available" : "unavailable",
		artifact: document,
		content_sha256: workspace.researchDocumentSha256,
	});
	const analysis = join(workspace.researchDir, "analysis");
	report.input({
		kind: "research_analysis", version: 1, delivery: "workspace_file",
		status: existsSync(analysis) ? "available" : "unavailable",
		artifact: analysis,
	});
	report.input({
		kind: "dataset_zips", version: 1, delivery: "workspace_file", status: "available",
		artifact: workspace.trainZip,
		bytes: existsSync(workspace.trainZip) ? statSync(workspace.trainZip).size : undefined,
		paths: workspace.datasetPaths,
	});
	report.input({
		kind: "sealed_split", version: 1, delivery: "workspace_file", status: "available",
		artifact: workspace.sealedPath,
		content_sha256: workspace.split.sha256,
		rows: workspace.split.sealedIds.length,
		fraction: workspace.split.fraction,
		seed: workspace.split.seed,
	});
	report.input({
		kind: "fold_recommendation", version: 1, delivery: "initial_prompt", status: "available",
		folds: shape.folds, repeats: shape.repeats,
		development_rows: workspace.rowCount,
		max_iterations: maxIterations,
	});
}
