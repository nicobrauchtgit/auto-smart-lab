import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimentConfigProblems, loadExperimentConfig, modelReference, MISSING_MODEL_MESSAGE, EXPERIMENT_THINKING_LEVELS } from "./config.js";
import { checkMinimalSetup, armModelsJson, minimalArgs } from "./minimal.js";
import { loadPipelineConfig } from "../harness/finetuned/agent/pipeline_config.js";
import { initializeModel } from "../harness/finetuned/agent/model_provider.js";
import { SetupSession, setupChecks } from "../harness/finetuned/agent/pipeline/setup.js";
import { loadPromptSnapshot } from "../harness/finetuned/agent/prompts/loader.js";
import { agentEnvironment } from "../harness/finetuned/agent/telemetry/metadata.js";

const providers = { "google-vertex": { builtin: true as const, models: [{ id: "gemini-3.8-flash", contextWindow: 1048576, maxTokens: 65536,
 cost: { input: .75, output: 3.75, cacheRead: .075, cacheWrite: 0 } }] } };

test("unselected configuration loads, but both preflights and model initialization stop before agents", async () => {
 const root = mkdtempSync(join(tmpdir(), "unselected-model-"));
 try {
  const path = join(root, "experiment.config.json"), arm = join(root, "pipeline.config.json");
  writeFileSync(path, JSON.stringify({ online: false, providers }));
  writeFileSync(arm, JSON.stringify({ agent: { cwd: ".", agentDir: ".", initialPrompt: "" } }));
  const shared = loadExperimentConfig(path);
  expect(shared.model).toBeUndefined();
  expect(() => modelReference(shared)).toThrow(MISSING_MODEL_MESSAGE);
  expect(() => minimalArgs([], shared)).toThrow(MISSING_MODEL_MESSAGE);
  expect(() => minimalArgs(["--model", "other/model"], shared)).toThrow("Select the model in experiment.config.json");
  expect(checkMinimalSetup({ projectRoot: root, env: {}, bwrap: "/nonexistent" })).toContain(MISSING_MODEL_MESSAGE);
  const { config } = await loadPipelineConfig(arm, path);
  expect(config.defaultModel).toBeUndefined();
  await expect(initializeModel({ config, model: "google-vertex/gemini-3.8-flash" })).rejects.toThrow(MISSING_MODEL_MESSAGE);
  const events: unknown[] = [];
  const checks = setupChecks(["model"], { taskId: "fixture", configPath: arm, experimentConfigPath: path, prompts: loadPromptSnapshot() });
  await expect(new SetupSession().check(checks, new AbortController().signal, (type, payload) => events.push({type, payload}))).rejects.toThrow(MISSING_MODEL_MESSAGE);
  expect(JSON.stringify(events)).toContain('"id":"model-access","status":"skipped"');
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("thinkingLevel accepts supported levels and rejects invalid values", () => {
 for (const thinkingLevel of EXPERIMENT_THINKING_LEVELS) expect(experimentConfigProblems({ online: false, providers, model: { provider: "google-vertex", id: "gemini-3.8-flash", thinkingLevel } })).toEqual([]);
 for (const thinkingLevel of ["invalid", null, 3]) expect(experimentConfigProblems({ online: false, providers, model: { provider: "google-vertex", id: "gemini-3.8-flash", thinkingLevel } }).join()).toContain("model.thinkingLevel");
});

test("minimal builtin model catalog retains costs", () => {
 expect(JSON.parse(armModelsJson({ providers })).providers["google-vertex"].models).toEqual(providers["google-vertex"].models);
});

test("agent shells strip share and archive credentials and file references", () => {
 expect(agentEnvironment({ PATH: "kept", SMARTLAB_SHARE_PASSWORD: "secret", SMARTLAB_SHARE_PASSWORD_FILE: "/secret", SMARTLAB_ARCHIVE_PASSPHRASE: "secret", SMARTLAB_ARCHIVE_PASSPHRASE_FILE: "/secret", LANGFUSE_SECRET_KEY: "secret" })).toEqual({ PATH: "kept" });
});


test("minimal direct session rejects an absent selection before loading resources or creating a session", async () => {
 const {runSession} = await import("../harness/minimal/agent/run/session_runner.js");
 const before = process.env.PI_MODEL;
 delete process.env.PI_MODEL;
 try {
  await expect(runSession({ instructionsPath: "/nonexistent-instructions", prompt: "unused", label: "missing-model-test" })).rejects.toThrow(MISSING_MODEL_MESSAGE);
 } finally { if (before === undefined) delete process.env.PI_MODEL; else process.env.PI_MODEL = before; }
});

test("the finetuned pipeline config carries the shared thinkingLevel, and none when it is absent", async () => {
 const root = mkdtempSync(join(tmpdir(), "thinking-mapping-"));
 try {
  const path = join(root, "experiment.config.json"), arm = join(root, "pipeline.config.json");
  writeFileSync(arm, JSON.stringify({ agent: { cwd: ".", agentDir: ".", initialPrompt: "" } }));
  writeFileSync(path, JSON.stringify({ online: false, providers, model: { provider: "google-vertex", id: "gemini-3.8-flash", thinkingLevel: "high" } }));
  expect((await loadPipelineConfig(arm, path)).config.thinkingLevel).toBe("high");
  writeFileSync(path, JSON.stringify({ online: false, providers, model: { provider: "google-vertex", id: "gemini-3.8-flash" } }));
  expect((await loadPipelineConfig(arm, path)).config.thinkingLevel).toBeUndefined();
 } finally { rmSync(root, { recursive: true, force: true }); }
});
