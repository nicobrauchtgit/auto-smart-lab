import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { digest, KnowledgeStore, type KnowledgeDraft, type KnowledgeOrigin } from "./store.js";
import { TaskKnowledge, createKnowledgeTools, selectedKnowledge, knowledgeInput } from "./service.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { setupChecks, SetupSession } from "../pipeline/setup.js";
import { createSeedPlan, deriveTrialSeed, serializeSeedPlan } from "../training/seeds.js";
import { trainingEnvironment, PYTHON, WORKER } from "../training/testing.js";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
const temp = () => { const root = mkdtempSync(join(tmpdir(), "task-knowledge-")); roots.push(root); return root; };
const origin: KnowledgeOrigin = { taskId: "fixture", datasetSha256: "a".repeat(64), pipelineRunId: "pipeline", stageInvocationId: "invocation" };
const draft: KnowledgeDraft = { title: "Grouped validation avoids near duplicates", summary: "Duplicated documents need group-aware comparison", body: "An inspection suggested near duplicates across folds; test grouped folds before interpreting improvement.",
 tags: ["validation", "duplicates"], status: "hypothesis", applicability: "Corpora with duplicates", caveats: "Not measured; do not infer a score improvement",
 reusable: { lesson: "Inspect near duplicates when choosing validation", applicability: "Document corpora", caveats: "Validate grouping on the new dataset" } };
const make = (root = temp(), scope = origin) => new TaskKnowledge({ root: join(root, "knowledge"), origin: scope });

test("capture/reload/dedup preserves identity, provenance, checksummed revisions and readable Markdown", async () => {
 const root = temp(); const events: any[] = []; const inputs: any[] = [];
 const options = { root: join(root, "knowledge"), origin, record: (type: string, payload: any) => events.push({ type, ...payload }), reportInput: (input: any) => inputs.push(input) };
 const service = new TaskKnowledge(options); service.bindAgent("agent-1");
 const first = await service.capture(draft);
 expect((await service.capture(draft)).deduplicated).toBe(true);
 const restarted = new TaskKnowledge(options); const read: any = await restarted.read(first.id);
 expect(read.author.agentRunId).toBe("agent-1"); expect(read.origin.pipelineRunId).toBe("pipeline");
 expect(read.evidenceStatus).toBe("agent_assertion"); expect(read.authoritativeForCurrentRun).toBe(false);
 expect(read.sha256).toHaveLength(64);
 const event = events.find(e => e.artifact); expect(digest(readFileSync(event.artifact))).toBe(event.artifact_sha256);
 expect(readFileSync(event.artifact, "utf8")).toContain(draft.body);
 expect(inputs.at(-1).content_sha256).toBe(digest(JSON.stringify(read)));
 expect(events.at(-1).stageInvocationId).toBe("invocation");
});

test("optimistic updates retain history and reject competing writers, different origins and duplicate titles", async () => {
 const service = make(); const first = await service.capture(draft);
 await service.capture({ ...draft, caveats: "Inspection disproved the initial hypothesis", lifecycle: "stale" }, undefined, { id: first.id, expectedRevision: 1 });
 await expect(service.capture(draft, undefined, { id: first.id, expectedRevision: 1 })).rejects.toThrow("conflict");
 const other = new TaskKnowledge({ root: service.store.root, origin: { ...origin, datasetSha256: "b".repeat(64) } });
 await expect(other.capture(draft, undefined, { id: first.id, expectedRevision: 2 })).rejects.toThrow("another task or dataset");
 await expect(service.capture(draft)).rejects.toThrow("title exists");
 const read: any = await service.read(first.id); expect(read.history[0].revision).toBe(1); expect(read.lifecycle).toBe("stale");
 expect(service.search("duplicates")).toEqual([]);
 mkdirSync(join(service.store.root, ".write-lock"));
 await expect(service.capture({ ...draft, title: "new note" })).rejects.toThrow("writer busy");
 expect(() => service.store.preflight()).toThrow("lock exists");
});

