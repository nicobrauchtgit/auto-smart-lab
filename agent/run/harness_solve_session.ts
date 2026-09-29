/** Agent-driven solve session backed exclusively by harness-owned training. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join, relative } from "node:path";

import { PROJECT_ROOT } from "../pipeline/resolve_task.js";
import type { StageArtifact, StageReporter } from "../pipeline/types.js";
import { loadPromptSnapshot, type PromptSnapshot } from "../prompts/loader.js";
import { prepareSolvePrompts } from "../prompts/solve.js";
import { prepareSolveWorkspace, type SolveWorkspace } from "../solve/workspace.js";
import {
	collectTrainingResults,
	createHarnessTraining,
	resolveCppRuntimeLibraryPath,
	type TrainingCollection,
} from "../training/index.js";
import { readPythonEnvironment, type PythonEnvironment } from "./python_environment.js";
import { runSession } from "./session_runner.js";

export type HarnessSolveStopReason = "agent_finished" | "agent_failed" | "cancelled" | "no_promotion";

export interface HarnessSolveResult {
	workspace: string;
	trainingRoot: string;
	valid: boolean;
	errors: string[];
	attempts: number;
	stopReason: HarnessSolveStopReason;
	collection: TrainingCollection;
	sessionError?: string;
}

export interface RunHarnessSolveOptions {
	/** Advisory experiment budget shown to the agent; the agent decides when fitting is useful. */
	maxTrials?: number;
	sealedFraction?: number;
	seed?: number;
	foldPolicy?: "auto" | { folds: number; repeats: number };
	upstream?: StageArtifact[];
	prompts?: PromptSnapshot;
	report?: StageReporter;
	signal?: AbortSignal;
	/** Stage invocation identity; also isolates durable trial directories between runs. */
	runId?: string;
	/** Deterministic seams for integration tests; production uses the defaults below. */
	dependencies?: Partial<HarnessSolveDependencies>;
}

export interface HarnessSolveDependencies {
	prepareWorkspace: typeof prepareSolveWorkspace;
	readPython: typeof readPythonEnvironment;
	createTraining: typeof createHarnessTraining;
	runAgentSession: typeof runSession;
	collectResults: typeof collectTrainingResults;
}

const DEFAULT_DEPENDENCIES: HarnessSolveDependencies = {
	prepareWorkspace: prepareSolveWorkspace,
	readPython: readPythonEnvironment,
	createTraining: createHarnessTraining,
	runAgentSession: runSession,
	collectResults: collectTrainingResults,
};

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

function datasetFingerprint(workspace: SolveWorkspace): string {
	return createHash("sha256")
		.update(readFileSync(workspace.devZip))
		.update(readFileSync(workspace.devLabelsPath))
		.digest("hex");
}

