import { testTelemetry, traceEvents } from "../telemetry/testing.js";
import { guidanceHash } from "../pipeline/guidance.js";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { createEvaluateStage } from "../pipeline/stages/evaluate.js";
import { validateReview, reviewerTools } from "./reviewer.js";
import type { EvaluationEvidence } from "./evidence.js";
import { spamConfiguration } from "../pipeline/task_configuration.testing.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";

const review = { readinessScore: 3, readinessRationale: "Concern 1: lower class 0 recall needs investigation; current source is not bound to training.", status: "concerns", assessment: "OOF balanced accuracy is 0.75; generalization is uncertain.",
 concerns: [{ severity: "medium", finding: "Class 0 recall is lower", evidence: "Recall 0.5 vs 1.0" }],
 limitations: ["No group attributes; demographic bias cannot be assessed"], recommendations: ["Inspect false positives"] };
function evidence(directory: string): EvaluationEvidence {
 return { directory, experimentId: "fixture", sources: [],
  diagnostics: { summary: { balancedAccuracy: .75 }, curves: { available: false, reason: "No scores" }, folds: [], limitations: ["Development only"] },
  candidate: { request: undefined, trialsConsidered: 1, eligibleTrials: 1, measurementKind: "classification", selectionRule: "fixture" } };
}
test("review schema fails closed and preserves evidence-linked concerns", () => {
 expect(validateReview(review).status).toBe("concerns");
 for (const bad of [null, {}, { ...review, limitations: [] }, { ...review, recommendations: ['a','b','c','d'] }, { ...review, concerns: [{ severity: "high", finding: "bias" }] }]) {
  expect(() => validateReview(bad)).toThrow();
 }
});
test("inspection budget is advisory; tools allow more than fifteen lookups and one validated report", async () => {
 const reviewer = reviewerTools(evidence('/tmp/fixture'), loadPromptSnapshot());
 for (let i = 0; i < 16; i++) await reviewer.tools[0].execute('id', { section: 'folds' }, undefined, undefined, undefined as never);
 expect(loadPromptSnapshot().render("review.system", {}).text).toContain("budget of 15 turns");
 await reviewer.tools[1].execute('id', review as any, undefined, undefined, undefined as never);
 await expect(reviewer.tools[1].execute('id', review as any, undefined, undefined, undefined as never)).rejects.toThrow("already recorded");
 expect(reviewer.result()?.status).toBe("concerns");
});
for (const mode of ['success', 'no-report', 'session-failure', 'cancelled'] as const) {
 test(`stage ${mode}: evidence and session are observed; session completion alone is insufficient`, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'evaluation-stage-'));
  const events: string[] = [], inputs: unknown[] = [];
  const controller = new AbortController();
  const observation = { identity: {}, sink: { record() {} } } as any;
  try {
   const guidanceBody = { id: "review-note", version: 1, taskId: "fixture", stage: "evaluate" as const, content: "REVIEW_GUIDANCE", evidence: [] };
   const guidance = { ...guidanceBody, contentSha256: guidanceHash(guidanceBody) };
   const stage = createEvaluateStage({ prepareEvidence: async () => evidence(directory), runSession: async options => {
    expect(options.tools).toEqual([]);
    expect(options.extensions).toBe(false);
    expect(options.observe).toBe(observation);
    expect(options.prompt).toContain('Model review skill');
    expect(options.prompt).toContain('REVIEW_GUIDANCE');
    expect(options.promptReferences.map(p => p.id)).toContain('shared.stage-guidance');
    expect(options.promptReferences.map(p => p.id)).toContain('review.guide');
    if (mode === 'session-failure') throw new Error('SECRET provider exception');
    if (mode === 'cancelled') { controller.abort(); throw new Error('cancelled'); }
    if (mode === 'success') await options.customTools![1].execute('id', review as any, undefined, undefined, undefined as never);
    return { output: 'Done; APPROVE' };
   } });
   const pending = stage.run({ prompts: loadPromptSnapshot(), input: { taskId: 'fixture', taskConfiguration: spamConfiguration(), upstream: [], guidance },
    options: stage.parseOptions(undefined), signal: controller.signal,
    report: { event: type => events.push(type), input: (i: unknown) => inputs.push(i), agentIdentity: () => ({ stageInvocationId: 'invocation' }) as any, observation: () => observation as any } });
   if (mode === 'cancelled') { await expect(pending).rejects.toThrow(); return; }
   const result = await pending;
   expect(result.validation?.valid).toBe(mode === 'success');
   expect(result.attempts).toBe(1);
   expect(events).toEqual(['agent_attempt_start', 'agent_attempt_end', 'artifact_validation']);
   expect(inputs.length).toBeGreaterThan(0);
   const report = JSON.parse(readFileSync(result.artifacts[1].path, 'utf8'));
   expect(report.metrics.balancedAccuracy).toBe(.75);
   expect(report.advisoryOnly).toBe(true);
   if (mode === "success") expect(report.review.readinessScore).toBe(3);
   expect(JSON.stringify(report)).not.toContain('SECRET');
  } finally { rmSync(directory, { recursive: true, force: true }); }
 });
}
test("invalid input and options fail before any evaluator session", () => {
 const stage = createEvaluateStage();
 expect(() => stage.checkInput({ taskId: 'fixture', upstream: [] })).toThrow('training_selected_result');
 for (const value of [null, [], { timeoutSeconds: 0 }, { foo: true }]) expect(() => stage.parseOptions(value)).toThrow();
});

