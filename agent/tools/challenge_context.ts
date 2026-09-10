/**
 * Challenge context tools for the SmartLab ML agent.
 *
 * Exposes two pi tools:
 *   list_challenges  – enumerate all available challenges from the challenge store
 *   read_challenge   – read the full prompt and unit intro for a specific task
 *
 * Reads directly from units/ — never touches environment/.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", ".."); // agent/tools/ → agent/ → <root>
const CHALLENGES_DIR = join(PROJECT_ROOT, "units");
const REPORTS_DIR = join(PROJECT_ROOT, "reports");

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

interface ChallengeEntry {
	unit: string;
	task_path: string;
	/** Short task id from meta.json (e.g. "spam1"), as used by the orchestrator. */
	short_id?: string;
	prompt_preview: string;
}

function readMeta(taskDir: string): { short_id?: string } {
	try {
		return JSON.parse(readFileSync(join(taskDir, "meta.json"), "utf8")) as { short_id?: string };
	} catch {
		return {};
	}
}

/**
 * Resolve a task reference to a directory under units/.
 * Accepts either a short id ("spam1") or a "<unit>/<task>" path.
 */
function resolveTaskDir(ref: string): string | undefined {
	const direct = join(CHALLENGES_DIR, ref);
	if (existsSync(join(direct, "prompt.md"))) return direct;
	for (const c of collectChallenges()) {
		if (c.short_id === ref) return join(CHALLENGES_DIR, c.task_path);
	}
	return undefined;
}

interface LabInventoryTask {
	page_url?: string;
	downloads?: string[];
}

type LabInventory = Record<string, LabInventoryTask>;

function safeRead(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function collectChallenges(): ChallengeEntry[] {
	if (!existsSync(CHALLENGES_DIR)) return [];

	const entries: ChallengeEntry[] = [];
	const units = readdirSync(CHALLENGES_DIR).filter((name) => {
		const full = join(CHALLENGES_DIR, name);
		return statSync(full).isDirectory() && !name.startsWith(".");
	});

	for (const unit of units) {
		const unitDir = join(CHALLENGES_DIR, unit);
		const tasks = readdirSync(unitDir).filter((name) => {
			const full = join(unitDir, name);
			return statSync(full).isDirectory() && !name.startsWith(".");
		});

		for (const task of tasks) {
			const promptPath = join(unitDir, task, "prompt.md");
			if (!existsSync(promptPath)) continue;
			const promptText = safeRead(promptPath);
			const preview = promptText.slice(0, 200).replace(/\n+/g, " ").trim();
			const meta = readMeta(join(unitDir, task));
			entries.push({
				unit,
				task_path: `${unit}/${task}`,
				...(meta.short_id ? { short_id: meta.short_id } : {}),
				prompt_preview: preview,
			});
		}
	}

	return entries;
}

function loadInventory(): LabInventory {
	const inventoryPath = join(REPORTS_DIR, "lab_data_inventory.json");
	if (!existsSync(inventoryPath)) return {};
	try {
		return JSON.parse(readFileSync(inventoryPath, "utf8")) as LabInventory;
	} catch {
		return {};
	}
}

// --------------------------------------------------------------------------
// Extension
// --------------------------------------------------------------------------

export default function challengeContextExtension(pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "list_challenges",
			label: "Challenges: list",
			description:
				"List all available ML challenges from the challenge store. Returns unit, task path, short_id (e.g. 'spam1'), and a brief prompt preview for each task.",
			promptSnippet: "List available SmartLab challenges",
			promptGuidelines: [
				"Use list_challenges to discover what tasks are available before starting work.",
			],
			parameters: Type.Object({}),
			async execute(_toolCallId, _params, _signal) {
				const challenges = collectChallenges();
				const inventory = loadInventory();

				const enriched = challenges.map((c) => {
					const inv = inventory[c.task_path] ?? {};
					return {
						...c,
						page_url: inv.page_url,
						downloads: inv.downloads,
					};
				});

				return {
					content: [{ type: "text", text: JSON.stringify(enriched, null, 2) }],
					details: { challenges: enriched } as unknown as Record<string, unknown>,
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "read_challenge",
			label: "Challenges: read",
			description:
				"Read the full task prompt and unit introduction for a specific challenge. Pass the short task id (e.g. 'spam1') or the task_path returned by list_challenges.",
			promptSnippet: "Read a SmartLab challenge prompt",
			promptGuidelines: [
				"Use read_challenge at the start of a solve session to understand the task requirements, input format, and evaluation metric.",
			],
			parameters: Type.Object({
				task_path: Type.String({
					description: "Short task id (e.g. 'spam1') or task path (e.g. 'introduction-with-spam/spam-detection-with-machine-learning-50-points') as returned by list_challenges",
				}),
			}),
			async execute(_toolCallId, params, _signal) {
				const taskDir = resolveTaskDir(params.task_path);
				if (!taskDir) {
					return {
						content: [{ type: "text", text: `Challenge not found: ${params.task_path}. Call list_challenges to see valid ids.` }],
						details: {},
					};
				}

				const promptText = safeRead(join(taskDir, "prompt.md"));
				const unitIntroText = safeRead(join(dirname(taskDir), "unit-intro.md"));
				const dataDir = join(taskDir, "data");
				const dataFiles = existsSync(dataDir)
					? readdirSync(dataDir).filter((f) => !f.startsWith(".")).map((f) => join(dataDir, f))
					: [];

				const result = {
					task_path: taskDir.slice(CHALLENGES_DIR.length + 1),
					short_id: readMeta(taskDir).short_id ?? null,
					data_dir: existsSync(dataDir) ? dataDir : null,
					data_files: dataFiles,
					unit_intro: unitIntroText || null,
					prompt: promptText || null,
				};

				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result as unknown as Record<string, unknown>,
				};
			},
		}),
	);
}
