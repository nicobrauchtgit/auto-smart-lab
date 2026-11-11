/**
 * Prepare the run workspace for one solve invocation.
 *
 * Every task kind gets the same minimally prepared input: a development
 * archive/capture and a sample manifest of opaque descriptors.
 * ZIP members stay unread; PCAP headers supply only TCP connection identity and
 * packet pointers. The agent reads the bytes and chooses parsing/features (D9). The task configuration selects the targets (binary
 * labels, families or none) and the sealed split: stratified rows, whole
 * families, or nothing when there are no targets to confirm against. Sealed
 * rows are absent from everything the agent is pointed at, so the confirmation
 * split cannot be scored locally.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync, statfsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join, relative, dirname } from "node:path";

import { PROJECT_ROOT, resolveTask } from "../pipeline/resolve_task.js";
import { projectPython, resolveTaskConfiguration, TASK_SAMPLES_SCRIPT, taskDataPaths, type TaskConfiguration } from "../pipeline/task_configuration.js";
import type { MeasurementConfig } from "../training/types.js";
import { createHash } from "node:crypto";
import { createSeedPlan, type SeedPlan } from "../training/seeds.js";
import { HARNESS_CONFIG } from "../harness/config.js";
import { noSeal, recommendFolds, sealConfirmationSet, sealGroups, type FoldRecommendation, type IdSealedSplit, type HoldoutPolicy, type HoldoutMetadata } from "./folds.js";
import { claimWorkspace, atomicJson } from "../experiments/ownership.js";
import { ensureSolutionsRepository } from "../training/git.js";
import { canonical } from "../training/terminal.js";
import { statePath } from "../paths.js";

export interface SolveWorkspace {
	root: string;
	/** Where the agent's code lives; shared across tasks and runs. */
	solutionsRoot: string;
	entrypointPath: string;
	taskPath: string;
	configuration: TaskConfiguration;
	/** The development manifest the training harness measures: descriptors and targets, no sealed rows. */
	sampleManifestPath: string;
	/** Controller measurement declaration for the training harness. */
	measurement: MeasurementConfig;
	/** The archive the agent is given: development rows only. */
	devZip: string;
	sealedPath: string;
	originalTargetsPath?: string;
	holdoutSeedPlan?: SeedPlan;
	trainZip: string;
	testZip: string;
	datasetPaths: string[];
	split: { sealedIds: string[]; fraction: number; seed: number; sha256: string; scheme: "stratified" | "group" | "none"; sealedGroups?: number; confirmation?: HoldoutMetadata };
	recommendation: FoldRecommendation;
	rowCount: number;
	/** Where the development targets are, for the prompt. */
	targets: string;
	/** Class balance, family counts, or the absence of targets. */
	targetSummary: string;
}

export interface PrepareOptions {
	configuration?: TaskConfiguration;
	holdoutPolicy?: HoldoutPolicy;
	seed?: number;
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
	const solutionsRoot = statePath(projectRoot, "solutions");
	for (const directory of ["tasks", "lib/io", "lib/parse", "lib/features", "lib/models", "lib/cv", "checks/lib", `checks/${taskId}`, "docs", "scratch"]) mkdirSync(join(solutionsRoot, directory), { recursive: true });
 if (!existsSync(join(solutionsRoot, "INDEX.md"))) writeFileSync(join(solutionsRoot, "INDEX.md"), "# Shared modules\n\nRecord module path, purpose, owner role and importing tasks here.\n");
	// The agent reads this README; it lives with the harness code and is copied into the state folder.
	const readme = join(solutionsRoot, "README.md");
	copyFileSync(join(import.meta.dir, "solutions-README.md"), readme);
	ensureSolutionsRepository(solutionsRoot);
	return {
		solutionsRoot,
		entrypointPath: join(solutionsRoot, "tasks", `${taskId}.py`),
	};
}

