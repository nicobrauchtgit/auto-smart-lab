import { expect, test } from "bun:test";
import { CloudExporter } from "./exporter.js";
import type { ExportResult } from "@opentelemetry/core";

test("Cloud exporter sends current SDK routing headers and detects HTTP 200 partial rejection", async () => {
 let headers: Headers | undefined, body: any, path: string | undefined;
 const server = Bun.serve({ port: 0, fetch: async request => {
  headers = request.headers; body = await request.json(); path = new URL(request.url).pathname;
  return Response.json({ partialSuccess: { rejectedSpans: "1", errorMessage: "Bearer confidential-provider-error" } });
 } });
 const exporter = new CloudExporter({ publicKey: "fixture-public", secretKey: "fixture-secret", baseUrl: server.url.origin, environment: "test", timeoutMs: 1000 });
 try {
  const result = await new Promise<ExportResult>(done => exporter.export([], done));
  expect(path).toBe("/api/public/otel/v1/traces");
  expect(headers?.get("x-langfuse-sdk-version")).toBe("5.13.1");
  expect(body.resourceSpans).toEqual([]);
  expect(result.code).toBe(1);
  expect(result.error?.message).toContain("partially rejected");
  expect(result.error?.message).not.toContain("confidential-provider-error");
 } finally { await exporter.shutdown(); server.stop(true); }
});

test("successful Cloud export and HTTP authentication failures have distinct callbacks", async () => {
 let status = 200;
 const server = Bun.serve({ port: 0, fetch: () => Response.json(status === 200 ? {} : { message: "fixture-secret" }, { status }) });
 const exporter = new CloudExporter({ publicKey: "fixture-public", secretKey: "fixture-secret", baseUrl: server.url.origin, environment: "test", timeoutMs: 1000 });
 try {
  const first = await new Promise<ExportResult>(done => exporter.export([], done));
  expect(first.code).toBe(0);
  status = 401;
  const second = await new Promise<ExportResult>(done => exporter.export([], done));
  expect(second.code).toBe(1);
  expect(second.error?.message).not.toContain("fixture-secret");
 } finally { await exporter.shutdown(); server.stop(true); }
});
