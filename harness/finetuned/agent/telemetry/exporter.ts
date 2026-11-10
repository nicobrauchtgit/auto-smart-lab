import { LangfuseClient } from "@langfuse/client";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { TelemetryConfig } from "./config.js";

/** Use the official OTLP serializer and Langfuse API, including SDK version headers.
 * Unlike the default OTLP exporter callback, this also detects partial rejection.
 */
export class CloudExporter implements SpanExporter {
 private client: LangfuseClient;
 private pending = new Set<Promise<void>>();
 constructor(private config: TelemetryConfig) {
  this.client = new LangfuseClient({ ...config, timeout: config.timeoutMs / 1000 });
 }
 export(spans: ReadableSpan[], done: Parameters<SpanExporter["export"]>[1]): void {
  const send = async () => {
   try {
    const encoded = JsonTraceSerializer.serializeRequest(spans);
    if (!encoded) throw new Error("Empty OTLP request");
    const response = await this.client.api.opentelemetry.exportTraces(JSON.parse(new TextDecoder().decode(encoded)), {
     maxRetries: 1, timeoutInSeconds: this.config.timeoutMs / 1000,
     abortSignal: AbortSignal.timeout(this.config.timeoutMs * 2 + 1000),
    });
    // The generated API type is empty; OTLP may still report partial success.
    const partial = (response as { partialSuccess?: { rejectedSpans?: string | number } }).partialSuccess;
    if (Number(partial?.rejectedSpans ?? 0) > 0) throw new Error("Partial OTLP rejection");
    done({ code: 0 });
   } catch { done({ code: 1, error: new Error("Langfuse observation delivery failed or was partially rejected") }); }
  };
  const work = send().finally(() => this.pending.delete(work)); this.pending.add(work);
 }
 async forceFlush(): Promise<void> { await Promise.all([...this.pending]); }
 async shutdown(): Promise<void> { await this.forceFlush(); }
}