test("evaluation prerequisites prevent execution and record failure under the invocation", async () => {
 const { SetupSession } = await import('../pipeline/setup.js');
 const { invokeStage } = await import('../pipeline/executor.js');
 const { createPipelineTrace } = await import('../pipeline/trace.js');
 const { resolvePipelineSettings } = await import('../pipeline/config.js');
 const { STAGE_REGISTRY } = await import('../pipeline/registry.js');
 const before = STAGE_REGISTRY.evaluate;
 const directory = mkdtempSync(join(tmpdir(), 'evaluation-preflight-'));
 let ran = false;
 class MissingPrerequisite extends SetupSession {
  async check(checks: any[], signal: AbortSignal, record: any) {
   expect(checks.map(c => c.id)).toContain('evaluation-diagnostics');
   expect(checks.map(c => c.id)).toContain('model-configuration');
   expect(checks.map(c => c.id)).not.toContain('TAVILY_API_KEY');
   return super.check([{ ...checks.find(c => c.id === 'evaluation-diagnostics'), run() { throw new Error('missing sklearn'); } }], signal, record);
  }
 }
 const trace = await createPipelineTrace({ telemetry: testTelemetry(), taskId: 'fixture', pipelineRunId: crypto.randomUUID(), runsDir: directory });
 try {
  STAGE_REGISTRY.evaluate = { ...createEvaluateStage(), async run() { ran = true; return { artifacts: [] }; } };
  const config = resolvePipelineSettings({ pipeline: { entryStage: 'evaluate', stages: { evaluate: { enabled: true } } }, agent: { cwd: '.', agentDir: '.', initialPrompt: '' }, providers: {}, defaultModel: 'fixture/model' } as any);
  const invocation = await invokeStage({ stage: 'evaluate', input: { taskId: 'fixture', taskConfiguration: spamConfiguration(), upstream: [] }, config, trace, setupSession: new MissingPrerequisite() });
  expect(invocation.outcome).toBe('failure');
  expect(invocation.error).toContain('evaluation-diagnostics');
  expect(ran).toBe(false);
  await trace.close();
  const events = JSON.stringify(traceEvents(trace.pipelineRunId));
  expect(events).toContain('setup_check');
  expect(events).toContain(invocation.invocationId);
 } finally { STAGE_REGISTRY.evaluate = before; await trace.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("readiness scores are bounded and anchored to concern severity", () => {
 for (const score of [-1, 6, 2.5]) expect(() => validateReview({ ...review, readinessScore: score })).toThrow();
 for (const [severity, cap] of [['critical', 1], ['high', 2], ['medium', 3], ['low', 4]] as const) {
  const candidate = { ...review, readinessScore: cap, concerns: [{ ...review.concerns[0], severity }] };
  expect(validateReview(candidate).readinessScore).toBe(cap);
  expect(() => validateReview({ ...candidate, readinessScore: cap + 1 })).toThrow('severity');
 }
 expect(validateReview({ ...review, status: 'reviewed', readinessScore: 5, concerns: [] }).readinessScore).toBe(5);
});
test("unavailable implementation prevents high readiness", async () => {
 const reviewer = reviewerTools(evidence('/tmp/fixture'), loadPromptSnapshot(), undefined, false);
 await expect(reviewer.tools[1].execute('id', { ...review, readinessScore: 5, concerns: [] } as any, undefined, undefined, undefined as never)).rejects.toThrow('Uninspected');
 expect(reviewer.result()).toBeUndefined();
});
test("code inspection rejects outside files and retains exact reviewed bytes", async () => {
 const { mkdirSync, writeFileSync, symlinkSync } = await import('node:fs');
 const { codeReader } = await import('./code.js');
 const directory = mkdtempSync(join(tmpdir(), 'evaluation-code-'));
 try {
  mkdirSync(join(directory, 'solutions'));
  writeFileSync(join(directory, 'solutions/model.py'), 'def model(): return 1\n');
  writeFileSync(join(directory, 'secret.py'), 'not allowed');
  symlinkSync(join(directory, 'secret.py'), join(directory, 'solutions/link.py'));
  const inputs: any[] = [];
  const reader = codeReader(directory, directory, { input: (i: unknown) => inputs.push(i) } as any);
  expect(reader.read('solutions/model.py').text).toContain('return 1');
  writeFileSync(join(directory, 'solutions/model.py'), 'changed');
  expect(reader.read('solutions/model.py').text).toContain('return 1');
  for (const path of ['solutions/../secret.py', 'solutions/link.py']) expect(() => reader.read(path)).toThrow('Only Python');
  expect(reader.artifacts()).toHaveLength(1);
  expect(inputs[0].content_sha256).toBe(reader.artifacts()[0].sha256);
 } finally { rmSync(directory, { recursive: true, force: true }); }
});