test("independent processes cannot lose concurrent updates to a durable revision", async () => {
 const service = make(); const first = await service.capture(draft);
 const run = (caveats: string) => {
  const program = `import {KnowledgeStore} from ${JSON.stringify(resolve("agent/knowledge/store.ts"))};
   try { new KnowledgeStore(${JSON.stringify(service.store.root)}).capture(${JSON.stringify(origin)}, ${JSON.stringify({ ...draft, caveats })}, undefined, ${JSON.stringify({ id: first.id, expectedRevision: 1 })}); }
   catch { process.exit(11); }`;
  return Bun.spawn([process.execPath, "-e", program], { stdout: "ignore", stderr: "ignore" });
 };
 const processes = [run("Writer one narrowed applicability"), run("Writer two narrowed applicability")];
 expect((await Promise.all(processes.map(process => process.exited))).sort()).toEqual([0, 11]);
 const read: any = await service.read(first.id); expect(read.revision).toBe(2); expect(read.history).toHaveLength(1);
});

test("bounded relevant retrieval separates reusable applicability from task details and measurements", async () => {
 const service = make(); const first = await service.capture({ ...draft, body: "PRIVATE_ROW_MARKER: inspection only", summary: "PRIVATE_SUMMARY duplicates" });
 for (let i = 0; i < 15; i++) await service.capture({ ...draft, title: `duplicate lesson ${i}` });
 expect(service.search("duplicates", 3)).toHaveLength(3);
 expect(service.search("unrelated tokens")).toEqual([]);
 expect(() => service.search("duplicates", 13)).toThrow();
 const other = new TaskKnowledge({ root: service.store.root, origin: { ...origin, taskId: "another", datasetSha256: "b".repeat(64) } });
 const found = other.search("validation"); expect(found.length).toBeGreaterThan(0);
 expect(JSON.stringify(found)).not.toContain("PRIVATE");
 const read: any = await other.read(first.id); expect(read.reusable).toEqual(draft.reusable);
 expect(JSON.stringify(read)).not.toContain("PRIVATE"); expect(read.evidenceStatus).toBe("origin_lesson_requires_validation");
 const privateNote = await service.capture({ ...draft, title: "task only", reusable: undefined });
 await expect(other.read(privateNote.id)).rejects.toThrow("dataset mismatch");
 expect(other.search("PRIVATE_ROW_MARKER")).toEqual([]);
});

test("multilingual captures enforce byte bounds and accepted lessons remain readable", async () => {
 const service = make();
 await expect(service.capture({ ...draft, body: "界".repeat(6000) })).rejects.toThrow("UTF-8 byte limit");
 expect(service.search("duplicates")).toHaveLength(0);
 const multilingual = { ...draft, body: "界".repeat(2000), applicability: "界".repeat(333), caveats: "界".repeat(333),
  reusable: { lesson: "界".repeat(400), applicability: "界".repeat(333), caveats: "界".repeat(333) } };
 const captured = await service.capture(multilingual);
 const reloaded = new TaskKnowledge({ root: service.store.root, origin });
 const result: any = await reloaded.read(captured.id);
 expect(result.body).toBe(multilingual.body);
 expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32768);
});

test("safe paths, corruption, unknown fields, oversized input, secret dumps and invented scores fail closed", async () => {
 const root = temp(); const service = make(root);
 await expect(service.capture({ ...draft, status: "empirical" })).rejects.toThrow("harness evidence");
 for (const invalid of [{ ...draft, score: .99 }, { ...draft, body: "x".repeat(6001) }, { ...draft, body: "api_key=PRIVATE_TOKEN" }, { ...draft, body: "sealed_labels=0,1" }]) {
  await expect(service.capture(invalid as KnowledgeDraft)).rejects.toThrow();
 }
 await service.capture(draft);
 const path = join(service.store.root, "index.json"); const state = JSON.parse(readFileSync(path, "utf8"));
 state.notes[0].revisions[0].body = "silently altered"; writeFileSync(path, JSON.stringify(state));
 expect(() => service.search("duplicates")).toThrow("Corrupt"); expect(() => service.store.preflight()).toThrow();
 symlinkSync(service.store.root, join(root, "alias")); expect(() => new KnowledgeStore(join(root, "alias"))).toThrow("symlinks");
 symlinkSync(join(root, "missing"), join(root, "dangling")); expect(() => new KnowledgeStore(join(root, "dangling"))).toThrow("symlinks");
 await expect(service.read("../../outside")).rejects.toThrow("Invalid knowledge ID");
});

