/**
 * Resolve human pipeline arguments ("unit 1 task 1") to a canonical task ID.
 *
 * Unit and task numbers come from the metadata written by the unit fetcher, so the
 * pipeline never depends on directory ordering.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, "..", "..");
const UNITS_DIR = join(PROJECT_ROOT, "units");

export interface TaskRef {
	taskId: string;
	taskTitle: string;
	taskSlug: string;
	taskNumber?: number;
	taskDir: string;
	unitTitle: string;
	unitSlug: string;
	unitNumber?: number;
	url?: string;
	hasData: boolean;
}

interface TaskMeta {
	unit?: string;
	unit_slug?: string;
	task?: string;
	task_slug?: string;
	url?: string;
	task_number?: number;
	short_id?: string;
}

function unitNumberOf(unitSlug: string): number | undefined {
	const match = unitSlug.match(/^(\d+)/);
	return match ? Number(match[1]) : undefined;
}

export function listTasks(): TaskRef[] {
	if (!existsSync(UNITS_DIR)) return [];
	const tasks: TaskRef[] = [];
	for (const unit of readdirSync(UNITS_DIR).sort()) {
		const unitDir = join(UNITS_DIR, unit);
		if (!statSync(unitDir).isDirectory()) continue;
		for (const task of readdirSync(unitDir).sort()) {
			const taskDir = join(unitDir, task);
			const metaPath = join(taskDir, "meta.json");
			if (!existsSync(metaPath)) continue;
			let meta: TaskMeta;
			try {
				meta = JSON.parse(readFileSync(metaPath, "utf8")) as TaskMeta;
			} catch {
				continue;
			}
			if (!meta.short_id) continue;
			const unitSlug = meta.unit_slug ?? unit;
			const dataDir = join(taskDir, "data");
			tasks.push({
				taskId: meta.short_id,
				taskTitle: meta.task ?? task,
				taskSlug: meta.task_slug ?? task,
				taskNumber: meta.task_number,
				taskDir,
				unitTitle: meta.unit ?? unitSlug,
				unitSlug,
				unitNumber: unitNumberOf(unitSlug),
				url: meta.url,
				hasData: existsSync(dataDir) && readdirSync(dataDir).length > 0,
			});
		}
	}
	return tasks;
}

function matchesUnit(task: TaskRef, unit: string): boolean {
	const query = unit.toLowerCase().replace(/\/$/, "");
	if (/^\d+$/.test(query)) return task.unitNumber === Number(query);
	return task.unitSlug.toLowerCase() === query
		|| task.unitSlug.toLowerCase().includes(query)
		|| task.unitTitle.toLowerCase().includes(query);
}

function matchesTask(task: TaskRef, selector: string): boolean {
	const query = selector.toLowerCase();
	if (/^\d+$/.test(query)) return task.taskNumber === Number(query);
	return task.taskId.toLowerCase() === query
		|| task.taskSlug.toLowerCase() === query
		|| task.taskSlug.toLowerCase().includes(query)
		|| task.taskTitle.toLowerCase().includes(query);
}

export interface TaskSelector {
	unit?: string;
	task?: string;
	/** A canonical short ID such as `spam1`, used when no unit/task pair is given. */
	taskId?: string;
}

export class TaskNotFoundError extends Error {
	constructor(
		message: string,
		/** Whether nothing matched, or the selection matched several tasks. */
		readonly reason: "not_found" | "ambiguous",
		readonly selector: TaskSelector,
		readonly known: TaskRef[],
	) {
		super(message);
		this.name = "TaskNotFoundError";
	}
}

function describe(tasks: TaskRef[]): string {
	if (tasks.length === 0) return "no local units; run `npm run fetch-unit -- <unit>` first";
	return tasks
		.map((task) => `unit ${task.unitNumber ?? "?"} task ${task.taskNumber ?? "?"} → ${task.taskId} (${task.taskTitle})`)
		.join("\n  ");
}

export function resolveTask(selector: TaskSelector, tasks = listTasks()): TaskRef {
	let candidates = tasks;
	if (selector.taskId) {
		// An exact ID only wins on its own: a unit or task selector must still be
		// honoured rather than silently discarded.
		if (!selector.unit && !selector.task) {
			const direct = candidates.filter((task) => task.taskId.toLowerCase() === selector.taskId?.toLowerCase());
			if (direct.length === 1) return direct[0];
		}
		candidates = candidates.filter((task) => matchesTask(task, selector.taskId as string));
	}
	if (selector.unit) candidates = candidates.filter((task) => matchesUnit(task, selector.unit as string));
	if (selector.task) candidates = candidates.filter((task) => matchesTask(task, selector.task as string));

	if (candidates.length === 1) return candidates[0];
	const wanted = [
		selector.unit ? `unit ${selector.unit}` : undefined,
		selector.task ? `task ${selector.task}` : undefined,
		selector.taskId,
	].filter(Boolean).join(" ");
	if (candidates.length === 0) {
		throw new TaskNotFoundError(
			`No local task matches ${wanted}.\n  Known tasks:\n  ${describe(tasks)}`,
			"not_found",
			selector,
			tasks,
		);
	}
	throw new TaskNotFoundError(
		`${wanted} is ambiguous; it matches ${candidates.map((task) => task.taskId).join(", ")}`,
		"ambiguous",
		selector,
		tasks,
	);
}
