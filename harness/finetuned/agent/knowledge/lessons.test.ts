import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPromptSnapshot, type RenderedPrompt } from "../prompts/loader.js";
import { LESSON_TOOLS, REPORT_SUMMARY_BYTES, runLessonStep, stageReport, type LessonStep } from "./lessons.js";
import { ResearchBudget } from "../research/budget.js";

const prompts = loadPromptSnapshot();

function fixture(lessons: Partial<LessonStep> = {}, trainingRoots: string[] = []) {
 const dir = mkdtempSync(join(tmpdir(), "lessons-"));
 const asked: RenderedPrompt[] = [];
 const events: string[] = [];
 const active: boolean[] = [];
 const knowledge = { options: { root: dir, origin: { taskId: "t", datasetSha256: "a".repeat(64) }, trainingRoots },
  history: () => ({ experiments: [{ reference: { rootIndex: 0, id: "trial-1" } }] }) } as any;
 const step: LessonStep = { stage: "solve", reportPath: join(dir, "reports", "solve.md"), ...lessons };
 return { dir, asked, events, active, knowledge, step,
  base: { lessons: step, knowledge, prompts, setActive: (a: boolean) => active.push(a), record: (type: string) => events.push(type) } };
}

test("the report is asked first and saved, then lessons are asked with the report and the experiment history", async () => {
 const f = fixture({ outcome: () => "Two trials ran." }, ["/roots/0"]);
 try {
  await runLessonStep({ ...f.base, ask: async prompt => { f.asked.push(prompt); return f.asked.length === 1 ? "- **Status**: done" : "Captured abc"; } });
  expect(f.asked).toHaveLength(2);
  expect(f.asked[0]!.text).toContain("Two trials ran.");
  expect(f.asked[0]!.text).toContain("solve work is over");
  expect(readFileSync(f.step.reportPath, "utf8")).toBe("- **Status**: done\n");
  expect(f.asked[1]!.text).toContain("- **Status**: done");
  expect(f.asked[1]!.text).toContain("trial-1");
  expect(f.active).toEqual([true, false]);
  expect(f.events).toEqual(["lesson_step_start", "stage_report_written", "lesson_step_end"]);
 } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a failed stage still reports, naming the error, even when a repair would otherwise follow", async () => {
 const f = fixture({ when: () => false });
 try {
  await runLessonStep({ ...f.base, failure: new Error("tool path not found"), ask: async prompt => { f.asked.push(prompt); return "- **Status**: failed"; } });
  expect(f.asked[0]!.text).toContain("The session ended with an error: tool path not found");
  expect(f.asked[1]!.text).toContain("No harness experiments are available");
  expect(existsSync(f.step.reportPath)).toBe(true);
 } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("no step when a repair attempt follows or when cancelled", async () => {
 const f = fixture({ when: () => false });
 const ask = async (prompt: RenderedPrompt) => { f.asked.push(prompt); return "x"; };
 try {
  await runLessonStep({ ...f.base, ask });
  const controller = new AbortController(); controller.abort();
  await runLessonStep({ ...f.base, lessons: { ...f.step, when: undefined }, signal: controller.signal, ask });
  expect(f.asked).toHaveLength(0);
  expect(existsSync(f.step.reportPath)).toBe(false);
 } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("after a stalled model the harness writes the report without asking", async () => {
 const f = fixture();
 try {
  await runLessonStep({ ...f.base, failure: new Error("Model requests stalled 3 times (no output for 10 minutes each)"), ask: async prompt => { f.asked.push(prompt); return "x"; } });
  expect(f.asked).toHaveLength(0);
  expect(readFileSync(f.step.reportPath, "utf8")).toContain("written by the harness");
  expect(f.events).toEqual(["lesson_step_skipped"]);
 } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a failing report request leaves a harness report and does not throw", async () => {
 const f = fixture();
 try {
  await runLessonStep({ ...f.base, ask: async () => { throw new Error("provider down"); } });
  expect(readFileSync(f.step.reportPath, "utf8")).toContain("provider down");
  expect(f.events).toContain("lesson_step_error");
  expect(f.active).toEqual([true, false]);
 } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("the reviewer's lesson prompt keeps sealed results out of notes", async () => {
 const f = fixture({ stage: "evaluate", restrictions: prompts.render("lessons.sealed", {}).text });
 try {
  await runLessonStep({ ...f.base, ask: async prompt => { f.asked.push(prompt); return "report"; } });
  expect(f.asked[1]!.text).toContain("Keep holdout confirmation results out of every note");
 } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("only knowledge and experiment-history tools pass the lesson guard; training tools do not", async () => {
 for (const name of ["knowledge_capture", "knowledge_search", "knowledge_read", "knowledge_compare", "experiment_history", "experiment_compare"]) expect(LESSON_TOOLS.has(name)).toBe(true);
 const { createKnowledgeTools, TaskKnowledge } = await import("./service.js");
 const dir = mkdtempSync(join(tmpdir(), "lesson-tools-"));
 try {
  const service = new TaskKnowledge({ root: dir, origin: { taskId: "t", datasetSha256: "a".repeat(64) }, trainingRoots: [dir] });
  for (const tool of createKnowledgeTools(service, prompts)) expect(LESSON_TOOLS.has(tool.name)).toBe(true);
 } finally { rmSync(dir, { recursive: true, force: true }); }
 // Solve's harness training controls share the experiment_ prefix and must stay blocked.
 for (const name of ["experiment_start", "experiment_resume", "experiment_stop", "experiment_status", "experiment_output", "bash", "write", "edit", "check_brief", "python_environment"]) expect(LESSON_TOOLS.has(name)).toBe(false);
});

test("without a knowledge scope the report is still written and the capture is skipped", async () => {
 const f = fixture();
 try {
  await runLessonStep({ ...f.base, knowledge: undefined, ask: async prompt => { f.asked.push(prompt); return "- **Status**: done"; } });
  expect(f.asked).toHaveLength(1);
  expect(readFileSync(f.step.reportPath, "utf8")).toContain("done");
 } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("a cancel or time limit during the step writes no harness report", async () => {
 const f = fixture();
 const controller = new AbortController();
 try {
  await runLessonStep({ ...f.base, signal: controller.signal, ask: async () => { controller.abort(); throw new Error("aborted"); } });
  expect(existsSync(f.step.reportPath)).toBe(false);
  expect(f.events).toContain("lesson_step_cancelled");
  expect(f.active).toEqual([true, false]);
 } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("the stage report becomes a hashed artifact with a bounded excerpt", async () => {
 const f = fixture();
 try {
  await runLessonStep({ ...f.base, ask: async () => "y".repeat(REPORT_SUMMARY_BYTES * 2) });
  const report = stageReport(f.step.reportPath)!;
  expect(report.artifact.kind).toBe("stage_report");
  expect(report.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(report.excerpt.length).toBeLessThanOrEqual(REPORT_SUMMARY_BYTES + 1);
  expect(stageReport(join(f.dir, "missing.md"))).toBeUndefined();
 } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test("the research budget steps aside for the lesson step, status line included", () => {
 const budget = new ResearchBudget(prompts, { maxToolCalls: 1, focusAtRemainingPercent: 50, wrapUpAtRemainingPercent: 20, finalizeToolCalls: 0, bashTimeoutSeconds: 600 } as any);
 expect(budget.beforeToolCall("bash", {})).toBeUndefined();
 expect(budget.beforeToolCall("knowledge_capture", {})?.block).toBe(true);
 budget.pause();
 expect(budget.beforeToolCall("knowledge_capture", {})).toBeUndefined();
 expect(budget.used).toBe(1);
 const handlers: Record<string, (event: any) => unknown> = {};
 budget.extension().factory({ on: (name: string, handler: (event: any) => unknown) => { handlers[name] = handler; } });
 expect(handlers.tool_result!({ content: [] })).toBeUndefined();
});
