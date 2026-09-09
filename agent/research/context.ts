import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeTrainingLabels, TRAINING_LABEL_FILES, type StartupProfile } from "./startup_context.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, "..", "..");
const UNITS_DIR = join(PROJECT_ROOT, "units");

export interface ResearchContext {
	schema_version: 1;
	generated_at: string;
	run_date: string;
	startup_profile?: StartupProfile;
	task: {
		id: string;
		title: string;
		unit: string;
		task_dir: string;
		prompt_file: "task.md";
	};
	dataset: {
		data_dir: string;
		total_files: number;
		total_bytes: number;
		file_types: Record<string, { files: number; bytes: number }>;
		primary_inputs: Array<{ path: string; bytes: number; sha256: string }>;
		snapshot_sha256: string;
	};
	limits: {
		web_search_calls: number;
		max_report_bytes: number;
		max_analysis_artifact_bytes: number;
		max_feature_recommendations: number;
	};
}

function localIsoDate(date: Date): string {
	const parts = new Intl.DateTimeFormat("en-GB", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
	return `${part("year")}-${part("month")}-${part("day")}`;
}

export interface ResearchContextInput {
	context: ResearchContext;
	prompt: string;
}

interface TaskLocation {
	dir: string;
	meta: { short_id?: string; task?: string; unit?: string };
}

function sha256(data: Buffer | string): string {
	return createHash("sha256").update(data).digest("hex");
}

function walkFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...walkFiles(path));
		else if (entry.isFile()) files.push(path);
	}
	return files;
}

function findTask(taskId: string): TaskLocation {
	for (const unit of readdirSync(UNITS_DIR).sort()) {
		const unitDir = join(UNITS_DIR, unit);
		if (!statSync(unitDir).isDirectory()) continue;
		for (const task of readdirSync(unitDir).sort()) {
			const dir = join(unitDir, task);
			const metaPath = join(dir, "meta.json");
			if (!existsSync(metaPath)) continue;
			const meta = JSON.parse(readFileSync(metaPath, "utf8")) as TaskLocation["meta"];
			if (meta.short_id === taskId) return { dir, meta };
		}
	}
	throw new Error(`No canonical task metadata found for ${taskId}; run the unit fetcher first`);
}

export function buildResearchContext(taskId: string): ResearchContextInput {
	const generatedAt = new Date();
	const task = findTask(taskId);
	const workspace = join(PROJECT_ROOT, "runs", taskId, "research");
	const prompt = readFileSync(join(task.dir, "prompt.md"), "utf8");
	const dataDir = join(task.dir, "data");
	const files = walkFiles(dataDir).sort();
	if (files.length === 0) throw new Error(`No local dataset found under ${dataDir}`);

	let totalBytes = 0;
	const fileTypes: ResearchContext["dataset"]["file_types"] = {};
	for (const path of files) {
		const bytes = statSync(path).size;
		totalBytes += bytes;
		const type = extname(path).toLowerCase() || "[no-extension]";
		const summary = fileTypes[type] ?? { files: 0, bytes: 0 };
		summary.files++;
		summary.bytes += bytes;
		fileTypes[type] = summary;
	}

	// Hash only the source archives and label/metadata files. Extracted corpora can
	// contain tens of thousands of files and are derived from these inputs.
	const primaryFiles = files.filter((path) => /\.(?:zip|labels|csv|json)$/i.test(path));
	const labelFilename = TRAINING_LABEL_FILES[taskId];
	const labelPath = labelFilename ? join(dataDir, labelFilename) : undefined;
	// Recognize only the explicit metric wording; unfamiliar metrics remain unknown.
	const metric = /\bbalanced\s+accuracy\b/i.test(prompt) ? "balanced_accuracy" as const : null;
	let startupProfile: StartupProfile = {
		schema_version: 1,
		status: "unavailable",
		metric,
		reason: labelFilename ? `Expected training labels file ${labelFilename} is unavailable.` : "No training-label adapter for this task.",
	};
	const primaryInputs = primaryFiles.map((path) => {
		const content = readFileSync(path);
		if (path === labelPath) startupProfile = summarizeTrainingLabels(content, relative(workspace, path), metric);
		return {
			path: relative(workspace, path),
			bytes: content.length,
			sha256: sha256(content),
		};
	});
	const snapshot = primaryInputs.map((item) => `${item.path}\0${item.bytes}\0${item.sha256}`).join("\n");

	return {
		prompt,
		context: {
			schema_version: 1,
			generated_at: generatedAt.toISOString(),
			run_date: localIsoDate(generatedAt),
			startup_profile: startupProfile,
			task: {
				id: taskId,
				title: task.meta.task ?? taskId,
				unit: task.meta.unit ?? "",
				task_dir: relative(workspace, task.dir),
				prompt_file: "task.md",
			},
			dataset: {
				data_dir: relative(workspace, dataDir),
				total_files: files.length,
				total_bytes: totalBytes,
				file_types: Object.fromEntries(Object.entries(fileTypes).sort(([a], [b]) => a.localeCompare(b))),
				primary_inputs: primaryInputs,
				snapshot_sha256: sha256(snapshot),
			},
			limits: {
				web_search_calls: 3,
				max_report_bytes: 40 * 1024,
				max_analysis_artifact_bytes: 64 * 1024,
				max_feature_recommendations: 10,
			},
		},
	};
}

export function researchContextHash(context: ResearchContext): string {
	return sha256(`${JSON.stringify(context, null, 2)}\n`);
}

export function writeResearchContext(taskId: string, context: ResearchContext): string {
	const outputDir = join(PROJECT_ROOT, "runs", taskId, "research");
	mkdirSync(outputDir, { recursive: true });
	const path = join(outputDir, "context.json");
	writeFileSync(path, `${JSON.stringify(context, null, 2)}\n`);
	return path;
}
