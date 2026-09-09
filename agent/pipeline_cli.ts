#!/usr/bin/env bun
/**
 * Pipeline entry point.
 *
 * Usage:
 *   npm run pipeline -- unit 1 task 1
 *   npm run pipeline -- --unit 1 --task 1 --model saia/mistral-medium-3.5-128b
 *   npm run pipeline -- spam1
 *
 * With only the research stage enabled, the run resolves the task, runs research
 * with observability attached, and stops once research.md passes validation.
 */

import { runPipeline } from "./pipeline/executor.js";
import { loadResolvedPipelineConfig } from "./pipeline/config.js";
import { listTasks, resolveTask, TaskNotFoundError, type TaskRef } from "./pipeline/resolve_task.js";
import type { StageName } from "./pipeline/types.js";

function usage(): never {
	console.error(`Usage: npm run pipeline -- [unit <unit>] [task <task>] | <task_id> [options]

Selecting a task:
  unit 1 task 1              unit and task numbers from the fetched unit metadata
  --unit 1 --task 1          same, as flags
  1 1                        positional unit and task numbers
  spam1                      a canonical task ID

Options:
  --model <provider/model>   override the configured model
  --no-startup-context       do not inject the training-label profile
  --stage <name>             start at this stage instead of the configured entry
  --stop-after <name>        stop after this stage
  --no-fetch                 do not download a missing unit
  --secure-tls               verify TLS when fetching a unit
  --echo-events              print every recorded trace event
  --dry-run                  resolve the task and print the plan only
  --list                     list locally available units and tasks`);
	process.exit(1);
}

const args = process.argv.slice(2);

function takeFlag(flag: string): boolean {
	const index = args.indexOf(flag);
	if (index < 0) return false;
	args.splice(index, 1);
	return true;
}

function takeOption(flag: string): string | undefined {
	const index = args.indexOf(flag);
	if (index < 0) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("--")) usage();
	args.splice(index, 2);
	return value;
}

function printTasks(tasks: TaskRef[]): void {
	if (tasks.length === 0) {
		console.log("No local units. Run: npm run fetch-unit -- <unit>");
		return;
	}
	for (const task of tasks) {
		const data = task.hasData ? "" : "  (no local dataset)";
		console.log(`unit ${task.unitNumber ?? "?"} task ${task.taskNumber ?? "?"}  ${task.taskId.padEnd(8)} ${task.taskTitle}${data}`);
	}
}

async function main(): Promise<void> {
	if (takeFlag("--help") || takeFlag("-h")) usage();
	if (takeFlag("--list")) {
		printTasks(listTasks());
		return;
	}

	const injectStartupContext = !takeFlag("--no-startup-context");
	const autoFetch = !takeFlag("--no-fetch");
	const secureTls = takeFlag("--secure-tls");
	const echoEvents = takeFlag("--echo-events");
	const dryRun = takeFlag("--dry-run");
	const model = takeOption("--model");
	const entryStage = takeOption("--stage") as StageName | undefined;
	const stopAfter = takeOption("--stop-after") as StageName | undefined;

	let unit = takeOption("--unit");
	let task = takeOption("--task");

	// Positional forms: `unit 1 task 1`, `1 1`, or a canonical task ID.
	const positional: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const value = args[index];
		if (value.startsWith("-")) usage();
		if (value === "unit" || value === "u") {
			unit = args[++index] ?? usage();
			continue;
		}
		if (value === "task" || value === "t") {
			task = args[++index] ?? usage();
			continue;
		}
		positional.push(value);
	}
	let taskId: string | undefined;
	if (positional.length === 2 && unit === undefined && task === undefined) {
		[unit, task] = positional;
	} else if (positional.length === 1 && unit !== undefined && task === undefined) {
		task = positional[0];
	} else if (positional.length === 1 && unit === undefined && task === undefined) {
		taskId = positional[0];
	} else if (positional.length > 0) {
		// Anything left over means the selection is not the one the caller wrote.
		console.error(`Unexpected argument(s): ${positional.join(" ")}`);
		usage();
	}
	if (unit === undefined && task === undefined && taskId === undefined) usage();

	const selector = { unit, task, taskId };
	let resolvedTask: TaskRef;
	try {
		resolvedTask = resolveTask(selector);
	} catch (error) {
		// An ambiguous selection is a caller mistake, not a missing unit: fetching
		// here would download whatever unit the fetcher makes of the query.
		if (!(error instanceof TaskNotFoundError) || error.reason !== "not_found" || !unit || !autoFetch) throw error;
		console.log(`[pipeline] No local metadata for unit ${unit}; fetching it.`);
		const { fetchUnit } = await import("./setup/fetch_unit.js");
		await fetchUnit(unit, { insecure: !secureTls });
		resolvedTask = resolveTask(selector);
	}

	console.log(`[pipeline] Task ${resolvedTask.taskId}: ${resolvedTask.taskTitle}`);
	console.log(`[pipeline] Unit ${resolvedTask.unitNumber ?? "?"} (${resolvedTask.unitSlug}), task ${resolvedTask.taskNumber ?? "?"}`);

	if (dryRun) {
		const { resolved } = await loadResolvedPipelineConfig();
		console.log(`[pipeline] Entry stage: ${entryStage ?? resolved.settings.entryStage}`);
		console.log(`[pipeline] Enabled stages: ${resolved.enabledStages.join(", ")}`);
		console.log(`[pipeline] Config fingerprint: ${resolved.fingerprint.slice(0, 16)}`);
		console.log(`[pipeline] Effective options: ${JSON.stringify(resolved.effectiveOptions)}`);
		return;
	}

	const controller = new AbortController();
	const cancel = () => {
		console.warn("\n[pipeline] Cancelling after the current stage step.");
		controller.abort();
	};
	process.once("SIGINT", cancel);
	process.once("SIGTERM", cancel);

	const result = await runPipeline({
		taskId: resolvedTask.taskId,
		model,
		entryStage,
		stopAfter,
		signal: controller.signal,
		echoEvents,
		optionOverrides: injectStartupContext ? undefined : { research: { injectStartupContext: false } },
		invokedBy: { kind: "cli", command: "pipeline", selector },
	});

	console.log(`\n[pipeline] Run ${result.pipelineRunId}`);
	for (const invocation of result.invocations) {
		const detail = invocation.error ? ` — ${invocation.error}` : "";
		console.log(`[pipeline]   ${invocation.stage}: ${invocation.outcome} (${invocation.attempts} agent attempt(s))${detail}`);
		for (const artifact of invocation.artifacts) console.log(`[pipeline]     ${artifact.kind}: ${artifact.path}`);
	}
	console.log(`[pipeline] Outcome: ${result.outcome} — ${result.stoppedBecause}`);
	console.log(`[pipeline] Trace: ${result.localTracePath}`);
	if (result.traceDegraded) {
		console.warn(`[pipeline] Trace is incomplete: ${result.traceFailures.join("; ") || "database unavailable"}`);
	}
	if (result.outcome !== "success") process.exitCode = 1;
}

main().catch((error) => {
	console.error("[pipeline] Fatal error:", error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
