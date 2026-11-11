import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { HARNESS_CONFIG } from "../harness/config.js";
import type { PromptSnapshot, RenderedPrompt } from "../prompts/loader.js";
import { REPO_ROOT, statePath } from "../paths.js";
import { ScoutBudget } from "./budget.js";
import { appendValidFindings, validRef } from "./journal.js";
import { earlierFindings } from "./findings.js";
import type { FindingRef, ScoutRole } from "./contracts.js";

export interface ScoutRequest { role: ScoutRole | ScoutRole[]; question: string; refs?: FindingRef[] }
export interface ScoutSessionInput {
 role: ScoutRole; toolCallId: string;
 /** Instructions every scout role gets, before its role prompt. */
 shared: RenderedPrompt;
 system: RenderedPrompt; opening: RenderedPrompt; budget: ScoutBudget; signal?: AbortSignal;
}
/** Final scout text; `root` is the scout's cwd, against which its file citations resolve. */
export interface ScoutReply { text: string; root?: string; stopped?: string }
export interface ScoutsOptions {
 prompts: PromptSnapshot; taskId: string; task: string; unitIntro: string; dataPaths: string;
 journalPath: string; datasetSha256: string; runId: string; invocationId: string;
 /** State root that journaled file citations are stored relative to; default runs/finetuned. */
 citationBase?: string;
 /** Backend must isolate all tool traffic from the caller; only final text returns. */
 run(input: ScoutSessionInput): Promise<string | ScoutReply>;
 prepare(roles: readonly ScoutRole[], signal?: AbortSignal): Promise<void>;
 /** Stream B adapter must resolve immutable source and run checks against it. Absent until integration. */
 validationReady?: boolean;
 budgets?: Partial<Record<ScoutRole, number>>;
}

const FILE_CITATION = /^([\w./-]+\.(?:py|txt|md|json|jsonl|csv|tsv|log|labels))(?::(\d+))?$/;
/**
 * Structured links for a bullet's own citations. Produces only contract-valid
 * refs; anything else (line 0, paths outside the state root) stays text only.
 * With `root`, file and profile paths are resolved against the scout's own
 * folder and stored relative to `base`.
 */
export function bulletRefs(text: string, location: { root?: string; base?: string } = {}): FindingRef[] {
 const refs: FindingRef[] = [];
 const locate = (path: string): string | undefined => {
  if (!location.root) return path;
  const absolute = resolve(location.root, path);
  const delta = relative(resolve(location.base ?? location.root), absolute);
  return delta && !delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta) ? delta : undefined;
 };
 for (const url of text.match(/https?:\/\/[^\s)\]`>]+/g) ?? []) refs.push({ url: url.replace(/[.,;:]+$/, "") });
 for (const match of text.matchAll(/`([^`\s]+)`/g)) {
  const file = FILE_CITATION.exec(match[1]);
  if (!file) continue;
  const path = locate(file[1]);
  if (!path) continue;
  if (file[1].startsWith("profile/") && file[2] === undefined) refs.push({ profile: path });
  else if (file[2] === undefined || Number(file[2]) >= 1) refs.push({ file: path, line: Number(file[2] ?? 1) });
 }
 const unique = new Map(refs.filter(validRef).map(ref => [JSON.stringify(ref), ref]));
 return [...unique.values()];
}

const ITEM = /^(\s*)(?:[-*+]|\d{1,3}[.)])\s+(\S.*)$/;
/**
 * Keeps only the final list: bulleted or numbered items, each with its
 * indented continuation lines (sources, nested points). Unindented prose ends
 * an item and is dropped.
 */
export function finalBullets(text: string, fallback: string): string[] {
 const bullets: string[][] = [];
 let current: string[] | undefined, indent: number | undefined;
 for (const line of text.split("\n")) {
  if (!line.trim()) continue;
  const item = ITEM.exec(line);
  const depth = line.length - line.trimStart().length;
  if (item && (indent === undefined || depth <= indent)) {
   indent ??= depth;
   current = [item[2].trim()]; bullets.push(current);
  } else if (current && depth > (indent ?? 0)) current.push(line.trim());
  else current = undefined;
 }
 return bullets.length ? bullets.map(([first, ...rest]) => [`- ${first}`, ...rest.map(line => `  ${line}`)].join("\n")) : [fallback.trim()];
}

const ROLES: readonly ScoutRole[] = ["data", "ideas", "validation"];
/** Validates lead input before any scout starts; the tool schema enforces the same shape. */
export function scoutRequestProblem(request: unknown): string | undefined {
 if (!request || typeof request !== "object" || Array.isArray(request)) return "request must be an object";
 const value = request as Record<string, unknown>;
 const extra = Object.keys(value).filter(key => !["role", "question", "refs"].includes(key));
 if (extra.length) return `unexpected field(s): ${extra.join(", ")}`;
 const roles = Array.isArray(value.role) ? value.role : [value.role];
 if (!roles.length || roles.length > 3 || roles.some(role => !ROLES.includes(role as ScoutRole))) return "role must be data, ideas or validation, or a list of them";
 if (typeof value.question !== "string" || !value.question.trim()) return "question must be non-empty text";
 if (value.refs !== undefined) {
  if (!Array.isArray(value.refs)) return "refs must be a list";
  const bad = value.refs.findIndex(ref => !validRef(ref));
  if (bad >= 0) return `refs[${bad}] must be exactly one of {experiment}, {file, line>=1, commit?}, {check, sha256, experiment?}, {url}, {profile}, {entry}`;
 }
}
const clip = (value: string, length: number) => value.length > length ? `${value.slice(0, length - 1)}…` : value;

