import type { PipelineRunResult } from "../pipeline/types.js";

export function printTelemetry(result: PipelineRunResult, prefix: string): void {
 if (result.traceUrl) console.log(`${prefix} Langfuse trace: ${result.traceUrl}`);
 else if (result.traceId) console.log(`${prefix} Langfuse trace ID: ${result.traceId}`);
 if (result.localTracePath) console.warn(`${prefix} Emergency trace: ${result.localTracePath}`);
 if (result.traceDegraded) console.warn(`${prefix} Trace degraded: ${result.traceFailures.join("; ")}`);
}
