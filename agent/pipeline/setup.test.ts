import { expect, test } from "bun:test";
import { SetupSession, setupChecks, type SetupCheck } from "./setup.js";
import { loadPromptSnapshot } from "../prompts/loader.js";

const signal = () => new AbortController().signal;
test("collects all local failures, skips remote probes and never exposes exception secrets", async () => {
 const events: unknown[] = [];
 let remoteCalls = 0;
 const checks: SetupCheck[] = ["credential", "dataset"].map(id => ({ id, phase: "local", remedy: `Fix ${id}`, run() { throw new Error("SECRET_TOKEN"); } }));
 checks.push({ id: "remote", phase: "remote", remedy: "Fix access", run() { remoteCalls++; } });
 await expect(new SetupSession().check(checks, signal(), (type, payload) => events.push({ type, payload }))).rejects.toThrow("credential: Fix credential\n- dataset: Fix dataset");
 expect(remoteCalls).toBe(0);
 expect(JSON.stringify(events)).not.toContain("SECRET_TOKEN");
 expect(JSON.stringify(events)).toContain('"status":"skipped"');
});
test("checks remote failures after local success and reuses successes only within the run", async () => {
 let calls = 0;
 const checks: SetupCheck[] = [{ id: "remote", phase: "remote", remedy: "Check key access", run() { calls++; } }];
 const session = new SetupSession();
 await session.check(checks, signal(), () => {});
 await session.check(checks, signal(), () => {});
 expect(calls).toBe(1);
 await new SetupSession().check(checks, signal(), () => {});
 expect(calls).toBe(2);
 await expect(new SetupSession().check([{ ...checks[0], run() { throw new Error("401 secret"); } }], signal(), () => {})).rejects.toThrow("Check key access");
});
test("requirements are scoped to the planned features", () => {
 const prompts = loadPromptSnapshot();
 expect(setupChecks([], { taskId: "spam1", prompts })).toEqual([]);
 const solve = setupChecks(["model", "python", "task", "training"], { taskId: "spam1", prompts });
 expect(solve.some(check => check.id === "TAVILY_API_KEY")).toBe(false);
 expect(solve.some(check => check.id === "training-zip-command")).toBe(true);
});
test("blank search key and missing unit are detected locally", async () => {
 const before = process.env.TAVILY_API_KEY;
 process.env.TAVILY_API_KEY = "   ";
 try {
  const checks = setupChecks(["web-search", "task"], { taskId: "nonexistent-setup-test", prompts: loadPromptSnapshot() });
  await expect(new SetupSession().check(checks, signal(), () => {})).rejects.toThrow("TAVILY_API_KEY");
 } finally {
  if (before === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = before;
 }
});
test("pre-aborted setup never runs a check", async () => {
 const controller = new AbortController(); controller.abort(); let called = false;
 await expect(new SetupSession().check([{ id: "a", phase: "local", remedy: "a", run() { called = true; } }], controller.signal, () => {})).rejects.toThrow();
 expect(called).toBe(false);
});

test("model probe sends rendered prompt text through the SDK", async () => {
 const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 const root = mkdtempSync(join(tmpdir(), "setup-model-"));
 const before = process.env.SETUP_TEST_API_KEY;
 process.env.SETUP_TEST_API_KEY = "fixture-key";
 let content: unknown;
 const server = Bun.serve({ port: 0, async fetch(request) {
  const body = await request.json() as any;
  content = body.messages.at(-1).content;
  const chunk = { id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
   choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
   usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
 } });
 try {
  const configPath = join(root, "pipeline.config.json");
  writeFileSync(configPath, JSON.stringify({ agent: { cwd: ".", agentDir: ".", initialPrompt: "" },
   defaultModel: "setup-test/fixture", providers: { "setup-test": { baseUrl: `http://localhost:${server.port}/v1`,
    api: "openai-completions", apiKeyEnv: "SETUP_TEST_API_KEY", models: [{ id: "fixture", contextWindow: 10000, maxTokens: 100 }] } } }));
  await new SetupSession().check(setupChecks(["model"], { taskId: "fixture", configPath, prompts: loadPromptSnapshot() }), signal(), () => {});
  expect(content).toBe(loadPromptSnapshot().render("setup.model-check", {}).text);
 } finally {
  server.stop(true); rmSync(root, { recursive: true, force: true });
  if (before === undefined) delete process.env.SETUP_TEST_API_KEY; else process.env.SETUP_TEST_API_KEY = before;
 }
});

function brokenTrainingExecutables() {
 const { mkdtempSync, writeFileSync, chmodSync } = require("node:fs") as typeof import("node:fs");
 const { tmpdir } = require("node:os") as typeof import("node:os");
 const { join } = require("node:path") as typeof import("node:path");
 const { resolve } = require("node:path") as typeof import("node:path");
 const root = mkdtempSync(join(tmpdir(), "setup-training-"));
 // A real interpreter whose import path shadows optuna with a failing module.
 writeFileSync(join(root, "optuna.py"), "raise ImportError('optuna is not installed')\n");
 const python = join(root, "python");
 writeFileSync(python, `#!/bin/sh\nPYTHONPATH=${root} exec ${join(resolve(process.env.VENV_DIR ?? ".venv"), "bin", "python")} "$@"\n`);
 chmodSync(python, 0o755);
 return { python, git: join(root, "no-git-here") };
}

test("solve declares optuna and git prerequisites and both block when missing", async () => {
 const prompts = loadPromptSnapshot();
 const { solveStage } = await import("./stages/solve.js");
 const ids = setupChecks(solveStage.setupRequirements ?? [], { taskId: "spam1", prompts }).map(check => check.id);
 expect(ids).toContain("training-optuna");
 expect(ids).toContain("training-git");
 const healthy = setupChecks(["training"], { taskId: "spam1", prompts }).filter(check => ["training-optuna", "training-git"].includes(check.id));
 await new SetupSession().check(healthy, signal(), () => {});
 const broken = setupChecks(["training"], { taskId: "spam1", prompts, executables: brokenTrainingExecutables() })
  .filter(check => ["training-optuna", "training-git"].includes(check.id));
 await expect(new SetupSession().check(broken, signal(), () => {})).rejects.toThrow(/training-optuna: .*optuna[\s\S]*training-git: Install git/);
});

test("a missing optuna or git prevents the solve stage from running", async () => {
 const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 const { invokeStage } = await import("./executor.js");
 const { createPipelineTrace } = await import("./trace.js");
 const { resolvePipelineSettings } = await import("./config.js");
 const { STAGE_REGISTRY } = await import("./registry.js");
 const { solveStage } = await import("./stages/solve.js");
 const prompts = loadPromptSnapshot();
 const broken = setupChecks(["training"], { taskId: "fixture", prompts, executables: brokenTrainingExecutables() });
 class MissingTrainingTools extends SetupSession {
  async check(checks: SetupCheck[], abort: AbortSignal, record: (event: string, payload: Record<string, unknown>) => void) {
   const replaced = checks.filter(check => ["training-optuna", "training-git"].includes(check.id))
    .map(check => broken.find(candidate => candidate.id === check.id)!);
   expect(replaced).toHaveLength(2);
   return super.check(replaced, abort, record);
  }
 }
 const before = STAGE_REGISTRY.solve;
 const directory = mkdtempSync(join(tmpdir(), "solve-preflight-"));
 let ran = false;
 const trace = await createPipelineTrace({ taskId: "fixture", pipelineRunId: crypto.randomUUID(), runsDir: directory });
 try {
  STAGE_REGISTRY.solve = { ...solveStage, checkInput() {}, async run() { ran = true; return { artifacts: [] }; } };
  const config = resolvePipelineSettings({ pipeline: { entryStage: "solve", stages: { solve: { enabled: true } } }, agent: { cwd: ".", agentDir: ".", initialPrompt: "" }, providers: {}, defaultModel: "fixture/model" } as any);
  const invocation = await invokeStage({ stage: "solve", input: { taskId: "fixture", upstream: [] }, config, trace, setupSession: new MissingTrainingTools() });
  expect(invocation.outcome).toBe("failure");
  expect(invocation.error).toContain("training-optuna");
  expect(invocation.error).toContain("training-git");
  expect(ran).toBe(false);
  await trace.close();
  expect(readFileSync(trace.localPath, "utf8")).toContain(invocation.invocationId);
 } finally {
  STAGE_REGISTRY.solve = before;
  await trace.close();
  rmSync(directory, { recursive: true, force: true });
 }
});

test("training recovery prerequisites are scoped and block execution when flock Python probe cannot run", async () => {
 const checks = setupChecks(["training"], { taskId: "fixture", prompts: loadPromptSnapshot(), executables: { python: "/missing-recovery-python" } });
 const recovery = checks.find(check => check.id === "training-recovery")!;
 expect(recovery).toBeDefined();
 expect(setupChecks([], { taskId: "fixture", prompts: loadPromptSnapshot() }).some(check => check.id === "training-recovery")).toBe(false);
 await expect(new SetupSession().check([recovery], signal(), () => {})).rejects.toThrow("training-recovery");
});

test("missing shared metric prerequisites block the solve stage before execution", async () => {
 const { mkdtempSync, rmSync } = await import("node:fs");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 const { invokeStage } = await import("./executor.js");
 const { createPipelineTrace } = await import("./trace.js");
 const { resolvePipelineSettings } = await import("./config.js");
 const { STAGE_REGISTRY } = await import("./registry.js");
 const prompts = loadPromptSnapshot();
 const missing = setupChecks(["training"], { taskId: "fixture", prompts, executables: { python: "/missing-metric-python" } })
  .find(check => check.id === "training-imports")!;
 expect(setupChecks([], { taskId: "fixture", prompts }).some(check => check.id === missing.id)).toBe(false);
 class MissingMetrics extends SetupSession {
  async check(checks: SetupCheck[], abort: AbortSignal, record: (event: string, payload: Record<string, unknown>) => void) {
   expect(checks.some(check => check.id === missing.id)).toBe(true);
   return super.check([missing], abort, record);
  }
 }
 const original = STAGE_REGISTRY.solve;
 const directory = mkdtempSync(join(tmpdir(), "metric-preflight-"));
 const trace = await createPipelineTrace({ taskId: "fixture", pipelineRunId: crypto.randomUUID(), runsDir: directory });
 let ran = false;
 try {
  STAGE_REGISTRY.solve = { ...original, checkInput() {}, async run() { ran = true; return { artifacts: [] }; } };
  const config = resolvePipelineSettings({ pipeline: { entryStage: "solve", stages: { solve: { enabled: true } } },
   agent: { cwd: ".", agentDir: ".", initialPrompt: "" }, providers: {}, defaultModel: "fixture/model" } as any);
  const result = await invokeStage({ stage: "solve", input: { taskId: "fixture", upstream: [] }, config, trace, setupSession: new MissingMetrics() });
  expect(result.outcome).toBe("failure");
  expect(result.error).toContain("training-imports");
  expect(ran).toBe(false);
 } finally {
  STAGE_REGISTRY.solve = original;
  await trace.close();
  rmSync(directory, { recursive: true, force: true });
 }
});