/** Sample IDs and targets of one archive, read without opening sample content. */
export function archiveRows(pythonExecutable: string, zip: string, targetsPath?: string, targets: TaskConfiguration["targets"]["kind"] = "none", source: TaskConfiguration["samples"]["source"] = "zip_members"): { ids: string[]; targets: (string | number)[] | null; samples: { id: string; input: Record<string, unknown> }[] } {
	const output = execFileSync(pythonExecutable, [TASK_SAMPLES_SCRIPT, "--rows", JSON.stringify({ zip, targetsPath: targetsPath ?? null, targets, source, includeSamples: true })],
		{ encoding: "utf8", timeout: HARNESS_CONFIG.setup.timeoutMs * 4, maxBuffer: 256 * 1024 * 1024 });
	return JSON.parse(output);
}

function seal(configuration: TaskConfiguration, ids: string[], targets: Map<string, string | number>, options: PrepareOptions): IdSealedSplit | ReturnType<typeof stratifiedSeal> {
	const seed = options.seed ?? HARNESS_CONFIG.solve.seed;
	if (configuration.holdout === "stratified") return stratifiedSeal(ids, targets, options.holdoutPolicy, seed);
	if (configuration.holdout === "group") return sealGroups(ids.map(id => ({ id, group: String(targets.get(id)) })), { seed });
	return noSeal(ids, seed);
}

function stratifiedSeal(ids: string[], targets: Map<string, string | number>, policy: HoldoutPolicy | undefined, seed: number) {
	const split = sealConfirmationSet(ids.map(id => ({ id, label: targets.get(id) as 0 | 1 })), { policy, seed });
	return { scheme: "stratified" as const, sealedIds: split.sealedIds, devIds: split.devRows.map(row => row.id).sort(),
		sealedGroups: undefined, fraction: split.fraction, seed: split.seed, sha256: split.sha256,
        confirmation: { rows: split.rows, perClass: split.perClass, precision: split.precision, ...(split.reason ? { reason: split.reason } : {}) } };
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

const LEGACY_DEVELOPMENT_ROOT = "solve/data";

/**
 * The fields that define the split. Only holdout, targets, seed and archive
 * identity (bytes, membership and how rows are read) may force a reset;
 * metric, selection or measurement edits reuse the stored split.
 */
export function splitDeclaration(taskId: string, configuration: TaskConfiguration, originalDatasetHash: string, ids: readonly string[], options: PrepareOptions) {
 return { taskId, originalDatasetHash,
  archiveMembership: createHash("sha256").update(JSON.stringify([...ids].sort())).digest("hex"),
  samples: configuration.samples.source, holdout: configuration.holdout, targets: configuration.targets,
  rootSeed: options.seed ?? HARNESS_CONFIG.solve.seed, policy: options.holdoutPolicy ?? HARNESS_CONFIG.holdout };
}

function hashFile(path: string): ReturnType<typeof createHash> {
 const hash = createHash("sha256"), fd = openSync(path, "r"), buffer = Buffer.alloc(1024 * 1024);
 try { let count; while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count)); }
 finally { closeSync(fd); }
 return hash;
}

