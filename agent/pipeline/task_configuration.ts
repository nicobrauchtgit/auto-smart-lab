/**
 * Typed task configuration: which harness parts a task uses.
 *
 * The orchestrator agent declares one configuration per task; configured runs
 * and standalone stage commands read it from `pipeline.tasks` in the verified,
 * fingerprinted pipeline.config.json. There is no command-line override. Stages read it to pick their components: how samples
 * are identified, which targets exist, how the sealed split is drawn, what the
 * harness scores, how the terminal refit runs, and what the submission
 * contains. None of it constrains the solver's model design; features,
 * estimator, parameters and CV design remain the solver's choices.
 *
 * Only implemented components are accepted. Cross-field rules reject
 * combinations no stage can execute, before any stage starts.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import type { EvidenceSelection } from "../training/types.js";
import { HARNESS_CONFIG } from "../harness/config.js";
import { PROJECT_ROOT, resolveTask } from "./resolve_task.js";

export type TaskKind = "binary_classification" | "clustering" | "anomaly_detection";

export interface AnomalyScoring {
	scoreMethod: "score_samples" | "decision_function" | "negative_outlier_factor_";
	scoreDirection: "higher_is_anomalous" | "lower_is_anomalous";
	/** Label the pipeline's `predict` uses for anomalies; submitted as 1. */
	anomalyLabel: number;
}

export interface TaskConfiguration {
	schemaVersion: 1;
	kind: TaskKind;
	/** Sample identity. Reading sample content stays the agent's code (D9). */
	samples: { source: "zip_members" | "pcap_tcp_connections"; train: string; test: string };
	/** Training targets, from a `id;target` file in the task's data directory. */
	targets: { kind: "binary" | "families"; file: string } | { kind: "none" };
	/** Whether the harness fits on training rows (inductive) or on the scored batch itself. */
	execution: "inductive" | "batch";
	/** How the sealed confirmation rows are drawn from training data. */
	holdout: "stratified" | "group" | "none";
	/** The harness's development metric; `none` means no trusted development score. */
	metric: "balanced_accuracy" | "adjusted_rand_index" | "none";
	anomaly?: AnomalyScoring;
	selection?: EvidenceSelection;
	/** Terminal refit: fit all training rows then predict test, or fit/predict the test batch. */
	refit: "fit_training_predict_test" | "fit_predict_test_batch";
	submission: { format: "id_semicolon_prediction"; predictions: "binary" | "cluster_id" };
}

export interface ConfigurationSummary {
	configuration: TaskConfiguration;
	sha256: string;
	source: "declared" | "pipeline_config";
}

const KINDS = ["binary_classification", "clustering", "anomaly_detection"] as const;

function object(value: unknown, path: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
	const record = value as Record<string, unknown>;
	const unknown = Object.keys(record).filter(key => !keys.includes(key) && !optional.includes(key));
	if (unknown.length) throw new Error(`${path} has unknown fields: ${unknown.join(", ")}`);
	const missing = keys.filter(key => !(key in record));
	if (missing.length) throw new Error(`${path} is missing: ${missing.join(", ")}`);
	return record;
}

function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${path} must be one of ${allowed.join(", ")}`);
	return value as T;
}

/** A plain file name inside the task's data directory; never a path. */
function fileName(value: unknown, path: string): string {
	if (typeof value !== "string" || !value || value !== basename(value) || value.startsWith(".") || /[\0\\]/.test(value)) {
		throw new Error(`${path} must be a file name in the task's data directory`);
	}
	return value;
}

