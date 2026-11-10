/**
 * Choose the experiment arm. Each arm keeps its own entry point and arguments:
 *
 *   ./dev bun run experiment -- --arm finetuned spam1 [pipeline arguments]
 *   ./dev bun run experiment -- --arm finetuned spam1 --detach [--resume <run-id>]
 *   ./dev bun run experiment -- --arm minimal --only spam1 [solve_units arguments]
 *   ./dev bun run experiment -- --arm minimal --check-setup
 *   ./dev bun run experiment -- --arm finetuned --reset --yes
 *
 * Online or offline, the provider and the model come from experiment.config.json for both arms.
 *
 * The minimal arm starts every run in a fresh directory under runs/minimal/.
 * The finetuned arm keeps state in runs/finetuned/; --reset clears it except deliveries/.
 * --detach starts a finetuned run in its own session, writes its output to
 * runs/finetuned/<task>/logs/<stamp>.log and returns; the run survives the shell.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMinimalSetup, createMinimalVenv, prepareMinimalRun, runMinimal } from "./minimal.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ARMS = ["finetuned", "minimal"] as const;
export type Arm = (typeof ARMS)[number];

export function parseExperimentArgs(argv: readonly string[]): { arm: Arm; reset: boolean; yes: boolean; checkSetup: boolean; detach: boolean; model?: string; rest: string[] } {
	const rest = [...argv];
	const take = (flag: string) => { const index = rest.indexOf(flag); if (index < 0) return false; rest.splice(index, 1); return true; };
	const armIndex = rest.indexOf("--arm");
	const arm = armIndex >= 0 ? rest[armIndex + 1] : undefined;
	if (!ARMS.includes(arm as Arm)) throw new Error(`Choose an arm: --arm ${ARMS.join("|")}`);
	rest.splice(armIndex, 2);
	const modelIndex = rest.indexOf("--model");
	const model = modelIndex >= 0 ? rest[modelIndex + 1] : undefined;
	return { arm: arm as Arm, reset: take("--reset"), yes: take("--yes"), checkSetup: take("--check-setup"), detach: take("--detach"), ...(model ? { model } : {}), rest };
}

/** What a finetuned reset removes: everything in runs/finetuned/ except the hand-over files. */
export function harnessStatePaths(projectRoot: string): string[] {
	const paths: string[] = [];
	const state = join(projectRoot, "runs", "finetuned");
	if (existsSync(state)) for (const name of readdirSync(state)) if (name !== "deliveries") paths.push(join(state, name));
	return paths;
}

/** Pipeline CLI options that take a value; everything else that is not a flag selects the task. */
const VALUE_OPTIONS = new Set(["--guidance", "--model", "--stage", "--stop-after", "--unit", "--task", "--resume"]);
/** The task selection in finetuned pipeline arguments, read the way pipeline_cli.ts reads it. */
export function taskSelection(rest: readonly string[]): { taskId?: string; unit?: string; task?: string } {
	const selection: { taskId?: string; unit?: string; task?: string } = {};
	const positional: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "--unit") selection.unit = rest[++i];
		else if (arg === "--task") selection.task = rest[++i];
		else if (VALUE_OPTIONS.has(arg)) i++;
		else if (arg.startsWith("-")) continue;
		else if (arg === "unit" || arg === "u") selection.unit = rest[++i];
		else if (arg === "task" || arg === "t") selection.task = rest[++i];
		else positional.push(arg);
	}
	if (positional.length === 2 && !selection.unit && !selection.task) [selection.unit, selection.task] = positional;
	else if (positional.length === 1 && selection.unit && !selection.task) selection.task = positional[0];
	else if (positional.length === 1 && !selection.unit && !selection.task) selection.taskId = positional[0];
	return selection;
}

export interface DetachedRun { pid: number; logPath: string }
/**
 * Start a command in its own session (setsid), detached from the launching
 * terminal, with stdout and stderr appended to the log. Hang-ups and the
 * shell's exit do not reach it; it is stopped with SIGINT to its PID.
 */
