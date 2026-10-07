import { parseArgs } from "node:util";
import { runRefitStage } from "./pipeline/run_refit.js";
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
 "training-root": { type: "string" }, "check-setup": { type: "boolean" }, events: { type: "boolean" },
} });
if (positionals.length !== 1) {
 console.error("Usage: bun agent/refit_cli.ts <task-id> [--training-root PATH] [--check-setup] [--events]");
 process.exit(2);
}
const controller = new AbortController();
process.on("SIGINT", () => controller.abort(new Error("Interrupted")));
process.on("SIGTERM", () => controller.abort(new Error("Terminated")));
const result = await runRefitStage({ taskId: positionals[0], trainingRoot: values["training-root"], checkSetupOnly: values["check-setup"], echoEvents: values.events, signal: controller.signal });
console.log(`[refit] ${result.outcome}: ${result.stoppedBecause}`);
for (const invocation of result.invocations) {
 for (const artifact of invocation.artifacts) console.log(`${artifact.kind}: ${artifact.path}`);
 if (invocation.error) console.error(invocation.error);
}
process.exitCode = result.outcome === "success" ? 0 : 1;