/** Validate shape and cross-field consistency. Errors are all reported together. */
export function parseTaskConfiguration(raw: unknown): TaskConfiguration {
	const value = object(raw, "taskConfiguration", ["schemaVersion", "kind", "samples", "targets", "execution", "holdout", "metric", "refit", "submission"], ["anomaly", "selection"]);
	if (value.schemaVersion !== 1) throw new Error("taskConfiguration.schemaVersion must be 1");
	const kind = oneOf(value.kind, "kind", KINDS);
	const samples = object(value.samples, "samples", ["source", "train", "test"]);
	const source = oneOf(samples.source, "samples.source", ["zip_members", "pcap_tcp_connections"] as const);
	const targetsRaw = value.targets as Record<string, unknown> | undefined;
	const targetKind = oneOf(targetsRaw?.kind, "targets.kind", ["binary", "families", "none"] as const);
	const targets: TaskConfiguration["targets"] = targetKind === "none"
		? (object(targetsRaw, "targets", ["kind"]), { kind: "none" })
		: { kind: targetKind, file: fileName(object(targetsRaw, "targets", ["kind", "file"]).file, "targets.file") };
	const submission = object(value.submission, "submission", ["format", "predictions"]);
	const configuration: TaskConfiguration = {
		schemaVersion: 1,
		kind,
		samples: { source, train: fileName(samples.train, "samples.train"), test: fileName(samples.test, "samples.test") },
		targets,
		execution: oneOf(value.execution, "execution", ["inductive", "batch"] as const),
		holdout: oneOf(value.holdout, "holdout", ["stratified", "group", "none"] as const),
		metric: oneOf(value.metric, "metric", ["balanced_accuracy", "adjusted_rand_index", "none"] as const),
		refit: oneOf(value.refit, "refit", ["fit_training_predict_test", "fit_predict_test_batch"] as const),
		submission: {
			format: oneOf(submission.format, "submission.format", ["id_semicolon_prediction"] as const),
			predictions: oneOf(submission.predictions, "submission.predictions", ["binary", "cluster_id"] as const),
		},
	};
	if (value.anomaly !== undefined) {
		const anomaly = object(value.anomaly, "anomaly", ["scoreMethod", "scoreDirection", "anomalyLabel"]);
		if (!Number.isInteger(anomaly.anomalyLabel)) throw new Error("anomaly.anomalyLabel must be an integer");
		configuration.anomaly = {
			scoreMethod: oneOf(anomaly.scoreMethod, "anomaly.scoreMethod", ["score_samples", "decision_function", "negative_outlier_factor_"] as const),
			scoreDirection: oneOf(anomaly.scoreDirection, "anomaly.scoreDirection", ["higher_is_anomalous", "lower_is_anomalous"] as const),
			anomalyLabel: anomaly.anomalyLabel as number,
		};
	}
	if (value.selection !== undefined) {
		const selection = object(value.selection, "selection", ["basis", "metric", "direction", "population"]);
		configuration.selection = {
			basis: oneOf(selection.basis, "selection.basis", ["evidence"] as const),
			metric: oneOf(selection.metric, "selection.metric", ["evidence_average_precision", "evidence_roc_auc"] as const),
			direction: oneOf(selection.direction, "selection.direction", ["maximize"] as const),
			population: oneOf(selection.population, "selection.population", ["development"] as const),
		};
	}
	const errors = consistencyErrors(configuration);
	if (errors.length) throw new Error(`Inconsistent task configuration:\n- ${errors.join("\n- ")}`);
	return configuration;
}

/** Combinations the registered harness parts can execute. */
function consistencyErrors(c: TaskConfiguration): string[] {
	const errors: string[] = [];
	const expect = (condition: boolean, message: string) => { if (!condition) errors.push(message); };
	expect(c.selection === undefined || c.kind === "anomaly_detection", "evidence selection currently applies only to anomaly_detection");
	const refit = c.execution === "batch" ? "fit_predict_test_batch" : "fit_training_predict_test";
	expect(c.refit === refit, `refit must be ${refit} for ${c.execution} execution, so the terminal fit matches what was measured`);
	if (c.samples.source === "pcap_tcp_connections" && c.kind !== "anomaly_detection") errors.push("pcap_tcp_connections currently requires anomaly_detection");
	if (c.samples.train === c.samples.test) errors.push("samples.train and samples.test must be different archives");
	if (c.kind === "binary_classification") {
		expect(c.targets.kind === "binary", "binary_classification requires binary targets");
		expect(c.execution === "inductive", "binary_classification requires inductive execution");
		expect(c.holdout === "stratified", "binary_classification requires a stratified holdout");
		expect(c.metric === "balanced_accuracy", "binary_classification is scored with balanced_accuracy");
		expect(c.submission.predictions === "binary", "binary_classification submits binary predictions");
		expect(c.anomaly === undefined, "anomaly scoring applies only to anomaly_detection");
	} else if (c.kind === "clustering") {
		expect(c.targets.kind !== "binary", "clustering targets are families or none");
		const labelled = c.targets.kind === "families";
		expect(c.metric === (labelled ? "adjusted_rand_index" : "none"), labelled
			? "clustering with family targets is scored with adjusted_rand_index"
			: "clustering without targets has no trusted development metric (metric none)");
		expect(c.holdout === (labelled ? "group" : "none"), labelled
			? "clustering with families seals whole families (holdout group), so sealed families stay unseen"
			: "a holdout needs targets to score; use holdout none");
		expect(c.submission.predictions === "cluster_id", "clustering submits cluster_id predictions");
		expect(c.anomaly === undefined, "anomaly scoring applies only to anomaly_detection");
	} else {
		expect(c.targets.kind === "none", "anomaly_detection is label-free (targets none)");
		expect(c.metric === "none", "anomaly_detection has no trusted development metric (metric none)");
		expect(c.holdout === "none", "a holdout needs targets to score; use holdout none");
		expect(c.submission.predictions === "binary", "anomaly_detection submits binary predictions (1 is anomalous)");
		expect(c.anomaly !== undefined, "anomaly_detection requires anomaly score semantics");
		if (c.anomaly?.scoreMethod === "negative_outlier_factor_") expect(c.execution === "batch", "negative_outlier_factor_ describes fitted rows and requires batch execution");
	}
	return errors;
}