export function prepareSolveWorkspace(taskId: string, options: PrepareOptions = {}): SolveWorkspace {
	const configuration = resolveTaskConfiguration(taskId, options.configuration).configuration;
	const projectRoot = options.projectRoot ?? PROJECT_ROOT;
	const taskDir = options.taskDir ?? resolveTask({ taskId }).taskDir;
	const paths = taskDataPaths(taskId, configuration, taskDir);
	const python = options.pythonExecutable ?? projectPython();
	const train = archiveRows(python, paths.trainZip, paths.targetsPath, configuration.targets.kind, configuration.samples.source);
	const targets = new Map<string, string | number>(train.targets ? train.ids.map((id, index) => [id, train.targets![index]]) : []);
	const originalDatasetHash = hashFile(paths.trainZip)
        .update(JSON.stringify([...targets.entries()].sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
    const holdoutSeedPlan = createSeedPlan({ rootSeed: options.seed ?? HARNESS_CONFIG.solve.seed,
        taskId, datasetSha256: originalDatasetHash, experimentId: "holdout-split" });
    const dataRoot = statePath(projectRoot, taskId, "data");
    const sealedRoot = join(dataRoot, "sealed");
    mkdirSync(sealedRoot, { recursive: true });
    const release = claimWorkspace(sealedRoot);
    try {
    const declarationPath = join(sealedRoot, "split.json");
    const declaration = splitDeclaration(taskId, configuration, originalDatasetHash, train.ids, options);
    let split: ReturnType<typeof seal>;
    // Where agent-visible development data live, relative to the task state.
    let developmentRoot = "data";
    let freshSplit = false;
    if (existsSync(declarationPath)) {
        let stored;
        try { stored = JSON.parse(readFileSync(declarationPath, "utf8")); } catch { throw new Error("Corrupt task split; repair task state, never redraw it"); }
        if (stored.sha256 !== createHash("sha256").update(JSON.stringify(stored.split)).digest("hex")) throw new Error("Corrupt task split hash; repair task state");
        if (!stored.split?.devIds || !stored.split?.sealedIds || !stored.declaration) throw new Error("Incomplete task split; repair task state");
        const differences = Object.keys(declaration).filter(key => canonical(stored.declaration[key]) !== canonical(declaration[key as keyof typeof declaration]));
        if (differences.length) throw new Error(`Task split declaration changed: ${differences.join(", ")}; previously exposed rows must not become sealed. Explicit task-state reset required.`);
        split = stored.split;
        developmentRoot = stored.developmentRoot ?? developmentRoot;
    } else {
        const disk = statfsSync(dataRoot);
        if (disk.bavail * disk.bsize < 1.2 * statSync(paths.trainZip).size + 1_000_000_000) throw new Error("Task preparation requires 1.2 times the archive plus 1 GB free disk space");
        split = seal(configuration, train.ids, targets, { ...options, seed: holdoutSeedPlan.sealedSeed });
        const legacyPath = statePath(projectRoot, taskId, "solve", "data", "holdout.json");
        if (existsSync(legacyPath)) {
            let legacy;
            try { legacy = JSON.parse(readFileSync(legacyPath, "utf8")); } catch { throw new Error("Corrupt legacy task split; repair before migration"); }
            if (legacy.holdoutSeedPlan?.datasetSha256 !== originalDatasetHash
                || legacy.holdoutSeedPlan?.rootSeed !== holdoutSeedPlan.rootSeed
                || canonical(legacy.sealedIds) !== canonical(split.sealedIds) || legacy.sha256 !== split.sha256)
                throw new Error("Legacy exposed task data conflicts with this split declaration; explicit task-state migration required");
            // Trials, champions and confirmations recorded the legacy development
            // archive and manifest by absolute path and byte hash. Keep serving
            // them from there so refit and recovery reread identical bytes.
            if (existsSync(join(dirname(legacyPath), "development-samples.json"))) developmentRoot = LEGACY_DEVELOPMENT_ROOT;
        }
        freshSplit = developmentRoot === "data";
        atomicJson(declarationPath, { declaration, split, developmentRoot, sha256: createHash("sha256").update(JSON.stringify(split)).digest("hex") });
    }

    const retainedPath = join(sealedRoot, "task-data.json");
    if (existsSync(retainedPath)) {
        let retained;
        try { retained = JSON.parse(readFileSync(retainedPath, "utf8")); } catch { throw new Error("Corrupt task data record; repair before resuming"); }
        for (const [path, expected] of Object.entries(retained.materializedHashes ?? {})) {
            if (existsSync(path) && hashFile(path).digest("hex") !== expected) throw new Error("Retained task inputs changed; repair their measured bytes before resuming");
        }
    }
	const root = statePath(projectRoot, taskId, "solve");
	if (![LEGACY_DEVELOPMENT_ROOT, "data"].includes(developmentRoot)) throw new Error("Corrupt development data location in task split; repair task state");
	const dataOut = statePath(projectRoot, taskId, ...developmentRoot.split("/"));
	for (const directory of [root, dataOut, ...(configuration.selection ? [join(root, "agent")] : [])]) mkdirSync(directory, { recursive: true });
	const { solutionsRoot, entrypointPath } = prepareSolutionsWorkspace(projectRoot, taskId);
	const taskPath = join(root, "task.md");
	const intro = join(dirname(taskDir), "unit-intro.md");
	const prompt = (existsSync(intro) ? `${readFileSync(intro, "utf8")}\n\n` : "") + readFileSync(join(taskDir, "prompt.md"), "utf8");
	writeFileSync(taskPath, prompt.endsWith("\n") ? prompt : `${prompt}\n`);
	// Harness-only. The agent is never pointed at this and never needs it.
	const sealedPath = join(sealedRoot, "sealed_ids.txt");
	writeFileSync(sealedPath, split.sealedIds.length ? `${split.sealedIds.join("\n")}\n` : "");
    writeFileSync(join(sealedRoot, "holdout.json"), JSON.stringify({ ...split, devIds: undefined, holdoutSeedPlan }) + "\n");
	const devZip = configuration.samples.source === "zip_members"
        ? writeDevelopmentZip(python, paths.trainZip, dataOut, split.devIds)
        : join(dataOut, `development-${basename(paths.trainZip)}`);
    if (configuration.samples.source === "pcap_tcp_connections") copyFileSync(paths.trainZip, devZip);
    const descriptors = new Map(train.samples.map(sample => [sample.id, sample.input]));

	// Opaque descriptors: the agent's code opens the archive member itself.
	const sampleManifestPath = join(dataOut, "development-samples.json");
	const manifestBytes = `${JSON.stringify({ schemaVersion: 1, samples: split.devIds.map(id => ({
		id, input: configuration.samples.source === "zip_members" ? { archive: devZip, member: id } : { ...descriptors.get(id), pcap: devZip }, ...(targets.size ? { target: targets.get(id)! } : {}),
	})) })}\n`;
	// Measured trials hash these bytes; never rewrite a manifest they may have
	// read. Only a newly declared split (after an explicit reset) replaces one.
	if (!existsSync(sampleManifestPath) || (freshSplit && readFileSync(sampleManifestPath, "utf8") !== manifestBytes)) {
		const temporary = `${sampleManifestPath}.${process.pid}.tmp`;
		writeFileSync(temporary, manifestBytes);
		renameSync(temporary, sampleManifestPath);
	}
	else if (readFileSync(sampleManifestPath, "utf8") !== manifestBytes) throw new Error(`Development manifest ${sampleManifestPath} differs from the stored split; restore it or reset task state explicitly`);
	const measurement: MeasurementConfig = configuration.kind === "binary_classification"
		? { kind: "classification", execution: "inductive", sampleManifestPath }
		: configuration.kind === "clustering"
			? { kind: "clustering", execution: configuration.execution, sampleManifestPath }
			: { kind: "anomaly_detection", execution: configuration.execution, sampleManifestPath, ...configuration.anomaly!, ...(configuration.selection ? { selection: configuration.selection, evidence: { path: join(root, "agent", "evidence.json"), source: "agent_provided" as const } } : {}) };
	const described = describeTargets(configuration, split.devIds, targets, relative(projectRoot, sampleManifestPath), split.sealedGroups);
	const groups = configuration.targets.kind === "families" ? new Set(split.devIds.map(id => targets.get(id))).size : undefined;
	const profilePath = join(dataOut, "profile.json");
    atomicJson(profilePath, { taskId, rowCount: split.devIds.length, targetSummary: described.summary, samples: configuration.samples.source });
    const datasetSha256 = hashFile(devZip).update(readFileSync(sampleManifestPath)).digest("hex");
    const workspace = { taskId, profilePath, datasetSha256,
        materializedHashes: { [devZip]: hashFile(devZip).digest("hex"), [sampleManifestPath]: hashFile(sampleManifestPath).digest("hex") },
        developmentArchive: devZip, developmentManifest: sampleManifestPath, testArchive: paths.testZip, originalTrainingPath: paths.trainZip,
		root, solutionsRoot, entrypointPath, taskPath, configuration,
        originalTargetsPath: paths.targetsPath, holdoutSeedPlan,
		sampleManifestPath, measurement,
		devZip, sealedPath, trainZip: paths.trainZip, testZip: paths.testZip,
		// What the agent is given: the development archive and the unlabelled test
		// set. The full training archive is withheld, because the held-out rows are
		// otherwise recoverable from it as `members - manifest`.
		datasetPaths: [devZip, ...(existsSync(paths.testZip) ? [paths.testZip] : [])].map(path => relative(projectRoot, path)),
		split: { sealedIds: split.sealedIds, fraction: split.fraction, seed: split.seed, sha256: split.sha256, scheme: split.scheme, ...("confirmation" in split ? { confirmation: split.confirmation } : {}), ...(split.sealedGroups !== undefined ? { sealedGroups: split.sealedGroups } : {}) },
		recommendation: configuration.holdout === "stratified" ? recommendFolds(split.devIds.length)
			: groups ? recommendFolds(split.devIds.length, { scheme: "group_kfold", groups })
				: recommendFolds(split.devIds.length, { scheme: "kfold" }),
		rowCount: split.devIds.length,
		targets: described.targets,
		targetSummary: described.summary,
    } satisfies SolveWorkspace & { taskId: string; profilePath: string; datasetSha256: string; materializedHashes: Record<string, string>; developmentArchive: string; developmentManifest: string; testArchive: string; originalTrainingPath: string };
    atomicJson(join(sealedRoot, "task-data.json"), workspace);
    return workspace;
    } finally { release(); }
}

/**
 * Write an archive holding only the development rows.
 *
 * Withholding the held-out ids is not enough on its own: given the full training
 * archive and a development-only labels file, the held-out set is exactly
 * `members - labels`, and each id's extension states its label. The split is only
 * genuinely held out if its rows are absent from what the agent can read.
 */
function writeDevelopmentZip(python: string, trainZip: string, dataOut: string, devIds: readonly string[]): string {
	const target = join(dataOut, basename(trainZip).replace(/\.zip$/, "-dev.zip"));
	const listing = join(dataOut, "development_members.txt");
	writeFileSync(listing, `${devIds.join("\n")}\n`);
	if (existsSync(target)) {
		// A reset with a new seed or policy can leave an archive holding rows
		// that are now sealed; their file names state their labels. Reuse only
		// an archive whose members are exactly the current development rows.
		if (sameMembers(archiveMembers(python, target), devIds)) { rmSync(listing, { force: true }); return target; }
		rmSync(target);
	}
	const temporary = `${target}.tmp.zip`;
	rmSync(temporary, { force: true });
	// `zip --copy` transfers members between archives without inflating them.
	execFileSync("zip", ["--quiet", "--copy", trainZip, "--out", temporary, "--names-stdin"],
		{ input: `${devIds.join("\n")}\n`, maxBuffer: 64 * 1024 * 1024 });
	if (!sameMembers(archiveMembers(python, temporary), devIds)) { rmSync(temporary, { force: true }); throw new Error("Development archive membership differs from the development rows; refusing to expose it"); }
	renameSync(temporary, target);
	rmSync(listing, { force: true });
	return target;
}

/** File members of a ZIP archive, read from its central directory only. */
export function archiveMembers(python: string, zip: string): string[] {
	return JSON.parse(execFileSync(python, ["-I", "-c", "import json,sys,zipfile; print(json.dumps([i.filename for i in zipfile.ZipFile(sys.argv[1]).infolist() if not i.is_dir()]))", zip],
		{ encoding: "utf8", timeout: HARNESS_CONFIG.setup.timeoutMs * 4, maxBuffer: 256 * 1024 * 1024 }));
}

function sameMembers(members: readonly string[], devIds: readonly string[]): boolean {
	return members.length === devIds.length && canonical([...members].sort()) === canonical([...devIds].sort());
}

export { prepareModellingWorkspace } from "./task_data.js";
