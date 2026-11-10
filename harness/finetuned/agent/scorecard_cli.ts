/**
 * Scorecard of a finished (or dead) finetuned run. Read-only.
 *
 *   ./dev bun run scorecard -- <task> [--run <run-id>] [--run <run-id>] [--compare <run-id>]
 *                                     [--runs <dir>] [--targets <file>] [--json]
 *
 * Without --run the newest run of the task is scored. Two runs (two --run, or
 * --run with --compare) are scored both and compared; the earlier one is the
 * baseline for indicator 7.
 */
import { formatScorecard } from "./scorecard/format.js";
import { scorecard, toJson } from "./scorecard/index.js";
import { STATE_ROOT } from "./paths.js";

const USAGE = "Usage: scorecard_cli.ts <task> [--run <run-id>]... [--compare <run-id>] [--runs <dir>] [--targets <file>] [--json]";

export function parseArguments(argv: string[]) {
 const options = { task: "", runIds: [] as string[], compareWith: undefined as string | undefined, runsDir: STATE_ROOT, targetsPath: undefined as string | undefined, json: false };
 for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const value = () => { const next = argv[++i]; if (!next || next.startsWith("--")) throw new Error(`${arg} needs a value\n${USAGE}`); return next; };
  if (arg === "--run") options.runIds.push(value());
  else if (arg === "--compare") options.compareWith = value();
  else if (arg === "--runs") options.runsDir = value();
  else if (arg === "--targets") options.targetsPath = value();
  else if (arg === "--json") options.json = true;
  else if (arg === "--help" || arg === "-h") throw new Error(USAGE);
  else if (arg.startsWith("--") || options.task) throw new Error(`Unexpected argument ${arg}\n${USAGE}`);
  else options.task = arg;
 }
 if (!options.task) throw new Error(USAGE);
 return options;
}

if (import.meta.main) {
 try {
  const options = parseArguments(process.argv.slice(2));
  const result = scorecard(options);
  console.log(options.json ? JSON.stringify(toJson(result), null, 2) : formatScorecard(result));
 } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
 }
}
