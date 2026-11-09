/**
 * Choose the experiment arm. Each arm keeps its own entry point and arguments:
 *
 *   ./dev bun run experiment -- --arm finetuned spam1 [pipeline arguments]
 *   ./dev bun run experiment -- --arm minimal --only spam1 [solve_units arguments]
 *   ./dev bun run experiment -- --arm minimal --check-setup
 *   ./dev bun run experiment -- --arm finetuned --reset --yes
 *
 * Online or offline, the provider and the model come from experiment.config.json for both arms.
 *
 * The minimal arm starts every run in a fresh directory under runs/minimal/.
 * The finetuned arm keeps state in runs/finetuned/; --reset clears it except deliveries/.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMinimalSetup, createMinimalVenv, prepareMinimalRun, runMinimal } from "./minimal.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ARMS = ["finetuned", "minimal"] as const;
export type Arm = (typeof ARMS)[number];

export function parseExperimentArgs(argv: readonly string[]): { arm: Arm; reset: boolean; yes: boolean; checkSetup: boolean; model?: string; rest: string[] } {
	const rest = [...argv];
	const take = (flag: string) => { const index = rest.indexOf(flag); if (index < 0) return false; rest.splice(index, 1); return true; };
	const armIndex = rest.indexOf("--arm");
	const arm = armIndex >= 0 ? rest[armIndex + 1] : undefined;
	if (!ARMS.includes(arm as Arm)) throw new Error(`Choose an arm: --arm ${ARMS.join("|")}`);
	rest.splice(armIndex, 2);
	const modelIndex = rest.indexOf("--model");
	const model = modelIndex >= 0 ? rest[modelIndex + 1] : undefined;
	return { arm: arm as Arm, reset: take("--reset"), yes: take("--yes"), checkSetup: take("--check-setup"), ...(model ? { model } : {}), rest };
}

/** What a finetuned reset removes: everything in runs/finetuned/ except the hand-over files. */
export function harnessStatePaths(projectRoot: string): string[] {
	const paths: string[] = [];
	const state = join(projectRoot, "runs", "finetuned");
	if (existsSync(state)) for (const name of readdirSync(state)) if (name !== "deliveries") paths.push(join(state, name));
	return paths;
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
