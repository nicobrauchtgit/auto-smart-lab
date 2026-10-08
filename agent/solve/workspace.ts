/**
 * Prepare the run workspace for one solve invocation.
 *
 * Every task kind gets the same minimally prepared input: a development
 * archive and a sample manifest of opaque `{archive, member}` descriptors.
 * The harness never decodes or parses samples (D9); the agent's code reads the
 * bytes and decides how. The task configuration selects the targets (binary
 * labels, families or none) and the sealed split: stratified rows, whole
 * families, or nothing when there are no targets to confirm against. Sealed
 * rows are absent from everything the agent is pointed at, so the confirmation
 * split cannot be scored locally.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, relative } from "node:path";

import { PROJECT_ROOT, resolveTask } from "../pipeline/resolve_task.js";
import { projectPython, resolveTaskConfiguration, TASK_SAMPLES_SCRIPT, taskDataPaths, type TaskConfiguration } from "../pipeline/task_configuration.js";
import type { StageArtifact } from "../pipeline/types.js";
import type { MeasurementConfig } from "../training/types.js";
import { HARNESS_CONFIG } from "../harness/config.js";
import { noSeal, recommendFolds, sealConfirmationSet, sealGroups, type FoldRecommendation, type IdSealedSplit } from "./folds.js";

export interface SolveWorkspace {
	root: string;
	/** Where the agent's code lives; shared across tasks and runs. */
	solutionsRoot: string;
	entrypointPath: string;
	taskPath: string;
	researchDir: string;
	configuration: TaskConfiguration;
	/** The development manifest the training harness measures: descriptors and targets, no sealed rows. */
	sampleManifestPath: string;
	/** Controller measurement declaration for the training harness. */
	measurement: MeasurementConfig;
	/** The archive the agent is given: development rows only. */
	devZip: string;
	sealedPath: string;
	trainZip: string;
	testZip: string;
	datasetPaths: string[];
	split: { sealedIds: string[]; fraction: number; seed: number; sha256: string; scheme: "stratified" | "group" | "none"; sealedGroups?: number };
	recommendation: FoldRecommendation;
	rowCount: number;
	/** Where the development targets are, for the prompt. */
	targets: string;
	/** Class balance, family counts, or the absence of targets. */
	targetSummary: string;
	researchState: string;
	researchDocumentSha256?: string;
}

export interface PrepareOptions {
	configuration?: TaskConfiguration;
	sealedFraction?: number;
	seed?: number;
	upstream?: StageArtifact[];
	projectRoot?: string;
	/** Reads archive member lists; defaults to the project environment. */
	pythonExecutable?: string;
	/** The task's directory; defaults to the fetched unit metadata. */
	taskDir?: string;
}

/** Reserve the shared location where the agent, and only the agent, authors pipelines. */
export function prepareSolutionsWorkspace(
	projectRoot: string,
	taskId: string,
): Pick<SolveWorkspace, "solutionsRoot" | "entrypointPath"> {
	const solutionsRoot = join(projectRoot, "solutions");
	mkdirSync(join(solutionsRoot, "tasks"), { recursive: true });
	return {
		solutionsRoot,
		entrypointPath: join(solutionsRoot, "tasks", `${taskId}.py`),
	};
}

