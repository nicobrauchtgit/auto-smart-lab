/**
 * The lesson step: after an agent stage's work, the same session writes a short
 * stage report and then records what it learned in the knowledge store. Failed
 * stages do this too; a cancelled stage does not. The report is saved by the
 * harness and handed to the orchestrator as a `stage_report` artifact.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { PROJECT_ROOT } from "../pipeline/resolve_task.js";
import { statePath } from "../paths.js";
import type { StageArtifact } from "../pipeline/types.js";
import type { PromptSnapshot, RenderedPrompt } from "../prompts/loader.js";
import type { TaskKnowledge } from "./service.js";

export type LessonStage = "research" | "solve" | "evaluate";

export interface LessonStep {
 stage: LessonStage;
 /** Where the harness saves the stage report. */
 reportPath: string;
 /** Checked after the stage's work; false skips the step, e.g. when a repair attempt follows. Ignored after a session error. */
 when?: () => boolean;
 /** Called before the lesson prompts, so stage guards such as the research budget step aside. */
 onStart?: () => void;
 /** What the harness knows about the stage's outcome, in plain sentences. */
 outcome?: () => string;
 /** Stage-specific limits on what may enter the store. */
 restrictions?: string;
}

/** The only tools that run during the lesson step. Solve's experiment_start/resume/stop are not among them. */
export const LESSON_TOOLS: ReadonlySet<string> = new Set(["knowledge_search", "knowledge_read", "knowledge_capture", "knowledge_compare", "experiment_history", "experiment_compare"]);
/**
 * Bytes of the report carried in the stage summary. The orchestrator's summary
 * cuts strings at 512 characters and shares a 4 KiB budget with the metrics, so
 * the excerpt stays small; the full report is the stage_report artifact.
 */
export const REPORT_SUMMARY_BYTES = 480;

export function stageReportPath(taskId: string, stage: LessonStage, invocationId?: string | null, attempt?: number): string {
 const name = [stage, invocationId ?? new Date().toISOString().replace(/[:.]/g, "-"), ...(attempt ? [`a${attempt}`] : [])].join("-");
 return statePath(PROJECT_ROOT, taskId, "reports", `${name}.md`);
}

export function writeStageReport(path: string, text: string): void {
 mkdirSync(dirname(path), { recursive: true });
 writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`);
}

/** The fallback when the agent could not write its own report. */
export function fallbackReport(stage: LessonStage, reason: string): string {
 return `# ${stage} stage report (written by the harness)\n\n- **Status**: failed\n- **Blockers**: the agent could not write a report: ${reason.slice(0, 500)}\n`;
}

/** The saved report as an artifact plus a bounded excerpt for the stage summary. */
export function stageReport(path: string | undefined): { artifact: StageArtifact; excerpt: string } | undefined {
 if (!path || !existsSync(path)) return undefined;
 const bytes = readFileSync(path);
 const text = bytes.toString("utf8");
 const excerpt = Buffer.byteLength(text) > REPORT_SUMMARY_BYTES ? `${Buffer.from(text).subarray(0, REPORT_SUMMARY_BYTES).toString("utf8")}…` : text;
 return { artifact: { kind: "stage_report", path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, excerpt };
}

/**
 * Ask for the stage report, save it, then ask for lessons. Never throws: a failed
 * step leaves a harness-written report and an event, and the stage result stands.
 */
export async function runLessonStep(options: {
 lessons?: LessonStep; knowledge?: Pick<TaskKnowledge, "options" | "history">; failure?: unknown; signal?: AbortSignal;
 prompts: PromptSnapshot; ask: (prompt: RenderedPrompt) => Promise<string>;
 setActive: (active: boolean) => void; record: (type: string, payload: Record<string, unknown>) => void;
}): Promise<void> {
 const { lessons, knowledge, failure, prompts } = options;
 if (!lessons || options.signal?.aborted) return;
 if (!failure && lessons.when && !lessons.when()) return;
 const record = (type: string, payload: Record<string, unknown>) => options.record(type, { stage: lessons.stage, ...payload });
 // An unresponsive model would only stall again; the harness writes the report itself.
 if (failure instanceof Error && failure.message.startsWith("Model requests stalled")) {
  writeStageReport(lessons.reportPath, fallbackReport(lessons.stage, failure.message));
  record("lesson_step_skipped", { reason: "model unresponsive" });
  return;
 }
 options.setActive(true);
 lessons.onStart?.();
 record("lesson_step_start", { after_error: !!failure });
 let reported = false;
 try {
  const failed = failure ? `The session ended with an error: ${failure instanceof Error ? failure.message : String(failure)}` : "";
  const outcome = [failed, lessons.outcome?.() ?? ""].filter(Boolean).join("\n") || "Nothing beyond your own work.";
  const report = (await options.ask(prompts.render("lessons.report", { stage: lessons.stage, outcome }))).trim();
  writeStageReport(lessons.reportPath, report || fallbackReport(lessons.stage, "the report reply was empty"));
  reported = true;
  record("stage_report_written", { path: lessons.reportPath, bytes: Buffer.byteLength(report) });
  // Without a knowledge scope the report still reaches the orchestrator; only the capture is skipped.
  if (!knowledge) { record("lesson_step_end", { capture: "skipped", reason: "no knowledge scope for this session" }); return; }
  const history = knowledge.options.trainingRoots?.length ? JSON.stringify(knowledge.history(0, 8)) : "No harness experiments are available to this stage.";
  const notes = await options.ask(prompts.render("lessons.capture", { report: report || "(empty)", history, restrictions: lessons.restrictions ?? "" }));
  record("lesson_step_end", { reply_bytes: Buffer.byteLength(notes) });
 } catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  // A cancelled stage does not report, and a timed-out step must not write after the stage has read its report.
  if (options.signal?.aborted) { record("lesson_step_cancelled", { report_written_by_agent: reported }); return; }
  if (!reported) writeStageReport(lessons.reportPath, fallbackReport(lessons.stage, message));
  record("lesson_step_error", { message: message.slice(0, 500), report_written_by_agent: reported });
 } finally { options.setActive(false); }
}