function workerEnvironment(python: PythonEnvironment): Record<string, string> {
	const values: Record<string, string | undefined> = {
		PATH: `${join(python.prefix, "bin")}${delimiter}${process.env.PATH ?? ""}`,
		VENV_DIR: python.prefix,
		VIRTUAL_ENV: python.prefix,
		UV_PROJECT_ENVIRONMENT: python.prefix,
		UV_PYTHON: python.executable,
		UV_PYTHON_DOWNLOADS: "never",
		PYTHONNOUSERSITE: "1",
		LD_LIBRARY_PATH: resolveCppRuntimeLibraryPath(),
		LANG: process.env.LANG,
		LC_ALL: process.env.LC_ALL,
		TMPDIR: process.env.TMPDIR,
	};
	return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function reportInputs(
	report: StageReporter | undefined,
	workspace: SolveWorkspace,
	python: PythonEnvironment,
	trainingRoot: string,
): void {
	if (!report) return;
	report.input({
		kind: "task_prompt", version: 1, delivery: "workspace_file", status: "available",
		artifact: workspace.taskPath, content_sha256: sha256(readFileSync(workspace.taskPath)),
	});
	const document = join(workspace.researchDir, "research.md");
	report.input({
		kind: "research_document", version: 1, delivery: "workspace_file",
		status: existsSync(document) ? "available" : "unavailable", artifact: document,
		content_sha256: workspace.researchDocumentSha256,
	});
	report.input({
		kind: "training_dataset", version: 1, delivery: "tool", status: "available",
		artifact: workspace.devZip, dataset_sha256: datasetFingerprint(workspace),
		bytes: statSync(workspace.devZip).size, labels_artifact: workspace.devLabelsPath,
		rows: workspace.rowCount, sealed_rows: workspace.split.sealedIds.length,
	});
	report.input({
		kind: "python_environment", version: 1, delivery: "tool", status: "available",
		artifact: join(PROJECT_ROOT, "uv.lock"), content_sha256: python.fingerprint,
		python_version: python.python_version, executable: python.executable,
		lock_current: python.lock_current, environment_matches_lock: python.environment_matches_lock,
	});
	report.input({
		kind: "training_framework", version: 1, delivery: "tool", status: "available",
		artifact: trainingRoot, controls: ["experiment_start", "experiment_status", "experiment_output", "experiment_stop"],
		module_root: "solutions/", authoritative_fits: "harness_only",
	});
}

export async function runHarnessSolveSession(
	taskId: string,
	model?: string,
	options: RunHarnessSolveOptions = {},
): Promise<HarnessSolveResult> {
	const dependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
	const prompts = options.prompts ?? loadPromptSnapshot();
	const runId = options.runId ?? crypto.randomUUID();
	const report = options.report;
	const workspace = dependencies.prepareWorkspace(taskId, {
		sealedFraction: options.sealedFraction,
		seed: options.seed,
		upstream: options.upstream,
	});
	const shape = options.foldPolicy && options.foldPolicy !== "auto"
		? options.foldPolicy
		: { folds: workspace.recommendation.folds, repeats: workspace.recommendation.repeats };
	const python = dependencies.readPython();
	const trainingRoot = join(workspace.root, "training", runId);
	const fingerprint = datasetFingerprint(workspace);

	reportInputs(report, workspace, python, trainingRoot);
	report?.event("solve_workspace_prepared", {
		workspace: workspace.root,
		solutions_root: relative(PROJECT_ROOT, workspace.solutionsRoot),
		development_rows: workspace.rowCount,
		sealed_rows: workspace.split.sealedIds.length,
		sealed_sha256: workspace.split.sha256,
		fold_recommendation: shape,
		training_root: trainingRoot,
	});

	const opening = prepareSolvePrompts(prompts, {
		taskId,
		workspace: workspace.root,
		datasetPaths: workspace.datasetPaths,
		labelsPath: workspace.devLabelsPath,
		rowCount: workspace.rowCount,
		classBalance: workspace.classBalance,
		foldRecommendation: `${shape.folds}-fold stratified, ${shape.repeats} repeat(s)`,
		researchState: workspace.researchState,
		maxIterations: options.maxTrials ?? 6,
	});
	const identity = report?.agentIdentity(1);
	const training = dependencies.createTraining({
		root: trainingRoot,
		env: workerEnvironment(python),
		record: (eventType, payload) => report?.event(eventType, payload),
		environmentFingerprint: python.fingerprint,
		pipelineRunId: identity?.pipelineRunId,
		stageInvocationId: identity?.stageInvocationId,
		pythonExecutable: python.executable,
		projectRoot: PROJECT_ROOT,
		taskId,
		datasetSha256: fingerprint,
		rootSeed: options.seed ?? 13,
		zipPath: workspace.devZip,
		labelsPath: workspace.devLabelsPath,
		maxExperiments: options.maxTrials ?? 6,
		prompts,
		...(options.signal ? { signal: options.signal } : {}),
	});

	let sessionError: string | undefined;
	let stopReason: HarnessSolveStopReason = "agent_finished";
	report?.event("agent_attempt_start", {
		attempt: 1, reason: "agent_driven_training", model: model ?? "pipeline-default",
		prompt_snapshot_sha256: prompts.fingerprint,
		prompts: [...opening.promptReferences, ...training.toolPrompts],
	});
	try {
		const { output, agentRunId } = await dependencies.runAgentSession({
			prompts,
			system: opening.system,
			prompt: opening.prompt,
			promptReferences: [...opening.promptReferences, ...training.toolPrompts],
			reportInput: report ? (input) => report.input(input) : undefined,
			model,
			cwd: PROJECT_ROOT,
			env: { SOLVE_WORKSPACE: workspace.root },
			tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
			customTools: training.tools,
			onSessionReady: training.bindSession,
			extensionPaths: [],
			...(options.signal ? { signal: options.signal } : {}),
			...(report ? { observe: report.observation(1) } : {}),
		});
		report?.event("agent_attempt_end", {
			attempt: 1, agent_run_id: agentRunId, output_received: output.trim().length > 0,
		});
	} catch (error) {
		sessionError = error instanceof Error ? error.message : String(error);
		stopReason = options.signal?.aborted ? "cancelled" : "agent_failed";
		report?.event("agent_attempt_error", { attempt: 1, message: sessionError });
	} finally {
		await training.close();
	}

	const collection = await dependencies.collectResults(trainingRoot);
	const errors = collection.valid ? [] : collection.errors.map((error) => error.message);
	if (!collection.valid && stopReason === "agent_finished") stopReason = "no_promotion";
	report?.event("training_results_validated", {
		valid: collection.valid,
		trials: collection.trials.length,
		eligible_trials: collection.trials.filter((trial) => trial.eligible).length,
		selected_experiment_id: collection.selected?.experimentId,
		errors: collection.errors,
	});
	report?.event("solve_finished", {
		attempts: 1,
		stop_reason: stopReason,
		valid: collection.valid,
		selected_experiment_id: collection.selected?.experimentId,
		selected_balanced_accuracy: collection.selected?.result?.metrics?.balancedAccuracy,
		errors,
		trial_validation_errors: collection.errors,
		session_error: sessionError,
	});

	return {
		workspace: workspace.root,
		trainingRoot,
		valid: collection.valid,
		errors,
		attempts: 1,
		stopReason,
		collection,
		...(sessionError ? { sessionError } : {}),
	};
}
