import { expect, test } from "bun:test";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryProject, trainingEnvironment, PYTHON, WORKER, until } from "./testing.js";
import { createHarnessTraining } from "./index.js";
import { tagMessage } from "./git.js";
import { candidateIdentity, terminalPath } from "./terminal.js";
import { developmentSelection } from "./development_selection.js";
import { collectTrainingResults } from "./results.js";
import { initialState, StateStore } from "../orchestrator/state.js";
import { Coordinator } from "../orchestrator/coordinator.js";
import { resolvePipelineSettings } from "../pipeline/config.js";
import { loadPromptSnapshot } from "../prompts/loader.js";

test("a terminal champion stays frozen while a changed candidate earns fresh standalone validation and selection", async () => {
 const project = temporaryProject("changed-after-terminal-"), root = join(project.root, "runs", "fixture", "solve", "training", "run");
 const events: { type: string; payload: Record<string, unknown> }[] = [];
 const training = createHarnessTraining({ root, projectRoot: project.root, solutionsRoot: project.solutionsRoot, taskId: "fixture", pythonExecutable: PYTHON,
  env: trainingEnvironment(), datasetSha256: project.datasetSha256, rootSeed: 13, zipPath: project.zipPath, labelsPath: project.labelsPath, workerPath: WORKER,
  prompts: loadPromptSnapshot(), record: (type, payload) => events.push({ type, payload }), limits: { sampleIntervalMs: 25, stopGraceMs: 100 } });
 const request = { schemaVersion: 2, hypothesis: "baseline fixed promotion", pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline", parameters: { c: 1 } }, cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 }, scope: { kind: "promotion" } };
 try {
  const baseline = await training.service.start(request);
  expect(await until(() => training.supervisor.status(baseline.id).status !== "running")).toBe(true); await training.service.finalize(baseline.id);
  const identity = candidateIdentity("fixture", project.head, request.pipeline), path = terminalPath(project.solutionsRoot, identity); mkdirSync(join(project.solutionsRoot, ".git", "smartlab-terminal"), { recursive: true });
  // A terminal marker is sufficient for the development guard; actual all-row
  // refit and recovery remain covered by the local refit integration suite.
  const marker = JSON.stringify({ schemaVersion: 1, taskId: "fixture", identity, source: { commit: project.head }, pipeline: request.pipeline }); writeFileSync(path, marker);
  await expect(training.service.start(request)).rejects.toThrow("terminal");
  const prompts = loadPromptSnapshot();
  const config = resolvePipelineSettings({ defaultModel: "fixture/model", providers: {}, agent: { cwd: project.root, agentDir: project.root, initialPrompt: "" }, pipeline: { entryStage: "research", stages: { research: { enabled: true } } } } as any);
  const controllerStore = new StateStore(join(project.root, "controller"), initialState({ taskId: "fixture", taskFingerprint: "a".repeat(64), config, promptTemplates: prompts.serialize(), promptFingerprint: prompts.fingerprint, authorized: false }));
  controllerStore.transaction("official-prior", {}, state => { state.official = [{ attemptId: "official-1", score: 0.91, status: "scored", candidateId: identity, artifactId: "prior-receipt" }]; state.bestOfficial = state.official[0]; });
  const coordinator = new Coordinator(controllerStore, { start() { throw new Error("No model/stage dispatch in this fixture"); } });
  const pilot = await training.service.start({ ...request, hypothesis: "pilot cannot replace a terminal champion", pipeline: { ...request.pipeline, parameters: { c: 0.3 } }, scope: { kind: "pilot", maxFolds: 1 } });
  expect(await until(() => training.supervisor.status(pilot.id).status !== "running")).toBe(true); await training.service.finalize(pilot.id);
  expect(JSON.parse(tagMessage(project.solutionsRoot, "champion")!.message).experimentId).toBe(baseline.id);
  expect(developmentSelection(await collectTrainingResults(root), project.solutionsRoot, "fixture").valid).toBe(false);
  await expect(training.service.start({ ...request, pipeline: { ...request.pipeline, parameters: { c: 0.4 } }, cv: { ...request.cv, folds: 1 } })).rejects.toThrow();
  const changed = { ...request, hypothesis: "new fixed parameters independently measured", pipeline: { ...request.pipeline, parameters: { c: 0.5 } } };
  const next = await training.service.start(changed);
  const invocation = JSON.parse(readFileSync(join(next.directory, "invocation.json"), "utf8")); expect(invocation.champion).toBeUndefined();
  expect(await until(() => training.supervisor.status(next.id).status !== "running")).toBe(true); await training.service.finalize(next.id);
  const result = JSON.parse(readFileSync(join(next.directory, "trial-result.json"), "utf8")); expect(result.promotionEligible).toBe(true); expect(result.championComparison).toBeUndefined();
  expect(JSON.parse(tagMessage(project.solutionsRoot, "champion")!.message).experimentId).toBe(next.id);
  const selected = developmentSelection(await collectTrainingResults(root), project.solutionsRoot, "fixture"); expect(selected.selected?.experimentId).toBe(next.id); expect(selected.trials.length).toBe(3);
  expect(coordinator.state.bestOfficial).toMatchObject({ score: 0.91, candidateId: identity, artifactId: "prior-receipt" }); coordinator.close();
  expect(readFileSync(path, "utf8")).toBe(marker); expect(events.some(e => e.type === "training_terminal_champion_retained_as_history")).toBe(true);
  writeFileSync(path, "{}");
  expect(() => developmentSelection(selected, project.solutionsRoot, "fixture")).toThrow("Corrupt terminal");
 } finally { await training.close(); }
}, 60000);
