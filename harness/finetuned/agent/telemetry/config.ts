export interface TelemetryConfig {
 publicKey: string;
 secretKey: string;
 baseUrl: string;
 environment: string;
 timeoutMs: number;
}
export class LangfuseAccessError extends Error {
 constructor(readonly unavailable: boolean) { super("Langfuse project access failed"); }
}
export function telemetryConfig(env: Readonly<NodeJS.ProcessEnv> = process.env): TelemetryConfig {
 const missing = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY"].filter(key => !env[key]?.trim());
 if (missing.length) throw new Error(`Set ${missing.join(" and ")} in the project .env.`);
 const url = new URL(env.LANGFUSE_BASE_URL?.trim() || "https://cloud.langfuse.com");
 if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
  throw new Error("LANGFUSE_BASE_URL must be an HTTPS origin without credentials.");
 return { publicKey: env.LANGFUSE_PUBLIC_KEY!.trim(), secretKey: env.LANGFUSE_SECRET_KEY!.trim(),
  baseUrl: url.origin, environment: env.LANGFUSE_TRACING_ENVIRONMENT?.trim() || "development", timeoutMs: 5000 };
}
export async function checkLangfuseAccess(config: TelemetryConfig, signal: AbortSignal): Promise<string> {
 let response: Response;
 try { response = await fetch(`${config.baseUrl}/api/public/projects`, {
  headers: { Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}` },
  signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
 }); } catch { signal.throwIfAborted(); throw new LangfuseAccessError(true); }
 if (!response.ok) throw new LangfuseAccessError(response.status >= 500 || response.status === 429);
 const body = await response.json() as { data?: { id?: string }[] };
 const id = body.data?.[0]?.id;
 if (!id || typeof id !== "string") throw new LangfuseAccessError(false);
 return id;
}
