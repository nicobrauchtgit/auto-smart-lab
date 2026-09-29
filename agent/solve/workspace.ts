/**
 * Prepare the run workspace for one solve invocation.
 *
 * The agent receives the dataset zips unmodified. Only the labels file is
 * filtered: the sealed rows are absent from it, so the confirmation split cannot
 * be scored locally and the gap the stage reports stays meaningful. That is a
 * withheld measurement, not a hidden one -- the prompt says so plainly.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, relative } from "node:path";

import { parseTrainingLabels, TRAINING_LABEL_FILES } from "../research/startup_context.js";
import { PROJECT_ROOT, resolveTask } from "../pipeline/resolve_task.js";
import type { StageArtifact } from "../pipeline/types.js";
import { recommendFolds, sealConfirmationSet, type FoldRecommendation, type SealedSplit } from "./folds.js";

export interface SolveWorkspace {
	root: string;
	/** Where the agent's code lives; shared across tasks and runs. */
	solutionsRoot: string;
	entrypointPath: string;
	taskPath: string;
	researchDir: string;
	/** Development labels only: the sealed rows are not in this file. */
	devLabelsPath: string;
	/** Every training label, including the held-out rows. Harness-only. */
	fullLabelsPath: string;
	/** The archive the agent is given: development rows only. */
	devZip: string;
	sealedPath: string;
	trainZip: string;
	datasetPaths: string[];
	split: SealedSplit;
	recommendation: FoldRecommendation;
	rowCount: number;
	classBalance: string;
	researchState: string;
	researchDocumentSha256?: string;
	/** Where a previous run's outputs were moved, when this run displaced any. */
	archivedPrevious?: string;
}

/**
 * What one run leaves in the workspace that the next must not inherit.
 *
 * The evaluator reads these files by name. A run whose agent writes nothing
 * would otherwise be graded on the previous run's results -- and, if those
 * happened to comply, promoted as champion on work it never did.
 */
export const RUN_OUTPUTS = [
	"metrics.json",
	"oof_predictions.csv",
	"confirmation_predictions.csv",
	"curves.json",
	"notes.md",
	"iterations.jsonl",
] as const;

/**
 * Move a previous run's outputs aside so this run starts from an empty contract.
 *
 * Moved rather than deleted: the trace is the durable record, but the files a
 * run produced are worth one generation of retention, and a stale set that
 * silently grades as the current one is the failure being prevented here.
 */
export function archivePreviousRun(root: string): string | undefined {
	const files = RUN_OUTPUTS.filter((name) => existsSync(join(root, name)));
	const snapshots = existsSync(join(root, "iterations"));
	if (files.length === 0 && !snapshots) return undefined;

	const previous = join(root, "previous");
	rmSync(previous, { recursive: true, force: true });
	mkdirSync(previous, { recursive: true });
	for (const name of files) renameSync(join(root, name), join(previous, name));
	if (snapshots) renameSync(join(root, "iterations"), join(previous, "iterations"));
	return previous;
}

export interface PrepareOptions {
	sealedFraction?: number;
	seed?: number;
	upstream?: StageArtifact[];
	projectRoot?: string;
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

export function resolveLabelsFile(taskId: string, dataDir: string): string {
	const name = TRAINING_LABEL_FILES[taskId];
	if (!name) throw new Error(`No training labels adapter for task "${taskId}"; add one to TRAINING_LABEL_FILES`);
	const path = join(dataDir, name);
	if (!existsSync(path)) throw new Error(`Training labels file is missing: ${path}`);
	return path;
}

export function prepareSolveWorkspace(taskId: string, options: PrepareOptions = {}): SolveWorkspace {
	const projectRoot = options.projectRoot ?? PROJECT_ROOT;
	const task = resolveTask({ taskId });
	const dataDir = join(task.taskDir, "data");
	const fullLabelsPath = resolveLabelsFile(taskId, dataDir);

	const parsed = parseTrainingLabels(readFileSync(fullLabelsPath));
	if (!parsed.ok) throw new Error(`Cannot read training labels: ${parsed.error}`);
	const split = sealConfirmationSet(parsed.rows, { fraction: options.sealedFraction, seed: options.seed });

	const root = join(projectRoot, "runs", taskId, "solve");
	const dataOut = join(root, "data");
	const researchDir = join(root, "research");
	mkdirSync(root, { recursive: true });
	// Before anything is recreated, so the sweep sees the previous run intact.
	const archivedPrevious = archivePreviousRun(root);
	for (const directory of [dataOut, researchDir, join(root, "iterations")]) {
		mkdirSync(directory, { recursive: true });
	}
	const { solutionsRoot, entrypointPath } = prepareSolutionsWorkspace(projectRoot, taskId);

	const taskPath = join(root, "task.md");
	const prompt = readFileSync(join(task.taskDir, "prompt.md"), "utf8");
	writeFileSync(taskPath, prompt.endsWith("\n") ? prompt : `${prompt}\n`);

	const devLabelsPath = join(dataOut, `${basename(fullLabelsPath)}`.replace(/\.labels$/, "-dev.labels"));
	writeFileSync(devLabelsPath, `${split.devRows.map((row) => `${row.id};${row.label}`).join("\n")}\n`);
	// Harness-only. The agent is never pointed at this and never needs it.
	const sealedPath = join(dataOut, "sealed_ids.txt");
	writeFileSync(sealedPath, `${split.sealedIds.join("\n")}\n`);

	const researchState = copyResearch(researchDir, taskId, options.upstream ?? [], projectRoot);

	const zips = ["train", "test"]
		.map((kind) => join(dataDir, `${basename(fullLabelsPath).replace(/-train\.labels$/, "")}-${kind}.zip`))
		.filter((path) => existsSync(path));
	const trainZip = zips.find((path) => path.endsWith("-train.zip"));
	if (!trainZip) throw new Error(`No training zip found in ${dataDir}`);
	const devZip = writeDevelopmentZip(trainZip, dataOut, split.devRows.map((row) => row.id));

	const counts = [0, 0];
	for (const row of split.devRows) counts[row.label]++;
	const total = split.devRows.length;

	return {
		root,
		solutionsRoot,
		entrypointPath,
		taskPath,
		researchDir,
		devLabelsPath,
		fullLabelsPath,
		sealedPath,
		trainZip,
		devZip,
		// What the agent is given: the development archive and the unlabelled test
		// set. The full training archive is withheld, because the held-out rows are
		// otherwise recoverable from it as `members - labels`, and their extensions
		// carry the labels.
		datasetPaths: [devZip, ...zips.filter((path) => path.endsWith("-test.zip"))]
			.map((path) => relative(projectRoot, path)),
		split,
		recommendation: recommendFolds(total),
		rowCount: total,
		classBalance: `class 0 ${counts[0]} (${((counts[0] / total) * 100).toFixed(2)}%), class 1 ${counts[1]} (${((counts[1] / total) * 100).toFixed(2)}%)`,
		researchState,
		researchDocumentSha256: options.upstream?.find((artifact) => artifact.kind === "research_document")?.sha256,
		...(archivedPrevious ? { archivedPrevious } : {}),
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
