import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PromptSnapshot } from "../prompts/loader.js";
import type { EvaluationEvidence } from "./evidence.js";

export interface ModelReview {
 readinessScore: number;
 readinessRationale: string;
 status: "reviewed" | "concerns" | "insufficient_evidence";
 assessment: string;
 concerns: { severity: "low" | "medium" | "high" | "critical"; finding: string; evidence: string }[];
 limitations: string[];
 recommendations: string[];
}
export function validateReview(value: unknown): ModelReview {
 const v = value as ModelReview;
 const text = (s: unknown) => typeof s === "string" && s.trim().length > 0 && s.length <= 2000;
 if (!v || !Number.isInteger(v.readinessScore) || v.readinessScore < 0 || v.readinessScore > 5 || !text(v.readinessRationale) || !["reviewed", "concerns", "insufficient_evidence"].includes(v.status) || !text(v.assessment)
  || !Array.isArray(v.concerns) || v.concerns.length > 8
  || v.concerns.some(c => !c || !["low", "medium", "high", "critical"].includes(c.severity) || !text(c.finding) || !text(c.evidence))
  || !Array.isArray(v.limitations) || !v.limitations.length || v.limitations.length > 12 || !v.limitations.every(text)
  || !Array.isArray(v.recommendations) || v.recommendations.length > 3 || !v.recommendations.every(text)) {
  throw new Error("Invalid model review: provide status, assessment, evidence-linked concerns, limitations, and at most three recommendations");
 }
 const cap = Math.min(5, ...v.concerns.map(c => ({ low: 4, medium: 3, high: 2, critical: 1 })[c.severity]));
 if (v.readinessScore > cap) throw new Error("Readiness score contradicts concern severity");
 if (v.status === "insufficient_evidence" && v.readinessScore > 3) throw new Error("Insufficient evidence cannot support readiness above 3");
 return { readinessScore: v.readinessScore, readinessRationale: v.readinessRationale, status: v.status, assessment: v.assessment, concerns: v.concerns.map(c => ({ severity: c.severity, finding: c.finding, evidence: c.evidence })), limitations: [...v.limitations], recommendations: [...v.recommendations] };
}
export function reviewerTools(evidence: EvaluationEvidence, prompts: PromptSnapshot, readCode?: (path: string, startLine?: number) => unknown, sourceAvailable = true) {
 let review: ModelReview | undefined;
 const response = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
 const text = Type.String({ minLength: 1, maxLength: 2000 });
 const tools: ToolDefinition[] = [
  defineTool({ name: "evaluation_detail", label: "Inspect model evidence",
   description: prompts.render("review.detail-tool", {}).text,
   parameters: Type.Object({ section: Type.Union([Type.Literal("curves"), Type.Literal("folds"), Type.Literal("candidate")]) }),
   async execute(_id, args) {
    return response(args.section === "candidate" ? evidence.candidate : evidence.diagnostics[args.section]);
   } }),
  defineTool({ name: "evaluation_report", label: "Record model review",
   description: prompts.render("review.report-tool", {}).text,
   parameters: Type.Object({
    readinessScore: Type.Integer({ minimum: 0, maximum: 5 }),
    readinessRationale: text,
    status: Type.Union([Type.Literal("reviewed"), Type.Literal("concerns"), Type.Literal("insufficient_evidence")]),
    assessment: text,
    concerns: Type.Array(Type.Object({ severity: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")]), finding: text, evidence: text }), { maxItems: 8 }),
    limitations: Type.Array(text, { minItems: 1, maxItems: 12 }),
    recommendations: Type.Array(text, { maxItems: 3 }),
   }),
   async execute(_id, args) {
    if (review) throw new Error("Review already recorded");
    const validated = validateReview(args);
    if (!sourceAvailable && validated.readinessScore > 3) throw new Error("Uninspected implementation cannot support readiness above 3");
    review = validated;
    return response({ recorded: true });
   } }),
 ];
 if (readCode) tools.push(defineTool({ name: "evaluation_code", label: "Inspect candidate code",
  description: prompts.render("review.code-tool", {}).text,
  parameters: Type.Object({ path: Type.String({ minLength: 1, maxLength: 500 }), startLine: Type.Optional(Type.Integer({ minimum: 1 })) }),
  async execute(_id, args) {
   return response(readCode(args.path, args.startLine));
  },
 }));
 return { tools, result: () => review };
}
