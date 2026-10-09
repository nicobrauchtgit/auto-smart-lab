import { createHash } from "node:crypto";

export interface TelemetryIdentity {
 pipelineRunId?: string | null;
 stageInvocationId?: string | null;
 stage?: string | null;
 attempt?: number | null;
 taskId?: string | null;
}
export interface TelemetryRecord {
 agentRunId: string;
 sequence: number;
 piSessionId: string | null;
 eventType: string;
 observedAt: string;
 payload: unknown;
 identity?: TelemetryIdentity;
}

/** Apply the same limits and credential removal before Cloud and emergency IO. */
export function sanitize(value: unknown, secrets: readonly string[] = []): unknown {
 const seen = new WeakSet<object>();
 const visit = (input: unknown, depth: number): unknown => {
  if (typeof input === "string") {
   let text = input;
   for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]");
   text = text.replace(/\b(?:sk|pk)-lf-[\w-]+\b/g, "[REDACTED]")
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, "$1 [REDACTED]");
   return text.length > 24000 ? `${text.slice(0, 24000)}…[truncated]` : text;
  }
  if (input === null || typeof input === "boolean" || typeof input === "number") return input;
  if (typeof input === "bigint") return String(input);
  if (typeof input !== "object") return null;
  if (seen.has(input)) return "[circular]";
  if (depth > 12) return "[depth limit]";
  seen.add(input);
  if (input instanceof Date) { seen.delete(input); return input.toISOString(); }
  const result = Array.isArray(input) ? input.slice(0, 300).map(item => visit(item, depth + 1))
   : Object.fromEntries(Object.entries(input).slice(0, 100).map(([key, item]) => [key,
   /authorization|cookie|password|secret|api.?key|access.?token|refresh.?token/i.test(key)
    ? "[REDACTED]" : visit(item, depth + 1)]));
  seen.delete(input);
  return result;
 };
 const result = visit(value, 0);
 const encoded = JSON.stringify(result);
 return encoded.length > 48000 ? { truncated: true, sha256: createHash("sha256").update(encoded).digest("hex"), preview: encoded.slice(0, 24000) } : result;
}

/** Pi input is uncached input; cache read/write are disjoint categories. */
export function piUsage(usage: Record<string, any> | undefined) {
 if (!usage) return { metadata: { usage_available: false, cost_source: "unknown" } };
 const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
 const usageDetails = Object.fromEntries([
  ["input", usage.input], ["output", usage.output], ["input_cached", usage.cacheRead],
  ["input_cache_creation", usage.cacheWrite], ["total", usage.totalTokens],
 ].filter((entry): entry is [string, number] => nonnegative(entry[1])));
 const costDetails = usage.cost && Object.fromEntries([
  ["input", usage.cost.input], ["output", usage.cost.output], ["input_cached", usage.cost.cacheRead],
  ["input_cache_creation", usage.cost.cacheWrite], ["total", usage.cost.total],
 ].filter((entry): entry is [string, number] => nonnegative(entry[1])));
 return { usageDetails, ...(costDetails && Object.keys(costDetails).length ? { costDetails } : {}),
  metadata: { usage_available: true, cost_source: costDetails && Object.keys(costDetails).length ? "pi_calculated" : "unknown" } };
}

export function agentEnvironment(source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
 return Object.fromEntries(Object.entries(source).filter(([name]) => !name.startsWith("LANGFUSE_")));
}

/** Bound large Pi IO independently so truncation cannot erase lifecycle IDs or usage. */
export function sanitizeEventPayload(type: string, payload: unknown, secrets: readonly string[]): unknown {
 if (!payload || typeof payload !== "object") return sanitize(payload, secrets);
 const raw = payload as Record<string, any>;
 const mask = (value: unknown) => sanitize(value, secrets);
 if (type === "message_update") return { type, message: { role: mask(raw.message?.role) } };
 if (type === "tool_execution_update") return { type, toolCallId: mask(raw.toolCallId) };
 if (type === "message_start" || type === "message_end") {
  const message = raw.message;
  if (!message || typeof message !== "object") return { type };
  return { type, message: { role: mask(message.role), model: mask(message.model), provider: mask(message.provider),
   stopReason: mask(message.stopReason), ...(type === "message_end" ? { content: mask(message.content), usage: mask(message.usage) } : {}) } };
 }
 if (type === "model_request") return { request: mask(raw.request), model: mask(raw.model), provider: mask(raw.provider) };
 if (type === "tool_execution_start" || type === "tool_execution_end") return { type,
  toolName: mask(raw.toolName), toolCallId: mask(raw.toolCallId),
  ...(type === "tool_execution_start" ? { args: mask(raw.args) } : { result: mask(raw.result), isError: raw.isError === true }) };
 const bounded = mask(payload) as Record<string, unknown>;
 if (bounded?.truncated !== true) return bounded;
 // Oversized domain records still identify their trial and authoritative result.
 for (const key of ["outcome", "experiment_id", "exit_code", "valid", "readiness_score", "status",
  "dataset_sha256", "sample_manifest_sha256", "fold_manifest_sha256", "commit"]) {
  if (["string", "number", "boolean"].includes(typeof raw[key])) bounded[key] = mask(raw[key]);
 }
 if (typeof raw.validation?.valid === "boolean") bounded.validation = { valid: raw.validation.valid, errors: mask(raw.validation.errors) };
 if (raw.metrics) bounded.metrics = Object.fromEntries(["balancedAccuracy", "adjustedRandIndex", "selectionScore"]
  .filter(key => typeof raw.metrics[key] === "number" && Number.isFinite(raw.metrics[key])).map(key => [key, raw.metrics[key]]));
 return bounded;
}
