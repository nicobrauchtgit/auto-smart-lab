import { parseArgs } from "node:util";
import { runEvaluateStage } from "./pipeline/run_evaluate.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
 "training-root": { type: "string" }, model: { type: "string" },
 "check-setup": { type: "boolean" }, events: { type: "boolean" },
} });
if (positionals.length !== 1 || !values["training-root"]) {
 console.error("Usage: bun agent/evaluate_cli.ts <task-id> --training-root <solve/training/run-id> [--model M] [--check-setup] [--events]");
 process.exit(2);
}
const result = await runEvaluateStage({ taskId: positionals[0], trainingRoot: values["training-root"],
 model: values.model, checkSetupOnly: values["check-setup"], echoEvents: values.events });
console.log(`[evaluate] ${result.outcome}: ${result.stoppedBecause}`);
for (const invocation of result.invocations) {
 for (const entry of invocation.artifacts) console.log(`${entry.kind}: ${entry.path}`);
 if (invocation.error) console.error(invocation.error);
 for (const error of invocation.validation?.errors ?? []) console.error(error);
}
if (result.traceDegraded) console.warn(`Trace degraded: ${result.traceFailures.join("; ")}`);
process.exitCode = result.outcome === "success" ? 0 : 1;
