import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { HARNESS_CONFIG } from "../harness/config.js";
import type { PromptSnapshot, RenderedPrompt } from "../prompts/loader.js";
import { ScoutBudget } from "./budget.js";
import { appendFindings, readFindings } from "./journal.js";
import type { FindingRef, ScoutRole } from "./contracts.js";

export interface ScoutRequest { role: ScoutRole | ScoutRole[]; question: string; refs?: FindingRef[] }
export interface ScoutSessionInput {
 role: ScoutRole; toolCallId: string; system: RenderedPrompt; opening: RenderedPrompt; budget: ScoutBudget; signal?: AbortSignal;
}
export interface ScoutsOptions {
 prompts: PromptSnapshot; taskId: string; task: string; unitIntro: string; dataPaths: string;
 journalPath: string; datasetSha256: string; runId: string; invocationId: string;
 /** Backend must isolate all tool traffic from the caller; only final text returns. */
 run(input: ScoutSessionInput): Promise<string>;
 prepare(roles: readonly ScoutRole[], signal?: AbortSignal): Promise<void>;
 /** Stream B adapter must resolve immutable source and run checks against it. Absent until integration. */
 validationReady?: boolean;
 budgets?: Partial<Record<ScoutRole, number>>;
}
/** Preserve structured source links in addition to the scout's attributed prose. */
export function bulletRefs(text: string): FindingRef[] {
 const refs: FindingRef[] = [];
 for (const url of text.match(/https?:\/\/[^\s)\]`]+/g) ?? []) refs.push({url});
 for (const match of text.matchAll(/`([^`]+)`/g)) {
  const value = match[1];
  if (value.startsWith("profile/")) refs.push({profile: value});
  else if (/^[\w./-]+\.(py|txt|md|json|jsonl)(:\d+)?$/.test(value)) {
   const [file, line] = value.split(":"); refs.push({file, line: Number(line ?? 1)});
  }
 }
 return refs;
}
export function finalBullets(text: string, fallback: string): string[] {
 const bullets = text.split("\n").filter(line => /^\s*[-*]\s+/.test(line)).map(line => line.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
 return bullets.length ? bullets.map(line => `- ${line}`) : [fallback.trim()];
}

export function createScouts(options: ScoutsOptions) {
 if (!options.task.trim() || !options.unitIntro.trim()) throw new Error("Scout requires task text and unit introduction");
 // Keep the requested scout roles sequential and journal observations before continuing.
 let tail: Promise<unknown> = Promise.resolve();
 const execute = async (request: ScoutRequest, signal: AbortSignal | undefined, toolCallId: string): Promise<string> => {
  const roles = [...new Set(Array.isArray(request.role) ? request.role : [request.role])];
  if (!roles.length || roles.some(role => !["data", "ideas", "validation"].includes(role))) throw new Error("Invalid scout role");
  if (roles.includes("validation") && !options.validationReady) throw new Error("Validation scout unavailable: stream B trial snapshot/check adapter required; live source is never used");
  await options.prepare(roles, signal);
  const output: string[] = [];
  for (const role of roles) {
   signal?.throwIfAborted();
   if (role === "validation" && !options.validationReady) throw new Error("Validation scout unavailable: stream B trial snapshot/check adapter required; live source is never used");
   const budget = new ScoutBudget(options.budgets?.[role] ?? HARNESS_CONFIG.team.scouts[role].maxToolCalls, options.prompts);
   const system = role === "data" ? options.prompts.render("team.data", { taskId: options.taskId, budget: String(budget.limit), dataPaths: options.dataPaths })
    : role === "ideas" ? options.prompts.render("team.ideas", { taskId: options.taskId, budget: String(budget.limit), webSearches: String(HARNESS_CONFIG.team.scouts.ideas.webSearches) })
    : options.prompts.render("team.validation", { taskId: options.taskId, budget: String(budget.limit) });
   const earlier = await readFindings(options.journalPath);
   const opening = options.prompts.render("team.start", { task: options.task, unitIntro: options.unitIntro, question: request.question,
    refs: JSON.stringify(request.refs ?? []), earlier: JSON.stringify({entries: earlier.entries, resolutions: earlier.resolutions}) + (earlier.incompleteTail ? "\nIncomplete journal tail ignored." : "") });
   const text = await options.run({ role, toolCallId, system, opening, budget, signal });
   const bullets = finalBullets(text, options.prompts.render("team.empty", {}).text);
   await appendFindings(options.journalPath, bullets.map(bullet => ({
    kind: role === "ideas" ? "idea" as const : role === "validation" ? (/^-\s*fix\b/i.test(bullet) && request.refs?.some(ref => "experiment" in ref || "check" in ref) ? "defect" as const : "decision" as const) : "fact" as const,
    author: { role, invocationId: options.invocationId, runId: options.runId }, title: bullet.slice(2, 102), text: bullet.slice(2, 802),
    refs: [...(request.refs ?? []), ...bulletRefs(bullet)], datasetSha256: options.datasetSha256,
   })), signal);
   output.push(...bullets);
  }
  return output.join("\n");
 };
 const scout = (request: ScoutRequest, signal?: AbortSignal, toolCallId: string = randomUUID()) => {
  const pending = tail.then(() => execute(request, signal, toolCallId));
  tail = pending.catch(() => undefined);
  return pending;
 };
 const role = Type.Union([Type.Literal("data"), Type.Literal("ideas"), Type.Literal("validation")]);
 const tool = defineTool({ name: "scout", label: "Scout", description: options.prompts.render("team.scout-tool", {}).text,
  parameters: Type.Object({ role: Type.Union([role, Type.Array(role, { minItems: 1, maxItems: 3 })]), question: Type.String({ minLength: 1 }),
   refs: Type.Optional(Type.Array(Type.Union([
    Type.Object({ experiment: Type.String() }), Type.Object({ file: Type.String(), line: Type.Integer({minimum: 1}), commit: Type.Optional(Type.String()) }),
    Type.Object({ profile: Type.String() }), Type.Object({ entry: Type.String() }), Type.Object({ url: Type.String() }),
    Type.Object({ check: Type.String(), sha256: Type.String(), experiment: Type.Optional(Type.String()) }),
   ]))) }),
  async execute(id, args, signal) { return { content: [{ type: "text", text: await scout(args, signal, id) }], details: {} }; },
 });
 return { scout, tool };
}