test("altered readable Markdown mirrors fail closed rather than silently becoming runtime guidance", async () => {
 const service = make(); const note = await service.capture(draft);
 writeFileSync(join(service.store.root, `${note.id}-v1.md`), "Fabricated verified result");
 expect(() => service.store.preflight()).toThrow("Markdown revision");
 await expect(service.read(note.id)).rejects.toThrow("Markdown revision");
});

test("oversized stored evidence metadata is progressively disclosed and an unvalidated receipt stays stale", async () => {
 const service = make(); const oversized = { explanatoryText: "x".repeat(12000) };
 // Exercise the internal persistence boundary with a synthetic receipt. Runtime agents
 // cannot call this API or supply receipts; the public read must still distrust it.
 const captured = service.store.capture(origin, { ...draft, status: "empirical" }, {
  producer: "training-harness", experimentId: "invented", taskId: origin.taskId, datasetSha256: origin.datasetSha256,
  scope: "promotion", source: oversized, parameters: oversized, cv: oversized,
  metrics: { balancedAccuracy: .99 }, artifacts: [{ path: "/not-supplied/invocation.json", sha256: "b".repeat(64) }],
 });
 const read: any = await service.read(captured.note.id);
 expect(read.evidenceStatus).toBe("stale_or_unavailable"); expect(read.authoritativeForCurrentRun).toBe(false);
 expect(read.evidence.parameters.content_sha256).toBe(digest(JSON.stringify(oversized)));
 expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThan(32768);
});

test("whole-chain preflight checks skill templates and store locally without provider calls or writes", async () => {
 const root = temp(); const knowledgeRoot = join(root, "knowledge");
 const checks = setupChecks(["knowledge"], { taskId: "fixture", prompts: loadPromptSnapshot(), knowledgeRoot });
 expect(checks.every(c => c.phase === "local")).toBe(true);
 await new SetupSession().check(checks, new AbortController().signal, () => {});
 expect(new KnowledgeStore(knowledgeRoot).notes()).toEqual([]);
 const brokenPrompts = { fingerprint: "fixture", render() { throw new Error("missing skill"); } } as any;
 let started = false;
 await expect((async () => {
  await new SetupSession().check(setupChecks(["knowledge"], { taskId: "fixture", prompts: brokenPrompts, knowledgeRoot }), new AbortController().signal, () => {});
  started = true;
 })()).rejects.toThrow("knowledge-skills"); expect(started).toBe(false);
 writeFileSync(join(root, "blocked"), "file");
 await expect(new SetupSession().check(setupChecks(["knowledge"], { taskId: "fixture", prompts: loadPromptSnapshot(), knowledgeRoot: join(root, "blocked", "nested") }), new AbortController().signal, () => {})).rejects.toThrow("knowledge-store");
});

test("selected skill snapshots remain immutable and distinct from typed knowledge inputs", () => {
 const root = temp(); cpSync(resolve("agent/prompts"), root, { recursive: true });
 const snapshot = loadPromptSnapshot(root); const before = selectedKnowledge(snapshot);
 writeFileSync(join(root, "knowledge/task-knowledge/SKILL.md"), "changed");
 expect(selectedKnowledge(snapshot)).toEqual(before);
 expect(selectedKnowledge(loadPromptSnapshot(root))[0].reference.template_sha256).not.toBe(before[0].reference.template_sha256);
 expect(before.map(s => s.reference.id)).toEqual(["knowledge.task", "knowledge.refresh"]);
 expect(knowledgeInput({ root, origin })).not.toHaveProperty("template_sha256");
 expect(createKnowledgeTools(make(), snapshot).map(t => t.name)).toEqual(["knowledge_search", "knowledge_read", "knowledge_capture"]);
});

