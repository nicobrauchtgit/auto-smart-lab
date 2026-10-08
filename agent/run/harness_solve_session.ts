import type { StageGuidance } from "../pipeline/guidance.js";
import type { InvocationFeedback } from "../pipeline/feedback.js";
/** Agent-driven solve session backed exclusively by harness-owned training. */

import { HARNESS_CONFIG } from "../harness/config.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { delimiter, dirname, join, relative } from "node:path";

import { PROJECT_ROOT } from "../pipeline/resolve_task.js";
import type { StageArtifact, StageReporter } from "../pipeline/types.js";
import { loadPromptSnapshot, type PromptSnapshot } from "../prompts/loader.js";
import { prepareSolvePrompts } from "../prompts/solve.js";
import { prepareSolveWorkspace, type SolveWorkspace } from "../solve/workspace.js";
import {
	collectTrainingResults,
	createGitHistoryGuard,
	createHarnessTraining,
	ensureSolutionsRepository,
	type TrainingCollection,
} from "../training/index.js";
import { selectionSummary } from "../training/selection_summary.js";
import { championSelection } from "../training/development_selection.js";
import { GIT_BLOCK_PROMPT_IDS } from "../training/git_guard.js";
import { readPythonEnvironment, type PythonEnvironment } from "./python_environment.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";
import { prepareSolveSandbox, isolatedSolveTools, solvePythonEnvironmentTool, trainingSandboxCommand } from "./solve_sandbox.js";
import { runSession } from "./session_runner.js";

export type HarnessSolveStopReason = "agent_finished" | "agent_failed" | "cancelled" | "no_promotion";

export interface HarnessSolveResult {
	workspace: string;
	configuration: TaskConfiguration;
	trainingRoot: string;
	valid: boolean;
	errors: string[];
	attempts: number;
	stopReason: HarnessSolveStopReason;
	collection: TrainingCollection;
	sessionError?: string;
}

export interface RunHarnessSolveOptions {
 /** Harness parts for this task, as resolved by the executor. */
 taskConfiguration?: TaskConfiguration;
 guidance?: StageGuidance;
 feedback?: InvocationFeedback;
	/** Advisory experiment budget shown to the agent; the agent decides when fitting is useful. */
	maxTrials?: number;
	sealedFraction?: number;
	seed?: number;
	foldPolicy?: "auto" | { folds: number; repeats: number };
	/** Minimum seconds between routine experiment updates. */
	experimentUpdateIntervalSeconds?: number;
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
	prepareRepository: typeof ensureSolutionsRepository;
	prepareSandbox: typeof prepareSolveSandbox;
}

const DEFAULT_DEPENDENCIES: HarnessSolveDependencies = {
	prepareWorkspace: prepareSolveWorkspace,
	readPython: readPythonEnvironment,
	createTraining: createHarnessTraining,
	runAgentSession: runSession,
	collectResults: collectTrainingResults,
	prepareRepository: ensureSolutionsRepository,
	prepareSandbox: prepareSolveSandbox,
};

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

/** Development sample bytes plus the manifest that identifies them and their targets. */
function datasetFingerprint(workspace: SolveWorkspace): string {
	return createHash("sha256")
		.update(readFileSync(workspace.devZip))
		.update(readFileSync(workspace.sampleManifestPath))
		.digest("hex");
}

/** The selected trial's primary development metric, named by the task configuration. */
export function primaryMetric(workspace: Pick<SolveWorkspace, "configuration">, metrics: Record<string, unknown> | undefined): Record<string, unknown> {
	const name = workspace.configuration.metric === "balanced_accuracy" ? "balancedAccuracy"
		: workspace.configuration.metric === "adjusted_rand_index" ? "adjustedRandIndex" : undefined;
	return name ? { name: workspace.configuration.metric, value: metrics?.[name] } : { name: "none" };
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
		LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
		// nix-ld runs uv's standalone Python on NixOS; absent elsewhere.
		NIX_LD: process.env.NIX_LD,
		NIX_LD_LIBRARY_PATH: process.env.NIX_LD_LIBRARY_PATH,
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
		bytes: statSync(workspace.devZip).size,
		sample_manifest: workspace.sampleManifestPath, measurement: workspace.measurement,
		task_kind: workspace.configuration.kind, holdout: workspace.split.scheme,
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
		artifact: trainingRoot, controls: ["experiment_start", "experiment_status", "experiment_output", "experiment_stop", "experiment_resume"],
		module_root: "solutions/", authoritative_fits: "harness_only",
		versioning: "git_worktree_per_trial", search: "optuna_ask_tell",
	});
}