export function launchDetached(options: { command: string[]; logPath: string; cwd: string; env?: NodeJS.ProcessEnv }): DetachedRun {
	mkdirSync(dirname(options.logPath), { recursive: true });
	const log = openSync(options.logPath, "a");
	try {
		writeSync(log, `[experiment] ${new Date().toISOString()} detached: ${options.command.map(part => relative(options.cwd, part).startsWith("..") ? part : relative(options.cwd, part) || part).join(" ")}\n`);
		const child = spawn(options.command[0], options.command.slice(1), { cwd: options.cwd, env: options.env ?? process.env, detached: true, stdio: ["ignore", log, log] });
		if (child.pid === undefined) throw new Error("Detached run did not start");
		child.unref();
		return { pid: child.pid, logPath: options.logPath };
	} finally { closeSync(log); }
}

async function detachFinetuned(rest: string[]): Promise<number> {
	const { resolveTask } = await import("../harness/finetuned/agent/pipeline/resolve_task.js");
	const taskId = resolveTask(taskSelection(rest)).taskId;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const logPath = join(PROJECT_ROOT, "runs", "finetuned", taskId, "logs", `${stamp}.log`);
	const run = launchDetached({ command: [process.execPath, join(PROJECT_ROOT, "harness", "finetuned", "agent", "pipeline_cli.ts"), ...rest], logPath, cwd: PROJECT_ROOT });
	const shown = relative(PROJECT_ROOT, run.logPath);
	const resumeIndex = rest.indexOf("--resume");
	const base = resumeIndex >= 0 ? [...rest.slice(0, resumeIndex), ...rest.slice(resumeIndex + 2)] : rest;
	console.log([
		`[experiment] Detached finetuned run for ${taskId}, PID ${run.pid}.`,
		`[experiment] Log:    ${shown}`,
		`[experiment] Follow: tail -f ${shown}`,
		`[experiment] Stop:   kill -INT ${run.pid}   (cancels the run: running stages settle, nothing is handed over)`,
		`[experiment] Resume: ./dev bun run experiment -- --arm finetuned ${base.join(" ")} --detach --resume <run-id>   (the run ID is on the log's "run ... started" line)`,
	].join("\n"));
	return 0;
}

async function main(): Promise<number> {
	const options = parseExperimentArgs(process.argv.slice(2));
	if (options.reset) {
		if (options.arm === "minimal") { console.log("The minimal arm starts every run fresh; nothing to reset."); return 0; }
		const paths = harnessStatePaths(PROJECT_ROOT);
		if (!options.yes) {
			console.log(`Would delete:\n${paths.map(path => `  ${path}`).join("\n") || "  (nothing)"}\nRepeat with --yes to delete.`);
			return 0;
		}
		for (const path of paths) rmSync(path, { recursive: true, force: true });
		console.log(`Deleted ${paths.length} harness state paths.`);
		return 0;
	}
	if (options.detach && (options.arm !== "finetuned" || options.checkSetup)) throw new Error("--detach starts a finetuned run; it does not apply to the minimal arm or --check-setup");
	if (options.arm === "finetuned" && options.detach) return await detachFinetuned(options.rest);
	if (options.arm === "finetuned") {
		const args = [join(PROJECT_ROOT, "harness", "finetuned", "agent", "pipeline_cli.ts"), ...options.rest, ...(options.checkSetup ? ["--check-setup"] : [])];
		return spawnSync(process.execPath, args, { cwd: PROJECT_ROOT, stdio: "inherit" }).status ?? 1;
	}
	const problems = checkMinimalSetup({ model: options.model });
	if (problems.length) { console.error(`Minimal arm setup failed:\n${problems.map(problem => `- ${problem}`).join("\n")}`); return 1; }
	if (options.checkSetup) { console.log("Minimal arm setup ok."); return 0; }
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const run = prepareMinimalRun({ stamp });
	console.log(`[experiment] run location: ${run.root}`);
	createMinimalVenv(run);
	return await runMinimal(run, options.rest);
}

if (import.meta.main) {
	main().then(code => process.exit(code), error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