// Real supervised worker output, no provider. Knowledge neither trains nor promotes.
test("existing harness evidence validates measurements and origin; wrong dataset, forged scope and stale artifacts never become authoritative", async () => {
 const root = temp(); const training = join(root, "training"), directory = join(training, "fixture");
 mkdirSync(directory, { recursive: true }); mkdirSync(join(root, "solutions"));
 writeFileSync(join(root, "solutions/model.py"), 'from sklearn.dummy import DummyClassifier\ndef build_pipeline():\n return DummyClassifier(strategy="most_frequent")\n');
 const zip = join(root, "train.zip"), labels = join(root, "dev.labels");
 writeFileSync(labels, Array.from({ length: 8 }, (_, i) => `row-${i};${i % 2}\n`).join(""));
 const made = spawnSync(PYTHON, ["-c", 'import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1], "w") as z:\n for i in range(8): z.writestr(f"row-{i}", f"text {i}")', zip], { env: trainingEnvironment(), encoding: "utf8" });
 expect(made.status).toBe(0);
 const datasetSha256 = digest(Buffer.concat([readFileSync(zip), readFileSync(labels)]));
 const request = { schemaVersion: 1, hypothesis: "fixture", pipeline: { module: "solutions/model.py", factory: "build_pipeline" }, cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 }, scope: { kind: "promotion" } };
 const seeds = createSeedPlan({ rootSeed: 1, taskId: origin.taskId, datasetSha256, experimentId: "fixture" });
 writeFileSync(join(directory, "seed-plan.json"), serializeSeedPlan(seeds)); writeFileSync(join(directory, "request.json"), JSON.stringify(request));
 const invocation = { schemaVersion: 1, experimentId: "fixture", request, inputs: { projectRoot: root, zipPath: zip, labelsPath: labels, outputDir: directory }, seeds: { experiment: seeds.experimentSeed, trial: deriveTrialSeed(seeds, 0) } };
 writeFileSync(join(directory, "invocation.json"), JSON.stringify(invocation));
 const fitted = spawnSync(PYTHON, [WORKER, "--invocation", join(directory, "invocation.json")], { env: trainingEnvironment(), encoding: "utf8", timeout: 30000 });
 if (fitted.status !== 0) throw new Error(fitted.stderr);
 const recovery = { taskId: origin.taskId, datasetSha256, invocationHash: digest(readFileSync(join(directory, "invocation.json"))), originPipelineRunId: "original-pipeline", originStageInvocationId: "original-invocation" };
 writeFileSync(join(directory, "recovery.json"), JSON.stringify(recovery));
 const service = new TaskKnowledge({ root: join(root, "knowledge"), origin: { ...origin, datasetSha256 }, trainingRoots: [training] });
 const empirical = { ...draft, status: "empirical" as const, body: "The harness run completed; no comparison or causal claim is supported." };
 const first = await service.capture(empirical, { rootIndex: 0, id: "fixture" });
 const read: any = await service.read(first.id);
 expect(read.evidenceStatus).toBe("verified_historical_harness_measurement"); expect(read.evidence.metrics.balancedAccuracy).toBe(.5);
 expect(read.evidence.pipelineRunId).toBe("original-pipeline"); expect(read.evidence.stageInvocationId).toBe("original-invocation");
 expect(read.evidence.cv.completedFolds).toBe(2); expect(read.authoritativeForCurrentRun).toBe(false);
 for (const [id, options] of [["pilot", { scope: { kind: "pilot", maxRows: 6, maxFolds: 1 } }],
  ["search", { schemaVersion: 2, search: { sampler: "grid", space: { strategy: { type: "categorical", choices: ["most_frequent", "prior"] } }, maxConfigs: 2 } }]] as const) {
  const output = join(training, id); mkdirSync(output);
  const configured = { ...request, ...options };
  const seed = createSeedPlan({ rootSeed: 1, taskId: origin.taskId, datasetSha256, experimentId: id });
  writeFileSync(join(output, "seed-plan.json"), serializeSeedPlan(seed)); writeFileSync(join(output, "request.json"), JSON.stringify(configured));
  writeFileSync(join(output, "invocation.json"), JSON.stringify({ ...invocation, schemaVersion: configured.schemaVersion, experimentId: id, request: configured,
   inputs: { ...invocation.inputs, outputDir: output }, seeds: { experiment: seed.experimentSeed, trial: deriveTrialSeed(seed, 0) } }));
  const fit = spawnSync(PYTHON, [WORKER, "--invocation", join(output, "invocation.json")], { env: trainingEnvironment(), encoding: "utf8", timeout: 30000 });
  if (fit.status !== 0) throw new Error(fit.stderr);
  const collection = await (await import("../training/results.js")).collectTrainingResults(training);
  const check = collection.trials.find(t => t.experimentId === id); if (!check?.valid) throw new Error(JSON.stringify({id,errors:check?.errors}));
  const captured = await service.capture({ ...empirical, title: `Measured ${id}` }, { rootIndex: 0, id });
  const measured: any = await service.read(captured.id);
  expect(measured.evidenceStatus).toBe("verified_historical_harness_measurement"); expect(measured.evidence.cv.search).toBe(id === "search");
  expect(measured.authoritativeForCurrentRun).toBe(false);
  if (id === "search") {
   const report = JSON.parse(readFileSync(join(output, "search-report.json"), "utf8"));
   const winner = report.leaderboard.find((row: any) => row.configId === measured.evidence.parameters.searchWinner.configId);
   expect(measured.evidence.parameters.searchWinner.searched).toEqual(winner.params);
  }
 }
 writeFileSync(join(root, "solutions/model.py"), 'raise RuntimeError("User model must not be imported for knowledge verification")\n');
 expect((await service.read(first.id) as any).evidenceStatus).toBe("verified_historical_harness_measurement");
 const resultPath = join(directory, "trial-result.json"), metricsPath = join(directory, "metrics.json");
 const resultBytes = readFileSync(resultPath, "utf8"), metricsBytes = readFileSync(metricsPath, "utf8");
 const falsified = JSON.parse(resultBytes); falsified.metrics.balancedAccuracy = .99;
 writeFileSync(resultPath, JSON.stringify(falsified)); writeFileSync(metricsPath, JSON.stringify(falsified));
 await expect(service.capture({ ...empirical, title: "Invented measurement" }, { rootIndex: 0, id: "fixture" })).rejects.toThrow("measurement verification failed");
 expect((await service.read(first.id) as any).evidenceStatus).toBe("stale_or_unavailable");
 writeFileSync(resultPath, resultBytes); writeFileSync(metricsPath, metricsBytes);
 const wrong = new TaskKnowledge({ root: join(root, "other"), origin, trainingRoots: [training] });
 await expect(wrong.capture(empirical, { rootIndex: 0, id: "fixture" })).rejects.toThrow("dataset mismatch");
 await expect(service.capture(empirical, { rootIndex: 1, id: "fixture" })).rejects.toThrow("root unavailable");
 await expect(service.capture(empirical, { rootIndex: 0, id: "../refit" })).rejects.toThrow("Invalid harness");
 writeFileSync(join(directory, "oof_predictions.csv"), readFileSync(join(directory, "oof_predictions.csv"), "utf8") + "\n");
 expect((await service.read(first.id) as any).evidenceStatus).toBe("stale_or_unavailable");
 writeFileSync(labels, "changed development data\n");
 await expect(service.capture({ ...empirical, title: "new result" }, { rootIndex: 0, id: "fixture" })).rejects.toThrow("dataset changed");
}, 60000);