/** Preserve the originating workspace and its budget on interrupted solve restart. */
export function recoveryTrainingRoot(parent: string, runId: string): string {
    const candidates: string[] = [];
    const paused: { root: string; at: number }[] = [];
    if (existsSync(parent)) for (const rootName of readdirSync(parent)) {
        const root = join(parent, rootName);
        if (!statSync(root).isDirectory()) continue;
        for (const id of readdirSync(root)) {
            const path = join(root, id, "recovery.json");
            if (!existsSync(path)) continue;
            try {
                const meta = JSON.parse(readFileSync(path, "utf8"));
                const read = (name: string) => existsSync(join(root, id, name)) ? JSON.parse(readFileSync(join(root, id, name), "utf8")) : {};
                if (meta.lifecycle === "active" && !read("supervisor-state.json").stopReason
                    && !read("search-report.json").stopReason) candidates.push(root);
                else if (!["completed", "failed"].includes(read("trial-result.json").status)
                    && read("search-report.json").stopReason !== "max_seconds") paused.push({ root, at: meta.trial?.startedAt ?? 0 });
            } catch { throw new Error(`Corrupt recovery state at ${path}; restore it before restarting solve.`); }
        }
    }
    const unique = [...new Set(candidates)];
    if (unique.length > 1) throw new Error(`Multiple interrupted training workspaces: ${unique.join(", ")}. Resume them individually before a new solve session.`);
    return unique[0] ?? paused.sort((a, b) => b.at - a.at)[0]?.root ?? join(parent, runId);
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
		configuration: options.taskConfiguration,
		sealedFraction: options.sealedFraction,
		seed: options.seed,
		upstream: options.upstream,
	});
	const foldPolicy = options.foldPolicy ?? HARNESS_CONFIG.solve.foldPolicy;
	const shape = foldPolicy !== "auto"
		? foldPolicy
		: { folds: workspace.recommendation.folds, repeats: workspace.recommendation.repeats };
	const python = dependencies.readPython();
	const identity = report?.agentIdentity(1);
	const sandbox = dependencies.prepareSandbox(workspace, python);
	const boundaryFingerprint = sha256(JSON.stringify({ version: 1, mechanism: "bubblewrap_mount_pid_user_namespaces",
        executable: sandbox.executable, cwd: sandbox.cwd, mounts: sandbox.mounts, environment: sandbox.env,
        sandbox_script_sha256: sha256(readFileSync(join(PROJECT_ROOT, "agent/run/solve_sandbox.ts"))),
        tool_worker_sha256: sha256(readFileSync(join(PROJECT_ROOT, "agent/run/solve_tool_worker.ts"))) }));
	const isolatedTools = isolatedSolveTools(sandbox);
	const environmentToolPrompt = prompts.render("solve.python-environment-tool", {});
	const environmentTool = solvePythonEnvironmentTool(python, environmentToolPrompt.text, PROJECT_ROOT, {
        pipelineRunId: identity?.pipelineRunId ?? runId, stageInvocationId: identity?.stageInvocationId ?? runId, attempt: 1 });
	const isolationPrompt = prompts.render("solve.isolation", { workspace: sandbox.agentRoot });
	const trainingRoot = recoveryTrainingRoot(join(workspace.root, "training"), runId);
	const fingerprint = datasetFingerprint(workspace);

	reportInputs(report, workspace, python, trainingRoot);
	// The agent's history is evidence; setup creates the repository if needed
	// and never touches existing history or uncommitted work.
	const repository = dependencies.prepareRepository(workspace.solutionsRoot);
	report?.input({
		kind: "solutions_repository", version: 1, delivery: "workspace_file", status: "available",
		artifact: workspace.solutionsRoot, initialized: repository.initialized,
		head_commit: repository.head, branch: repository.branch,
	});
	report?.event("solve_workspace_prepared", {
		workspace: workspace.root,
		solutions_root: relative(PROJECT_ROOT, workspace.solutionsRoot),
		development_rows: workspace.rowCount,
		sealed_rows: workspace.split.sealedIds.length,
		sealed_sha256: workspace.split.sha256,
		holdout: workspace.split.scheme,
		task_kind: workspace.configuration.kind,
		fold_recommendation: shape,
		training_root: trainingRoot,
	});

	const opening = prepareSolvePrompts(prompts, {
        ...(workspace.measurement.kind === "anomaly_detection" && workspace.measurement.evidence ? { evidencePath: workspace.measurement.evidence.path } : {}),
 guidance: options.guidance,
		taskId,
		configuration: workspace.configuration,
		workspace: sandbox.agentRoot,
		datasetPaths: workspace.datasetPaths,
		targets: workspace.targets,
		rowCount: workspace.rowCount,
		targetSummary: workspace.targetSummary,
		foldRecommendation: `${shape.folds}-fold ${workspace.recommendation.scheme}, ${shape.repeats} repeat(s)`,
		researchState: workspace.researchState,
		maxIterations: options.maxTrials ?? HARNESS_CONFIG.solve.maxIterations,
	});
	opening.prompt += `\n\n${isolationPrompt.text}`;
	opening.promptReferences.push(isolationPrompt.reference, environmentToolPrompt.reference);
	report?.input({ kind: "solve_filesystem_boundary", version: 1, delivery: "tool", status: "available",
		artifact: sandbox.agentRoot, content_sha256: boundaryFingerprint, mechanism: "bubblewrap_mount_pid_user_namespaces",
		read_only: sandbox.mounts.filter(mount => !mount.writable).map(mount => mount.source),
		writable: sandbox.mounts.filter(mount => mount.writable).map(mount => mount.source) });
	report?.event("harness_configuration", {
		version: 1, defaults: HARNESS_CONFIG,
		solve: { ...HARNESS_CONFIG.solve, maxIterations: options.maxTrials ?? HARNESS_CONFIG.solve.maxIterations,
			seed: options.seed ?? HARNESS_CONFIG.solve.seed,
			sealedFraction: options.sealedFraction ?? HARNESS_CONFIG.solve.sealedFraction,
			foldPolicy: options.foldPolicy ?? HARNESS_CONFIG.solve.foldPolicy,
			experimentUpdateIntervalSeconds: options.experimentUpdateIntervalSeconds ?? HARNESS_CONFIG.solve.experimentUpdateIntervalSeconds },
		foldRecommendation: shape,
	});
	const training = dependencies.createTraining({
		root: trainingRoot,
		env: workerEnvironment(python),
		record: (eventType, payload) => report?.event(eventType, payload),
		environmentFingerprint: python.fingerprint,
		pipelineRunId: identity?.pipelineRunId,
		stageInvocationId: identity?.stageInvocationId,
		pythonExecutable: python.executable,
		// Module paths are relative to the directory holding solutions/, which is
		// the project root in production and a temporary project in tests.
		projectRoot: dirname(workspace.solutionsRoot),
		workerPath: join(PROJECT_ROOT, "agent", "training", "python", "worker.py"),
        sandboxCommand: (command, input) => trainingSandboxCommand(sandbox, command, input),
        executionBoundaryFingerprint: boundaryFingerprint,
		taskId,
		datasetSha256: fingerprint,
		rootSeed: options.seed ?? HARNESS_CONFIG.solve.seed,
		zipPath: workspace.devZip,
		measurement: workspace.measurement,
		solutionsRoot: workspace.solutionsRoot,
		search: HARNESS_CONFIG.search,
		onTrialStarted: (trial) => report?.input({
			kind: "training_source", version: 1, delivery: "tool", status: "available",
			artifact: trial.worktrees[0] ?? workspace.solutionsRoot, experiment_id: trial.id,
			commit: trial.source?.commit, tree: trial.source?.tree, branch: trial.source?.branch,
			subject: trial.source?.subject, requested_revision: trial.source?.requested,
			search: trial.request.search !== undefined, scope: trial.request.scope.kind,
			measurement: trial.measurement ?? { kind: "classification" },
			champion_experiment_id: trial.champion?.experimentId, champion_commit: trial.champion?.commit,
		}),
		maxExperiments: options.maxTrials ?? HARNESS_CONFIG.solve.maxIterations,
		limits: { updateIntervalMs: (options.experimentUpdateIntervalSeconds ?? HARNESS_CONFIG.solve.experimentUpdateIntervalSeconds) * 1_000 },
		prompts,
		...(options.signal ? { signal: options.signal } : {}),
	});

	try { await training.ready?.(); }
    catch (error) { await training.close(); throw error; }

	let sessionError: string | undefined;
	let stopReason: HarnessSolveStopReason = "agent_finished";
	const guardPrompts = GIT_BLOCK_PROMPT_IDS.map((id) => prompts.render(id, {}).reference);
	report?.event("agent_attempt_start", {
		attempt: 1, reason: "agent_driven_training", model: model ?? "pipeline-default",
		prompt_snapshot_sha256: prompts.fingerprint,
		prompts: [...opening.promptReferences, ...training.toolPrompts, ...guardPrompts],
	});
	try {
		const { output, agentRunId } = await dependencies.runAgentSession({
			knowledge: { root: join(PROJECT_ROOT, "knowledge"), origin: { taskId, datasetSha256: fingerprint,
				pipelineRunId: identity?.pipelineRunId, stageInvocationId: identity?.stageInvocationId }, trainingRoots: [trainingRoot, join(workspace.root, "training")] },
			prompts,
			system: opening.system,
			prompt: opening.prompt,
			promptReferences: [...opening.promptReferences, ...training.toolPrompts, ...guardPrompts],
			feedback: options.feedback,
				reportInput: report ? (input) => report.input(input) : undefined,
			model,
			cwd: PROJECT_ROOT,
			env: { SOLVE_WORKSPACE: sandbox.agentRoot },
			tools: [],
			customTools: [...training.tools, ...isolatedTools, environmentTool],
			onSessionReady: training.bindSession,
			extensionPaths: [join(PROJECT_ROOT, "agent", "tools", "web_search.ts")],
			extensionFactories: [createGitHistoryGuard(prompts, (eventType, payload) => report?.event(eventType, payload))],
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

	const collection = await championSelection(await dependencies.collectResults(trainingRoot), workspace.solutionsRoot, taskId);
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
		selected_metric: primaryMetric(workspace, collection.selected?.result?.metrics as Record<string, unknown> | undefined),
        selected_selection: selectionSummary(collection.selected?.result),
		errors,
		trial_validation_errors: collection.errors,
		session_error: sessionError,
	});

	return {
		workspace: workspace.root,
		configuration: workspace.configuration,
		trainingRoot,
		valid: collection.valid,
		errors,
		attempts: 1,
		stopReason,
		collection,
		...(sessionError ? { sessionError } : {}),
	};
}
