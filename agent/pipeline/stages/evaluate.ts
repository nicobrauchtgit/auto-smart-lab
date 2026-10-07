import { guidanceBlock } from "../guidance.js";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { codeReader } from "../../evaluation/code.js";
import { PROJECT_ROOT } from "../resolve_task.js";
import { curveSvg } from "../../evaluation/curves.js";
import { prepareEvidence, selectedArtifact, artifact } from "../../evaluation/evidence.js";
import { reviewerTools, validateReview } from "../../evaluation/reviewer.js";
import { runSession } from "../../run/session_runner.js";
import type { StageDefinition } from "../types.js";

export type EvaluateOptions = Record<string, never>;
// Dependencies are injectable for offline contract tests; production has one path.
export function createEvaluateStage(deps = { prepareEvidence, runSession }): StageDefinition<EvaluateOptions> {
 return {
  name: "evaluate", version: 1, next: "refit",
  description: "Short advisory model review of harness OOF performance, validation risks and class disparities",
  setupRequirements: ["knowledge", "model", "python", "evaluation"],
  parseOptions(raw) {
   if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) throw new Error("evaluate options must be an object");
   const options = (raw ?? {}) as Record<string, unknown>;
   if (Object.keys(options).length) throw new Error("unknown evaluate options");
   return {};
  },
  checkInput(input) { selectedArtifact(input.upstream); },
  async run(context) {
   const evidence = await deps.prepareEvidence(context.input.upstream, context.signal, context.input.taskId);
   const directory = join(evidence.directory, "evaluation", context.report.agentIdentity(1).stageInvocationId ?? crypto.randomUUID());
   mkdirSync(directory, { recursive: true });
   const evidencePath = join(directory, "evidence.json");
   writeFileSync(evidencePath, JSON.stringify({ schemaVersion: 1, taskId: context.input.taskId,
    experimentId: evidence.experimentId, sources: evidence.sources,
    ...evidence.diagnostics, candidate: evidence.candidate }, null, 2) + "\n");
   const curve = curveSvg(evidence.diagnostics.curves);
   const curveArtifacts = [];
   if (curve) {
    const path = join(directory, "curves.svg");
    writeFileSync(path, curve);
    curveArtifacts.push(artifact("evaluation_curves", path));
   }
   const evidenceArtifact = artifact("evaluation_evidence", evidencePath);
   context.report.input({ kind: "evaluation_evidence", version: 1, delivery: "initial_prompt", status: "available",
    artifact: evidencePath, content_sha256: evidenceArtifact.sha256, experiment_id: evidence.experimentId });
   for (const source of evidence.sources) context.report.input({ kind: source.kind, version: 1,
    delivery: "workspace_file", status: "available", artifact: source.path, content_sha256: source.sha256 });
   const prompts = context.prompts;
   const system = prompts.render("review.system", {});
   const guide = prompts.render("review.guide", {});
   const { roc, precisionRecall, ...scoreSummary } = evidence.diagnostics.curves;
   const code = codeReader(PROJECT_ROOT, directory, context.report);
   let entrypoint: unknown;
   let sourceAvailable = false;
   try { entrypoint = code.read(evidence.candidate.request?.pipeline.module ?? "", 1, "initial_prompt"); sourceAvailable = true; }
   catch { entrypoint = { unavailable: true, reason: "Candidate source could not be read; readiness is limited by missing code inspection" }; }
   const guidance = guidanceBlock(prompts, context.input.guidance);
   const start = prompts.render("review.start", { taskId: context.input.taskId, experimentId: evidence.experimentId,
    guidance: guidance?.text ?? "", code: JSON.stringify(entrypoint), evidence: JSON.stringify({ summary: evidence.diagnostics.summary, scores: scoreSummary,
     limitations: evidence.diagnostics.limitations, candidate: evidence.candidate }) });
   const reviewer = reviewerTools(evidence, prompts, code.read, sourceAvailable);
   context.report.event("agent_attempt_start", { attempt: 1 });
   let sessionError: string | undefined;
   try {
    const seedPath = join(evidence.directory, "seed-plan.json");
    const seed = existsSync(seedPath) ? JSON.parse(readFileSync(seedPath, "utf8")) : undefined;
    await deps.runSession({ prompts, system, prompt: [guide.text, start.text].filter(Boolean).join("\n\n"), feedback: context.feedback,
     ...(seed ? { knowledge: { root: join(PROJECT_ROOT, "knowledge"), origin: { taskId: context.input.taskId,
      datasetSha256: seed.datasetSha256, pipelineRunId: context.report.agentIdentity(1).pipelineRunId,
      stageInvocationId: context.report.agentIdentity(1).stageInvocationId }, trainingRoots: [dirname(evidence.directory), join(PROJECT_ROOT, "runs", context.input.taskId, "solve", "training")] } } : {}),
     promptReferences: [system.reference, guide.reference, start.reference, ...(guidance ? [guidance.reference] : []),
      prompts.render("review.detail-tool", {}).reference, prompts.render("review.report-tool", {}).reference, prompts.render("review.code-tool", {}).reference],
     model: context.input.model, tools: [], extensions: false, customTools: reviewer.tools,
     observe: context.report.observation(1), reportInput: input => context.report.input(input),
     signal: context.signal });
   } catch {
    context.signal.throwIfAborted();
    sessionError = "Evaluation session failed or exceeded its time limit";
   } finally { context.report.event("agent_attempt_end", { attempt: 1, failed: !!sessionError || context.signal.aborted }); }
   const review = reviewer.result();
   const errors = sessionError ? [sessionError] : review ? [] : ["Evaluator did not record a structured review"];
   const reportPath = join(directory, "review.json");
   const report = { schemaVersion: 1, taskId: context.input.taskId, experimentId: evidence.experimentId,
    evidenceSha256: evidenceArtifact.sha256, metrics: evidence.diagnostics.summary,
    scoreMetrics: scoreSummary, evidenceLimitations: evidence.diagnostics.limitations,
    sourceArtifacts: code.artifacts(), advisoryOnly: true, validation: { valid: errors.length === 0, errors },
    review: review ? validateReview(review) : null };
   writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
   context.report.event("artifact_validation", report.validation);
   return { artifacts: [evidenceArtifact, artifact("evaluation_report", reportPath), ...curveArtifacts, ...code.artifacts()], attempts: 1,
    validation: report.validation, summary: { experiment_id: evidence.experimentId,
     review_status: review?.status, readiness_score: review?.readinessScore, balanced_accuracy: evidence.diagnostics.summary.balancedAccuracy, advisory_only: true } };
  },
 };
}
export const evaluateStage = createEvaluateStage();
