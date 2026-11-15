import { parseArgs } from "node:util";
import { runLeadStage } from "./pipeline/run_lead.js";
import { printTelemetry } from "./telemetry/cli.js";
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
 "check-setup": { type: "boolean" }, events: { type: "boolean" },
 "allow-telemetry-fallback": { type: "boolean" },
} });
if (positionals.length !== 1) {
 console.error("Usage: bun agent/lead_cli.ts <task-id> [--check-setup] [--events] [--allow-telemetry-fallback]");
 process.exit(2);
}
const controller = new AbortController();
process.on("SIGINT", () => controller.abort(new Error("Interrupted")));
process.on("SIGTERM", () => controller.abort(new Error("Terminated")));
const result = await runLeadStage({ taskId: positionals[0], checkSetupOnly: values["check-setup"], echoEvents: values.events, signal: controller.signal, telemetry: { allowFallback: values["allow-telemetry-fallback"] } });
console.log(`[lead] ${result.outcome}: ${result.stoppedBecause}`);
for (const invocation of result.invocations) {
 for (const artifact of invocation.artifacts) console.log(`${artifact.kind}: ${artifact.path}`);
 if (invocation.error) console.error(invocation.error);
}
printTelemetry(result, "[lead]");
process.exitCode = result.outcome === "success" ? 0 : 1;