/** Sample IDs and targets of one archive, read without opening sample content. */
export function archiveRows(pythonExecutable: string, zip: string, targetsPath?: string, targets: TaskConfiguration["targets"]["kind"] = "none"): { ids: string[]; targets: (string | number)[] | null } {
	const output = execFileSync(pythonExecutable, [TASK_SAMPLES_SCRIPT, "--rows", JSON.stringify({ zip, targetsPath: targetsPath ?? null, targets })],
		{ encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
	return JSON.parse(output);
}

function seal(configuration: TaskConfiguration, ids: string[], targets: Map<string, string | number>, options: PrepareOptions): IdSealedSplit | ReturnType<typeof stratifiedSeal> {
	const seed = options.seed ?? HARNESS_CONFIG.solve.seed;
	if (configuration.holdout === "stratified") return stratifiedSeal(ids, targets, options.sealedFraction, seed);
	if (configuration.holdout === "group") return sealGroups(ids.map(id => ({ id, group: String(targets.get(id)) })), { fraction: options.sealedFraction, seed });
	return noSeal(ids, seed);
}

function stratifiedSeal(ids: string[], targets: Map<string, string | number>, fraction: number | undefined, seed: number) {
	const split = sealConfirmationSet(ids.map(id => ({ id, label: targets.get(id) as 0 | 1 })), { fraction, seed });
	return { scheme: "stratified" as const, sealedIds: split.sealedIds, devIds: split.devRows.map(row => row.id).sort(),
		sealedGroups: undefined, fraction: split.fraction, seed: split.seed, sha256: split.sha256 };
}

function describeTargets(configuration: TaskConfiguration, devIds: string[], targets: Map<string, string | number>, manifest: string, sealedGroups?: number) {
	if (configuration.targets.kind === "none") return { targets: "none; this task has no training targets", summary: "No targets: trials report label-free diagnostics." };
	const counts = new Map<string, number>();
	for (const id of devIds) counts.set(String(targets.get(id)), (counts.get(String(targets.get(id))) ?? 0) + 1);
	if (configuration.targets.kind === "binary") {
		const share = (label: string) => `class ${label} ${counts.get(label) ?? 0} (${(((counts.get(label) ?? 0) / devIds.length) * 100).toFixed(2)}%)`;
		return { targets: `binary \`target\` values in ${manifest} (sealed rows absent)`, summary: `Class balance: ${share("0")}, ${share("1")}.` };
	}
	const sizes = [...counts.values()].sort((a, b) => b - a);
	return { targets: `family \`target\` values in ${manifest} (the harness scores with them; they never reach fit)`,
		summary: `Families: ${counts.size}; largest ${sizes[0]} rows, smallest ${sizes.at(-1)} rows, ${sizes.filter(size => size === 1).length} singleton families. ${sealedGroups ?? 0} further families are sealed.` };
}

export function prepareSolveWorkspace(taskId: string, options: PrepareOptions = {}): SolveWorkspace {
	const configuration = resolveTaskConfiguration(taskId, options.configuration).configuration;
	const projectRoot = options.projectRoot ?? PROJECT_ROOT;
	const taskDir = options.taskDir ?? resolveTask({ taskId }).taskDir;
	const paths = taskDataPaths(taskId, configuration, taskDir);
	const python = options.pythonExecutable ?? projectPython();
	const train = archiveRows(python, paths.trainZip, paths.targetsPath, configuration.targets.kind);
	const targets = new Map<string, string | number>(train.targets ? train.ids.map((id, index) => [id, train.targets![index]]) : []);
	const split = seal(configuration, train.ids, targets, options);

	const root = join(projectRoot, "runs", taskId, "solve");
	const dataOut = join(root, "data");
	const researchDir = join(root, "research");
	for (const directory of [root, dataOut, researchDir]) mkdirSync(directory, { recursive: true });
	const { solutionsRoot, entrypointPath } = prepareSolutionsWorkspace(projectRoot, taskId);
	const taskPath = join(root, "task.md");
	const prompt = readFileSync(join(taskDir, "prompt.md"), "utf8");
	writeFileSync(taskPath, prompt.endsWith("\n") ? prompt : `${prompt}\n`);
	// Harness-only. The agent is never pointed at this and never needs it.
	const sealedPath = join(dataOut, "sealed_ids.txt");
	writeFileSync(sealedPath, split.sealedIds.length ? `${split.sealedIds.join("\n")}\n` : "");
	const researchState = copyResearch(researchDir, taskId, options.upstream ?? [], projectRoot);
	const devZip = writeDevelopmentZip(paths.trainZip, dataOut, split.devIds);

	// Opaque descriptors: the agent's code opens the archive member itself.
	const sampleManifestPath = join(dataOut, "development-samples.json");
	writeFileSync(sampleManifestPath, `${JSON.stringify({ schemaVersion: 1, samples: split.devIds.map(id => ({
		id, input: { archive: devZip, member: id }, ...(targets.size ? { target: targets.get(id)! } : {}),
	})) })}\n`);
	const measurement: MeasurementConfig = configuration.kind === "binary_classification"
		? { kind: "classification", execution: "inductive", sampleManifestPath }
		: configuration.kind === "clustering"
			? { kind: "clustering", execution: configuration.execution, sampleManifestPath }
			: { kind: "anomaly_detection", execution: configuration.execution, sampleManifestPath, ...configuration.anomaly! };
	const described = describeTargets(configuration, split.devIds, targets, relative(projectRoot, sampleManifestPath), split.sealedGroups);
	const groups = configuration.targets.kind === "families" ? new Set(split.devIds.map(id => targets.get(id))).size : undefined;
	return {
		root, solutionsRoot, entrypointPath, taskPath, researchDir, configuration,
		sampleManifestPath, measurement,
		devZip, sealedPath, trainZip: paths.trainZip, testZip: paths.testZip,
		// What the agent is given: the development archive and the unlabelled test
		// set. The full training archive is withheld, because the held-out rows are
		// otherwise recoverable from it as `members - manifest`.
		datasetPaths: [devZip, ...(existsSync(paths.testZip) ? [paths.testZip] : [])].map(path => relative(projectRoot, path)),
		split: { sealedIds: split.sealedIds, fraction: split.fraction, seed: split.seed, sha256: split.sha256, scheme: split.scheme, ...(split.sealedGroups !== undefined ? { sealedGroups: split.sealedGroups } : {}) },
		recommendation: configuration.holdout === "stratified" ? recommendFolds(split.devIds.length)
			: groups ? recommendFolds(split.devIds.length, { scheme: "group_kfold", groups })
				: recommendFolds(split.devIds.length, { scheme: "kfold" }),
		rowCount: split.devIds.length,
		targets: described.targets,
		targetSummary: described.summary,
		researchState,
		researchDocumentSha256: options.upstream?.find((artifact) => artifact.kind === "research_document")?.sha256,
	};
}

/**
 * Write an archive holding only the development rows.
 *
 * Withholding the held-out ids is not enough on its own: given the full training
 * archive and a development-only labels file, the held-out set is exactly
 * `members - labels`, and each id's extension states its label. The split is only
 * genuinely held out if its rows are absent from what the agent can read.
 */
function writeDevelopmentZip(trainZip: string, dataOut: string, devIds: readonly string[]): string {
	const target = join(dataOut, basename(trainZip).replace(/\.zip$/, "-dev.zip"));
	const listing = join(dataOut, "development_members.txt");
	writeFileSync(listing, `${devIds.join("\n")}\n`);
	rmSync(target, { force: true });
	// `zip --copy` transfers members between archives without inflating them.
	execFileSync("zip", ["--quiet", "--copy", trainZip, "--out", target, "--names-stdin"],
		{ input: `${devIds.join("\n")}\n`, maxBuffer: 64 * 1024 * 1024 });
	rmSync(listing, { force: true });
	return target;
}

/**
 * Copy the research document and the analysis the research agent produced.
 * Those scripts are reusable evidence, not decoration: the solve agent can rerun
 * them rather than re-measuring the dataset from scratch.
 */
function copyResearch(researchDir: string, taskId: string, upstream: StageArtifact[], projectRoot: string): string {
	const document = upstream.find((artifact) => artifact.kind === "research_document")?.path
		?? join(projectRoot, "runs", taskId, "research", "research.md");
	const lines: string[] = [];
	if (existsSync(document)) {
		const target = join(researchDir, "research.md");
		copyFileSync(document, target);
		lines.push(`- Research document: ${target}`);
	} else {
		lines.push("- No research document is available for this task.");
	}
	const analysis = join(projectRoot, "runs", taskId, "research", "analysis");
	if (existsSync(analysis)) {
		cpSync(analysis, join(researchDir, "analysis"), { recursive: true });
		lines.push(`- Research analysis scripts and artifacts: ${join(researchDir, "analysis")} (rerunnable)`);
	}
	return lines.join("\n");
}
