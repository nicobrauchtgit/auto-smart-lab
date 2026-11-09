import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareExperiments, experimentDirectory, experimentHistory } from "./experiments.js";
import { TaskKnowledge } from "./service.js";
import { ensureSolutionsRepository, git } from "../training/git.js";
import { setupChecks, SetupSession } from "../pipeline/setup.js";
import { loadPromptSnapshot } from "../prompts/loader.js";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));
const origin = { taskId: "fixture", datasetSha256: "a".repeat(64) };
function fixture() {
 const root = mkdtempSync(join(tmpdir(), "experiment-history-")); temporary.push(root);
 const parent = join(root, "training"), current = join(parent, "run-b");
 const write = (run: string, id: string, fields: Record<string, any> = {}) => {
  const path = join(parent, run, id); mkdirSync(path, { recursive: true });
  const save = (name: string, value: unknown) => writeFileSync(join(path, name), JSON.stringify(value));
  save("seed-plan.json", { ...origin, experimentId: id, ...fields.seed });
  save("request.json", { hypothesis: id, pipeline: { module: "solutions/model.py", factory: "build", estimatorParams: { depth: fields.depth ?? 1 } }, cv: { folds: 3 }, scope: { kind: fields.scope ?? "pilot" } });
  save("invocation.json", { experimentId: id, source: { commit: fields.commit ?? id, tree: id }, measurement: { kind: "classification" } });
  save("trial-result.json", { experimentId: id, status: fields.status ?? "completed", promotionEligible: false, metrics: fields.metrics ?? { balancedAccuracy: fields.score ?? .7 }, championComparison: fields.comparison, diagnostics: fields.diagnostics });
  return path;
 };
 return { root, parent, current, write };
}
test("history includes prior unpromoted, partial and failed trials, deduplicates roots and excludes other cohorts", () => {
 const f = fixture();
 f.write("run-a", "old", { scope: "promotion" });
 f.write("run-b", "current", { status: "partial" });
 f.write("run-b", "failed", { status: "failed" });
 f.write("run-a", "foreign", { seed: { datasetSha256: "b".repeat(64) } });
 const roots = [f.current, f.parent];
 const page = experimentHistory(roots, origin, 0, 2);
 expect(page.total).toBe(3); expect(page.omitted).toBe(1); expect(page.nextOffset).toBe(2);
 const next = experimentHistory(roots, origin, page.nextOffset!, 2);
 expect(next.experiments[0].reference).toEqual({ rootIndex: 1, run: "run-a", id: "old" });
 expect(next.experiments[0].scope).toBe("promotion");
 expect(next.experiments[0].authoritativeForCurrentRun).toBe(false);
 expect(next.nextOffset).toBeNull();
});
test("comparison reports changes and only matches retained paired receipts to exact experiment/source", () => {
 const f = fixture(); f.write("run-a", "old", { commit: "source-a", score: .9 });
 f.write("run-b", "new", { depth: 4, score: .95, comparison: { championExperimentId: "old", championCommit: "source-a", meanDifference: .01 } });
 const roots = [f.parent];
 const left = { rootIndex: 0, run: "run-a", id: "old" }, right = { rootIndex: 0, run: "run-b", id: "new" };
 const comparison = compareExperiments(roots, origin, left, right);
 expect(comparison.pipelineChanges).toEqual([{ field: "estimatorParams", before: { depth: 1 }, after: { depth: 4 } }]);
 expect(comparison.sourceChanged).toBe(true);
 expect(comparison.pairedComparisons.rightAgainstLeft).toMatchObject({ meanDifference: .01 });
 f.write("run-a", "same-code", { commit: "source-a" });
 expect(compareExperiments(roots, origin, { ...left, id: "same-code" }, right).pairedComparisons.rightAgainstLeft).toBeNull();
 expect(comparison).not.toHaveProperty("winner");
 const events: unknown[] = [];
 const knowledge = new TaskKnowledge({ root: join(f.root, "knowledge"), origin, trainingRoots: roots, record: (type, payload) => events.push({ type, payload }) });
 knowledge.history(); knowledge.compare(left, right);
 expect(events).toHaveLength(2);
});
test("history references reject traversal, symlinks, oversized metadata and unsupported bounds", () => {
 const f = fixture(); const path = f.write("run-a", "old");
 expect(() => experimentDirectory([f.parent], { rootIndex: 0, run: "../elsewhere", id: "old" })).toThrow();
 expect(() => experimentHistory([f.parent], origin, 0, 13)).toThrow();
 symlinkSync(join(f.parent, "run-a"), join(f.parent, "alias"));
 expect(() => experimentDirectory([f.parent], { rootIndex: 0, run: "alias", id: "old" })).toThrow("symlinks");
 writeFileSync(join(path, "request.json"), " ".repeat(1024 * 1024 + 1));
 expect(experimentHistory([f.parent], origin).omitted).toBe(1);
});
test("pipeline comparison returns the frozen source diff without running pipeline code", () => {
 const f = fixture(), repository = join(f.root, "solutions");
 ensureSolutionsRepository(repository);
 writeFileSync(join(repository, "model.py"), "depth = 1\n");
 expect(git(repository, ["add", "."]).status).toBe(0);
 expect(git(repository, ["commit", "-m", "before"]).status).toBe(0);
 const before = git(repository, ["rev-parse", "HEAD"]).stdout.trim();
 writeFileSync(join(repository, "model.py"), "depth = 4\n");
 expect(git(repository, ["add", "."]).status).toBe(0);
 expect(git(repository, ["commit", "-m", "after"]).status).toBe(0);
 const after = git(repository, ["rev-parse", "HEAD"]).stdout.trim();
 f.write("run-a", "old", { commit: before }); f.write("run-a", "new", { commit: after });
 const comparison = compareExperiments([f.parent], origin, { rootIndex: 0, run: "run-a", id: "old" }, { rootIndex: 0, run: "run-a", id: "new" }, repository);
 expect(comparison.code.available).toBe(true);
 expect(comparison.code.patch).toContain("-depth = 1"); expect(comparison.code.patch).toContain("+depth = 4");
 expect(readFileSync(join(repository, "model.py"), "utf8")).toBe("depth = 4\n");
});
test("observational turns can be compared and distilled into lessons without measured scores or champions", async () => {
 const f = fixture(); const service = new TaskKnowledge({ root: join(f.root, "knowledge"), origin: { ...origin, agentRunId: "turn-session" } });
 const draft = { title: "Earlier attempt", summary: "Fit stalled", body: "The process stopped making progress during this attempt.", status: "observation" as const,
  tags: ["runtime"], applicability: "Expensive models", caveats: "Cause remains untested" };
 const first = await service.capture(draft);
 const second = await service.capture({ ...draft, title: "Later attempt", summary: "Fit completed", body: "Smaller batches completed within the observed time budget." });
 const comparison: any = await service.compareNotes(first.id, second.id);
 expect(comparison.left.evidenceStatus).toBe("agent_assertion"); expect(comparison.right.evidenceStatus).toBe("agent_assertion");
 expect(comparison.left.author.agentRunId).toBe("turn-session");
 const lesson = await service.capture({ ...draft, title: "Batch-size hypothesis", status: "hypothesis", body: "Reducing batches may improve progress; test this under matched budgets.",
  reusable: { lesson: "Use a small pilot to investigate stalled fits", applicability: "Expensive iterative estimators", caveats: "The earlier observations do not establish causality" } });
 expect((await service.read(lesson.id) as any).reusable.lesson).toContain("pilot");
 await service.capture({ ...draft, summary: "Cause investigated", caveats: "New observation narrows the hypothesis" }, undefined, { id: first.id, expectedRevision: 1 });
 const revisions: any = await service.compareNotes(first.id, first.id, 1, 2);
 expect(revisions.left.summary).toBe("Fit stalled"); expect(revisions.right.summary).toBe("Cause investigated");
 expect(revisions.left.historicalRevision).toBe(true);
 await expect(service.read(first.id, 99)).rejects.toThrow("revision unavailable");
 expect(service.history().experiments).toEqual([]);
});
test("history prerequisites fail before execution without requiring credentials or git for note-only sessions", async () => {
 const options = { taskId: "fixture", prompts: loadPromptSnapshot(), executables: { git: "/missing/history-git" } };
 let started = false;
 await expect((async () => {
  await new SetupSession().check(setupChecks(["knowledge-history"], options), new AbortController().signal, () => {});
  started = true;
 })()).rejects.toThrow("knowledge-history-git");
 expect(started).toBe(false);
 expect(setupChecks(["knowledge"], options).some(check => check.id === "knowledge-history-git")).toBe(false);
});
test("champion-free attempts expose runtime and proxy signals independently of a quality score", () => {
 const f = fixture();
 f.write("run-a", "signals", { metrics: {}, diagnostics: { kind: "anomaly_detection", proxyEvidence: true, fitSeconds: { mean: 2 }, stability: { available: true, summary: { mean: .8 } } } });
 const row = experimentHistory([f.parent], origin).experiments[0];
 expect(row.metrics).toEqual({});
 expect(row.signals).toMatchObject({ proxyEvidence: true, fitSeconds: { mean: 2 }, stability: { summary: { mean: .8 } } });
 expect(row.authoritativeForCurrentRun).toBe(false);
});
