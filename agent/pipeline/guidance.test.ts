import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { guidanceHash, validateGuidance, type StageGuidance, type StageFeedback } from "./guidance.js";
import { InvocationFeedback } from "./feedback.js";
import { spamConfiguration } from "./task_configuration.testing.js";
import type { TaskConfiguration } from "./task_configuration.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { prepareResearchPrompts } from "../prompts/research.js";
import { prepareSolvePrompts } from "../prompts/solve.js";
import { startStageInvocation } from "./executor.js";
import { STAGE_REGISTRY } from "./registry.js";
import { resolvePipelineSettings } from "./config.js";
import type { PipelineConfig } from "../pipeline_config.js";
import type { StageArtifact, StageReporter } from "./types.js";
const prompts = loadPromptSnapshot();
export function note(stage: StageGuidance["stage"] = "research"): StageGuidance {
 const body = { id: "note-1", version: 1, stage, taskId: "fixture", content: "Investigate {{literal}} shift", objective: "Measure transfer risk", evidence: [] };
 return { ...body, contentSha256: guidanceHash(body) };
}
function feedback(id = "feedback-1"): StageFeedback {
 const body = { id, stage: "research" as const, taskId: "fixture", content: "Observed distribution changed", evidence: [] };
 return { ...body, contentSha256: guidanceHash(body) };
}
const report = (inputs: any[] = [], events: any[] = []): StageReporter => ({
 input: input => inputs.push(input), event: (type, payload) => events.push({ type, ...payload }),
 agentIdentity: () => ({ pipelineRunId: "run", stageInvocationId: "invocation" }), observation: () => { throw new Error("No providers in this fixture"); },
});
test("guidance validates bounds, variables, hashes and task/stage; deeply immutable", () => {
 const raw = note(); const snapshot = validateGuidance(raw, "research", "fixture", []);
 raw.content = "revision"; expect(snapshot.content).toContain("{{literal}}"); expect(Object.isFrozen(snapshot.evidence)).toBe(true);
 for (const mutation of [ { content: "x".repeat(8193) }, { content: "stale" }, { taskId: "wrong" }, { stage: "solve" }, { version: 0 }, { variables: {} }, { evidence: Array(17).fill({}) } ]) {
  expect(() => validateGuidance({ ...note(), ...mutation } as any, "research", "fixture", [])).toThrow();
 }
 expect(() => validateGuidance(note("refit"), "refit", "fixture", [])).toThrow(/unsupported/);
 expect(() => validateGuidance(note("submit"), "submit", "fixture", [])).toThrow(/unsupported/);
});
test("evidence must match unique producer/task/dataset/candidate and current bytes", () => {
 const root = mkdtempSync(join(tmpdir(), "guidance-evidence-"));
 try {
  const path = join(root, "measurement.json"); writeFileSync(path, "measured");
  const ref = { artifactId: "evidence", taskId: "fixture", pipelineRunId: "prior-run", invocationId: "producer", sha256: createHash("sha256").update("measured").digest("hex"), datasetSha256: "d".repeat(64), candidateId: "candidate" };
  const artifact: StageArtifact = { kind: "measurement", path, sha256: ref.sha256, provenance: ref };
  const { contentSha256: _, ...body } = note(); body.evidence = [ref] as any;
  const n = { ...body, contentSha256: guidanceHash(body) };
  expect(validateGuidance(n, "research", "fixture", [artifact]).evidence).toEqual([ref]);
  expect(() => validateGuidance(n, "research", "fixture", [artifact, artifact])).toThrow(/ambiguous/);
  expect(() => validateGuidance(n, "research", "fixture", [{ ...artifact, provenance: { ...ref, candidateId: "other" } }])).toThrow(/provenance/);
  writeFileSync(path, "changed"); expect(() => validateGuidance(n, "research", "fixture", [artifact])).toThrow(/Stale evidence/);
 } finally { rmSync(root, { recursive: true, force: true }); }
});
test("unguided research and solve prompts remain byte-compatible; guidance is separate prompt identity", () => {
 const base = prepareResearchPrompts(prompts, { taskId: "fixture", contextHash: "context" });
 const guided = prepareResearchPrompts(prompts, { taskId: "fixture", contextHash: "context", guidance: note() });
 expect(base.prompt).toBe([prompts.render("research.start", { taskId: "fixture", contextHash: "context", startupContext: "" }).text, prompts.render("research.test-distribution", {}).text].join("\n\n"));
 expect(guided.prompt).toContain("{{literal}}"); expect(guided.promptReferences.filter(p => p.id !== "shared.stage-guidance").map(p => [p.id, p.template_sha256])).toEqual(base.promptReferences.map(p => [p.id, p.template_sha256]));
 const input = { taskId: "fixture", workspace: "/tmp", datasetPaths: [], configuration: spamConfiguration(), targets: "/tmp/labels", rowCount: 10, targetSummary: "balanced", foldRecommendation: "two", researchState: "prior", maxIterations: 1 };
 const plain = prepareSolvePrompts(prompts, input); const withNote = prepareSolvePrompts(prompts, { ...input, guidance: note("solve") });
 expect(withNote.prompt).toContain(plain.prompt.split("\n\n")[0]); expect(withNote.prompt).toContain("Base stage contracts remain authoritative");
 const retry = prepareResearchPrompts(prompts, { taskId: "fixture", contextHash: "context", guidance: note(), failedChecks: ["source missing"] });
 expect(retry.prompt).toContain(guided.prompt);
});
test("feedback receipts persist, deduplicate, await request admission, survive retry and settle terminally", async () => {
 const root = mkdtempSync(join(tmpdir(), "feedback-"));
 try {
  const inputs: any[] = []; const events: any[] = [];
  const f = new InvocationFeedback({ stage: "research", taskId: "fixture", catalog: [], prompts, report: report(inputs, events), journalPath: join(root, "receipts.jsonl") });
  const n = feedback(); expect((await f.send(n)).status).toBe("queued");
  let admitted: (() => void) | undefined; let count = 0;
  const first = { async deliverFeedback() { return false; } };
  await f.bind(first); f.unbind(first); expect(f.state).toBe("between-attempts");
  await f.bind({ async deliverFeedback(id, text, delivered, reference) {
   expect(reference).toEqual(prompts.render("shared.stage-feedback", { note: JSON.stringify(feedback(id)) }).reference);
   expect(text).toContain(n.content);
   count++; admitted = delivered; return true;
  } });
  expect((await f.send(n)).status).toBe("queued"); expect(count).toBe(1);
  admitted!(); expect((await f.send(n)).status).toBe("delivered");
  await expect(f.send({ ...n, content: "forged same hash" })).rejects.toThrow(/hash/);
  expect(inputs).toHaveLength(1);
  await f.send(feedback("pending")); await f.finish(); admitted!();
  expect((await f.send(feedback("pending"))).status).toBe("refused");
  expect((await f.send(feedback("late"))).nextInvocation).toBe(true);
  const journal = readFileSync(join(root, "receipts.jsonl"), "utf8"); expect(journal).toContain('"status":"delivered"'); expect(journal).toContain('"status":"refused"');
 } finally { rmSync(root, { recursive: true, force: true }); }
});
test("unsupported feedback refuses without starting a session", async () => {
 const root = mkdtempSync(join(tmpdir(), "feedback-refit-"));
 try {
  const f = new InvocationFeedback({ stage: "refit", taskId: "fixture", catalog: [], prompts, report: report(), journalPath: join(root, "receipt") });
  expect((await f.send(feedback())).reason).toBe("Feedback unsupported");
  await f.finish();
  const late = await f.send(feedback("late-refit")); expect(late.reason).toBe("Feedback unsupported"); expect(late.nextInvocation).toBe(false);
 } finally { rmSync(root, { recursive: true, force: true }); }
});
test("executor snapshots before awaits, rejects invalid guidance before stage, honors cancellation despite valid artifacts", async () => {
 const root = mkdtempSync(join(tmpdir(), "guidance-executor-")); const original = STAGE_REGISTRY.research;
 try {
  const events: any[] = [], inputs: any[] = []; let calls = 0; let unblock!: () => void;
  STAGE_REGISTRY.research = { name: "research", version: 1, description: "fixture", parseOptions: () => ({}), checkInput() {}, async run(context) {
   calls++; expect(context.input.guidance?.content).toBe(note().content); expect(Object.isFrozen(context.input.guidance)).toBe(true);
   await new Promise<void>(resolve => { unblock = resolve; }); return { artifacts: [], validation: { valid: true, errors: [] } };
  } };
  const config = resolvePipelineSettings({ pipeline: { entryStage: "research", stages: { research: { enabled: true } } }, agent: { cwd: ".", agentDir: ".", initialPrompt: "" }, providers: {}, defaultModel: "fixture/model" } as PipelineConfig);
  const trace = { pipelineRunId: "run", artifactRoot: join(root, "trace"), telemetry: { checkLocal() {}, async checkAccess() {} }, stage: () => ({ ...report(inputs, events), inputs: () => inputs }) } as any;
  const n = note(); const handle = startStageInvocation({ stage: "research", input: { taskId: "fixture", taskConfiguration: spamConfiguration(), upstream: [], guidance: n }, config, trace, prompts });
  n.content = "changed after start";
  while (!unblock) await new Promise(resolve => setTimeout(resolve, 1));
  handle.cancel(); unblock(); expect((await handle.result).outcome).toBe("cancelled");
  expect((await handle.feedback(feedback("cancelled"))).status).toBe("refused");
  const guidanceInput = inputs.find(input => input.kind === "stage_guidance");
  expect(guidanceInput.content_sha256).toBe(note().contentSha256); expect(guidanceInput.snapshot_sha256).not.toBe(note().contentSha256);
  expect(readFileSync(guidanceInput.artifact, "utf8")).toContain("{{literal}}");
  const invalid = startStageInvocation({ stage: "research", input: { taskId: "fixture", taskConfiguration: spamConfiguration(), upstream: [], guidance: n }, config, trace, prompts });
  expect((await invalid.result).outcome).toBe("failure"); expect(calls).toBe(1);
 } finally { STAGE_REGISTRY.research = original; rmSync(root, { recursive: true, force: true }); }
});

test("feedback keeps all dedup IDs under a fixed total receipt/byte budget", async () => {
 const root = mkdtempSync(join(tmpdir(), "feedback-bounds-"));
 try {
  const f = new InvocationFeedback({ stage: "research", taskId: "fixture", catalog: [], prompts, report: report(), journalPath: join(root, "receipts") });
  const huge = feedback("huge"); huge.content = "x".repeat(8193); const { contentSha256: _, ...body } = huge; huge.contentSha256 = guidanceHash(body);
  await expect(f.send(huge)).rejects.toThrow(/oversized/);
  for (let i = 0; i < 64; i++) await f.send(feedback(`bounded-${i}`));
  await expect(f.send(feedback("overflow"))).rejects.toThrow(/budget/);
  expect((await f.send(feedback("bounded-0"))).status).toBe("queued");
  const changed = feedback("bounded-0"); changed.content = "different"; const { contentSha256: ignored, ...changedBody } = changed; changed.contentSha256 = guidanceHash(changedBody);
  await expect(f.send(changed)).rejects.toThrow(/reused/);
  await f.finish(); expect((await f.send(feedback("bounded-0"))).status).toBe("refused");
 } finally { rmSync(root, { recursive: true, force: true }); }
});