export function taskConfigurationHash(configuration: TaskConfiguration): string {
	return createHash("sha256").update(canonical(configuration)).digest("hex");
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

/**
 * The configuration a stage runs under: the controller's declaration, else the
 * task's entry in pipeline.config.json. A task with neither cannot run a stage.
 */
export function resolveTaskConfiguration(taskId: string, declared?: TaskConfiguration, configured?: TaskConfiguration): ConfigurationSummary {
	const chosen = declared ?? configured;
	if (!chosen) throw new Error(`Task ${taskId} has no task configuration; add pipeline.tasks.${taskId} to pipeline.config.json or let the orchestrator declare one with task_configure`);
	const configuration = parseTaskConfiguration(chosen);
	return { configuration, sha256: taskConfigurationHash(configuration), source: declared ? "declared" : "pipeline_config" };
}

/** The configuration the executor resolved for this invocation. */
export function stageConfiguration(input: { taskId: string; taskConfiguration?: TaskConfiguration }): TaskConfiguration {
	return resolveTaskConfiguration(input.taskId, input.taskConfiguration).configuration;
}

export interface TaskDataPaths { dataDir: string; trainZip: string; testZip: string; targetsPath?: string }

export function taskDataPaths(taskId: string, configuration: TaskConfiguration, taskDir = resolveTask({ taskId }).taskDir): TaskDataPaths {
	const dataDir = join(taskDir, "data");
	return {
		dataDir,
		trainZip: join(dataDir, configuration.samples.train),
		testZip: join(dataDir, configuration.samples.test),
		...(configuration.targets.kind === "none" ? {} : { targetsPath: join(dataDir, configuration.targets.file) }),
	};
}

/** Bounded facts about the declared data; produced without reading sample content. */
export interface TaskDataInspection {
	trainRows: number;
	testRows: number;
	targets: { kind: "binary"; counts: Record<string, number> } | { kind: "families"; families: number; largest: number; smallest: number; singletons: number } | { kind: "none" };
}

export const TASK_SAMPLES_SCRIPT = join(PROJECT_ROOT, "agent", "training", "python", "task_samples.py");

/** The project environment's interpreter, without the full environment drift check. */
export function projectPython(): string {
	return join(resolve(PROJECT_ROOT, process.env.VENV_DIR ?? ".venv"), "bin", "python");
}

/** Top-level files of the task's data directory, so a controller can name them in a declaration. */
export function listTaskDataFiles(taskId: string, limit = 64): { name: string; bytes: number }[] {
	const dataDir = join(resolveTask({ taskId }).taskDir, "data");
	if (!existsSync(dataDir)) return [];
	return readdirSync(dataDir, { withFileTypes: true }).filter(entry => entry.isFile() && !entry.name.startsWith("."))
		.map(entry => ({ name: entry.name, bytes: statSync(join(dataDir, entry.name)).size }))
		.sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
}

/**
 * Check the declared files exist and agree: unique sample IDs, disjoint
 * train/test archives, targets covering exactly the training samples.
 */
export function inspectTaskData(taskId: string, configuration: TaskConfiguration, pythonExecutable: string): TaskDataInspection {
	const paths = taskDataPaths(taskId, configuration);
	for (const path of [paths.trainZip, paths.testZip, paths.targetsPath].filter((p): p is string => !!p)) {
		if (!existsSync(path)) throw new Error(`Declared task file is missing: ${basename(path)}`);
	}
	const result = spawnSync(pythonExecutable, [TASK_SAMPLES_SCRIPT, "--inspect", JSON.stringify({
		trainZip: paths.trainZip, testZip: paths.testZip, targetsPath: paths.targetsPath ?? null,
		source: configuration.samples.source, targets: configuration.targets.kind, neutralTestIds: configuration.kind === "binary_classification",
	})], { encoding: "utf8", timeout: HARNESS_CONFIG.setup.timeoutMs * 4, maxBuffer: 4 * 1024 * 1024 });
	if (result.error) throw new Error("Task data inspection could not run");
	const output = JSON.parse(result.stdout.trim().split("\n").at(-1) || "{}");
	if (result.status !== 0) throw new Error(`Task data does not match the declared configuration: ${output.error ?? "inspection failed"}`);
	return output as TaskDataInspection;
}
