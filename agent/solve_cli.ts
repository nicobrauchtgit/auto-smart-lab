/**
 * Run the solve stage for one task through the shared executor.
 *
 * `--use-existing-research` enters at solve with the research document already on
 * disk, seeded as an upstream artifact. The trace then shows solve as the only
 * stage this run executed, rather than implying research ran again.
 */

import { runSolveStage } from "./pipeline/run_solve.js";
import { resolveTask } from "./pipeline/resolve_task.js";

function usage(): never {
	console.error("Usage: npm run solve-stage -- <task> [--use-existing-research] [--iterations N] [--model M] [--events]");
	console.error("  npm run solve-stage -- spam1 --use-existing-research --iterations 3");
	console.error("  npm run solve-stage -- unit 1 task 1");
	process.exit(2);
}

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes("--help")) usage();

const flag = (name: string) => argv.includes(name);
function value(name: string): string | undefined {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

const positional = argv.filter((entry, index) =>
	!entry.startsWith("--") && !["--iterations", "--model"].includes(argv[index - 1]));

const selector = positional[0] === "unit"
	? { unitNumber: Number(positional[1]), taskNumber: Number(positional[3]) }
	: { taskId: positional[0] };
const task = resolveTask(selector);

const iterations = value("--iterations");
const result = await runSolveStage({
	taskId: task.taskId,
	model: value("--model"),
	maxIterations: iterations === undefined ? undefined : Number(iterations),
	useExistingResearch: flag("--use-existing-research"),
	echoEvents: flag("--events"),
	invokedBy: { kind: "cli", command: "solve-stage", argv },
});

const solve = result.invocations.find((invocation) => invocation.stage === "solve");
console.log(`\n[solve-stage] ${task.taskId}: ${result.outcome} — ${result.stoppedBecause}`);
if (solve) {
	console.log(`[solve-stage] iterations: ${solve.attempts}`);
	for (const [key, entry] of Object.entries(solve.summary ?? {})) console.log(`[solve-stage]   ${key}: ${JSON.stringify(entry)}`);
	if (solve.validation && !solve.validation.valid) {
		for (const error of solve.validation.errors) console.error(`[solve-stage]   error: ${error}`);
	}
	for (const artifact of solve.artifacts) console.log(`[solve-stage]   artifact ${artifact.kind}: ${artifact.path}`);
}
if (result.traceDegraded) console.warn(`[solve-stage] trace degraded: ${result.traceFailures.join("; ")}`);
if (result.localTracePath) console.log(`[solve-stage] trace: ${result.localTracePath}`);
process.exit(result.outcome === "success" ? 0 : 1);