export function createScouts(options: ScoutsOptions) {
 if (!options.task.trim() || !options.unitIntro.trim()) throw new Error("Scout requires task text and unit introduction");
 const citationBase = options.citationBase ?? statePath(REPO_ROOT);
 // Keep the requested scout roles sequential and journal observations before continuing.
 let tail: Promise<unknown> = Promise.resolve();
 const unavailable = "Validation scout unavailable: stream B trial snapshot/check adapter required; live source is never used";
 const execute = async (request: ScoutRequest, signal: AbortSignal | undefined, toolCallId: string): Promise<string> => {
  const problem = scoutRequestProblem(request);
  if (problem) throw new Error(`Invalid scout request: ${problem}`);
  const roles = [...new Set(Array.isArray(request.role) ? request.role : [request.role])];
  if (roles.includes("validation") && !options.validationReady) throw new Error(unavailable);
  await options.prepare(roles, signal);
  const shared = options.prompts.render("team.shared", {});
  const output: string[] = [];
  for (const role of roles) {
   signal?.throwIfAborted();
   const budget = new ScoutBudget(options.budgets?.[role] ?? HARNESS_CONFIG.team.scouts[role].maxToolCalls, options.prompts);
   const system = role === "data" ? options.prompts.render("team.data", { taskId: options.taskId, budget: String(budget.limit), dataPaths: options.dataPaths })
    : role === "ideas" ? options.prompts.render("team.ideas", { taskId: options.taskId, budget: String(budget.limit), webSearches: String(HARNESS_CONFIG.team.scouts.ideas.webSearches) })
    : options.prompts.render("team.validation", { taskId: options.taskId, budget: String(budget.limit) });
   const earlier = await earlierFindings(options.journalPath, { runId: options.runId, datasetSha256: options.datasetSha256 });
   const opening = options.prompts.render("team.start", { task: options.task, unitIntro: options.unitIntro, question: request.question,
    refs: JSON.stringify(request.refs ?? []), shown: String(earlier.lines.length), omitted: String(earlier.omitted),
    earlier: earlier.lines.length ? earlier.lines.join("\n") : "none" });
   let reply: ScoutReply;
   try {
    const result = await options.run({ role, toolCallId, shared, system, opening, budget, signal });
    reply = typeof result === "string" ? { text: result } : result;
   } catch (error) {
    signal?.throwIfAborted();
    // Earlier roles' bullets are already journaled; report this role and continue.
    output.push(options.prompts.render("team.failed", { role, reason: clip(error instanceof Error ? error.message : "unknown error", 200) }).text.trim());
    continue;
   }
   const fallback = reply.stopped ? options.prompts.render("team.stopped", { reason: reply.stopped }).text : options.prompts.render("team.empty", {}).text;
   const bullets = finalBullets(reply.text, fallback);
   const { rejected } = await appendValidFindings(options.journalPath, bullets.map(bullet => {
    const prose = bullet.replace(/^- /, "");
    return {
     kind: role === "ideas" ? "idea" as const : role === "validation" ? "decision" as const : "fact" as const,
     author: { role, invocationId: options.invocationId, runId: options.runId },
     title: clip(prose.split("\n")[0].trim(), 100), text: clip(prose.split("\n").map(line => line.trim()).join(" "), 800),
     refs: bulletRefs(bullet, { root: reply.root, base: citationBase }), datasetSha256: options.datasetSha256,
    };
   }), signal);
   output.push(...bullets);
   if (rejected.length) output.push(options.prompts.render("team.rejected", { count: String(rejected.length),
    reasons: rejected.map(row => `"${clip(row.title, 40)}": ${row.reason}`).join("; ") }).text.trim());
  }
  return output.join("\n");
 };
 const scout = (request: ScoutRequest, signal?: AbortSignal, toolCallId: string = randomUUID()) => {
  const pending = tail.then(() => execute(request, signal, toolCallId));
  tail = pending.catch(() => undefined);
  return pending;
 };
 // Validation stays out of the lead's schema until stream B's snapshot adapter is wired.
 const role = Type.Union([Type.Literal("data"), Type.Literal("ideas")]);
 const strict = { additionalProperties: false } as const;
 const tool = defineTool({ name: "scout", label: "Scout", description: options.prompts.render("team.scout-tool", {}).text,
  parameters: Type.Object({ role: Type.Union([role, Type.Array(role, { minItems: 1, maxItems: 2 })]), question: Type.String({ minLength: 1 }),
   refs: Type.Optional(Type.Array(Type.Union([
    Type.Object({ experiment: Type.String() }, strict), Type.Object({ file: Type.String(), line: Type.Integer({minimum: 1}), commit: Type.Optional(Type.String()) }, strict),
    Type.Object({ profile: Type.String() }, strict), Type.Object({ entry: Type.String() }, strict), Type.Object({ url: Type.String() }, strict),
    Type.Object({ check: Type.String(), sha256: Type.String(), experiment: Type.Optional(Type.String()) }, strict),
   ]))) }, strict),
  async execute(id, args, signal) { return { content: [{ type: "text", text: await scout(args, signal, id) }], details: {} }; },
 });
 return { scout, tool };
}
