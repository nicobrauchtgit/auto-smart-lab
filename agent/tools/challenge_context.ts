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
	prompt_preview: string;
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
			entries.push({
				unit,
				task_path: `${unit}/${task}`,
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
				"List all available ML challenges from the challenge store. Returns unit, task path, and a brief prompt preview for each task.",
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
				"Read the full task prompt and unit introduction for a specific challenge. Pass the task_path returned by list_challenges.",
			promptSnippet: "Read a SmartLab challenge prompt",
			promptGuidelines: [
				"Use read_challenge at the start of a solve session to understand the task requirements, input format, and evaluation metric.",
			],
			parameters: Type.Object({
				task_path: Type.String({
					description: "Task path, e.g. '01-spam/task1-spam-detection' (as returned by list_challenges)",
				}),
			}),
			async execute(_toolCallId, params, _signal) {
				const taskDir = join(CHALLENGES_DIR, params.task_path);
				if (!existsSync(taskDir)) {
					return {
						content: [{ type: "text", text: `Challenge not found: ${params.task_path}` }],
						details: {},
					};
				}

				const promptText = safeRead(join(taskDir, "prompt.md"));
				const parts = params.task_path.split("/");
				const unitIntroText = parts.length > 0
					? safeRead(join(CHALLENGES_DIR, parts[0], "unit-intro.md"))
					: "";

				const result = {
					task_path: params.task_path,
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
