import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupChecks, SetupSession } from "../pipeline/setup.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { refitStage } from "../pipeline/stages/refit.js";
import { solveStage } from "../pipeline/stages/solve.js";
import { STAGE_REGISTRY } from "../pipeline/registry.js";
import { runPipeline } from "../pipeline/executor.js";
import { runRefitStage } from "../pipeline/run_refit.js";
import { spamConfiguration } from "../pipeline/task_configuration.testing.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";

function configuration(root: string, chain = false) {
 const path = join(root, "pipeline.config.json");
 writeFileSync(path, JSON.stringify({ agent: { cwd: ".", agentDir: ".", initialPrompt: "" }, defaultModel: "unused/local", providers: {},
  pipeline: { version: 1, entryStage: chain ? "solve" : "refit", stages: { solve: { enabled: chain }, refit: { enabled: true } },
   tasks: { fixture: spamConfiguration(), "fixture-missing": spamConfiguration() } } }));
 return path;
}
test("refit preflight has no provider requirements, checks full data before upstream selection and rejects missing runtime dependencies", async () => {
 const base = { taskId: "fixture-missing", prompts: loadPromptSnapshot() };
 const upstream = setupChecks(refitStage.setupRequirements!, { ...base, candidateProducedUpstream: true });
 expect(upstream.some(c => c.id.startsWith("refit-candidate"))).toBe(false);
 expect(upstream.some(c => c.id.startsWith("refit-data"))).toBe(true);
 expect(upstream.some(c => c.phase === "remote" || c.id === "model-configuration")).toBe(false);
 const standalone = setupChecks(refitStage.setupRequirements!, base);
 expect(standalone.some(c => c.id.startsWith("refit-candidate"))).toBe(true);
 const runtime = setupChecks(["refit"], { ...base, executables: { python: "/missing-python", git: "/missing-git" } }).filter(c => c.id === "refit-runtime");
 await expect(new SetupSession().check(runtime, new AbortController().signal, () => {})).rejects.toThrow("refit-runtime");
});

test("whole chain rejects missing later refit inputs before solve starts", async () => {
 const root = mkdtempSync(join(tmpdir(), "refit-preflight-")); const path = configuration(root, true);
 const oldSolve = STAGE_REGISTRY.solve; const oldRefit = STAGE_REGISTRY.refit;
 let called = false;
 STAGE_REGISTRY.solve = { ...solveStage, setupRequirements: [], checkInput() {}, async run() { called = true; return { artifacts: [] }; }, next: "refit" };
 STAGE_REGISTRY.refit = refitStage;
 try {
  await expect(runPipeline({ taskId: "fixture-missing", entryStage: "solve", configPath: path, runsDir: root })).rejects.toThrow("refit-data");
  expect(called).toBe(false);
 } finally { STAGE_REGISTRY.solve = oldSolve; STAGE_REGISTRY.refit = oldRefit; }
}, 30_000);

test("standalone refit calls the shared executor, records typed inputs/artifact validation, and skips all workers for check-setup", async () => {
 const root = mkdtempSync(join(tmpdir(), "refit-standalone-")); const path = configuration(root);
 const configured = JSON.parse(readFileSync(path, "utf8")); configured.pipeline.stages.refit.options = { trainingRoot: join(root, "chosen") }; writeFileSync(path, JSON.stringify(configured));
 const previous = STAGE_REGISTRY.refit; let calls = 0;
 STAGE_REGISTRY.refit = { ...refitStage, setupRequirements: [], checkInput() {}, async run(context) {
  calls++; expect(context.options.trainingRoot).toBe(join(root, "chosen")); context.report.input({ kind: "frozen_candidate", version: 1, delivery: "none", status: "available" });
  context.report.event("refit_artifacts_validated", { test_rows: 7 });
  return { artifacts: [{ kind: "final_test_predictions", path: "/fixture/predictions.csv", sha256: "fixture" }], validation: { valid: true, errors: [] } };
 } };
 try {
  const setup = await runRefitStage({ taskId: "fixture", configPath: path, runsDir: root, checkSetupOnly: true });
  expect(setup.outcome).toBe("success"); expect(calls).toBe(0);
  const result = await runRefitStage({ taskId: "fixture", configPath: path, runsDir: root });
  expect(result.outcome).toBe("success"); expect(result.invocations[0].stage).toBe("refit"); expect(result.invocations[0].attempts).toBe(0);
  const events = readFileSync(result.localTracePath!, "utf8").split("\n").filter(Boolean).map(s => JSON.parse(s));
  expect(events.some(e => e.event_type === "stage_started" || e.type === "stage_started")).toBe(true);
  expect(JSON.stringify(events)).toContain("frozen_candidate");
  expect(JSON.stringify(events)).toContain(result.pipelineRunId);
 } finally { STAGE_REGISTRY.refit = previous; }
});
