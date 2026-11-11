import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { HARNESS_CONFIG } from "../harness/config.js";
import type { PromptSnapshot, RenderedPrompt } from "../prompts/loader.js";
import { REPO_ROOT, statePath } from "../paths.js";
import { ScoutBudget } from "./budget.js";
import { appendValidFindings, validRef } from "./journal.js";
import { earlierFindings } from "./findings.js";
import type { FindingKind, FindingRef, ScoutRole, TrialSnapshot } from "./contracts.js";
import { describeRefs, type TrialResolver } from "./trials.js";

export interface ScoutRequest { role: ScoutRole | ScoutRole[]; question: string; refs?: FindingRef[] }
export interface ScoutSessionInput {
 role: ScoutRole; toolCallId: string;
 /** Instructions every scout role gets, before its role prompt. */
 shared: RenderedPrompt;
 system: RenderedPrompt; opening: RenderedPrompt; budget: ScoutBudget; signal?: AbortSignal;
 /** Validation only: the resolved, verified snapshot of the trial under check. */
 trial?: TrialSnapshot;
}
/**
 * How one role ended. completed: it returned bullets. empty: it finished
 * without any. stopped: the harness stopped it (`reason`). failed: its session
 * failed (`reason`). `bullets` counts the scout's own items only, never the
 * harness's error, stop or empty line.
 */
export interface ScoutRoleReport { role: ScoutRole; status: "completed" | "empty" | "stopped" | "failed"; bullets: number; reason?: string }
export interface ScoutReport { text: string; roles: ScoutRoleReport[] }
/**
 * One outcome for a whole scout call: success only when every role completed
 * with bullets; otherwise the worst role decides (failure, then stopped, then
 * empty). `bullets` counts scout-written items only.
 */
export function scoutOutcome(report: ScoutReport): { outcome: "success" | "empty" | "stopped" | "failure"; bullets: number; reasons: string[] } {
 const has = (status: ScoutRoleReport["status"]) => report.roles.some(role => role.status === status);
 return {
  outcome: !report.roles.length || has("failed") ? "failure" : has("stopped") ? "stopped" : has("empty") ? "empty" : "success",
  bullets: report.roles.reduce((sum, role) => sum + role.bullets, 0),
  reasons: report.roles.filter(role => role.reason).map(role => `${role.role} ${role.status}: ${role.reason}`),
 };
}
/**
 * Final scout text; `root` is the scout's cwd, against which its file
 * citations resolve. `checks` lists the validation checks the harness ran in
 * this session (paths relative to the shared solutions tree, with the hash of
 * the bytes it ran).
 */
export interface ScoutReply { text: string; root?: string; stopped?: string; checks?: { path: string; sha256: string }[] }
export interface ScoutsOptions {
 /** `task` is task.md as stream B wrote it: the unit introduction, then the task text. */
 prompts: PromptSnapshot; taskId: string; task: string; dataPaths: string;
 /** Staged course resources, one line each (team/workspace.ts). */
 resources: string;
 journalPath: string; datasetSha256: string; runId: string; invocationId: string;
 /** State root that journaled file citations are stored relative to; default runs/finetuned. */
 citationBase?: string;
 /** Backend must isolate all tool traffic from the caller; only final text returns. */
 run(input: ScoutSessionInput): Promise<string | ScoutReply>;
 prepare(roles: readonly ScoutRole[], signal?: AbortSignal): Promise<void>;
 /** Stream B's trial resolver for this task. Without it, validation fails closed and trial refs are unresolved. */
 trials?: TrialResolver;
 /** The shared solutions tree; validation writes checks to its `checks/<task>/`. */
 solutionsRoot?: string;
 budgets?: Partial<Record<ScoutRole, number>>;
}

/** `path`, `path:line` or `path:first-last` (linked to its first line). */
const FILE_CITATION = /^([\w./-]+\.(?:py|txt|md|json|jsonl|csv|tsv|log|labels))(?::(\d+)(?:-\d+)?)?$/;
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

/** Snapshot file and executed-check citations of one validation bullet, plus the trial itself. */
export function validationRefs(text: string, trial: TrialSnapshot, options: { solutionsRoot?: string; checks?: readonly { path: string; sha256: string }[] } = {}): FindingRef[] {
 const refs: FindingRef[] = [{ experiment: trial.experimentId }];
 const snapshot = join(trial.sourceRoot, "solutions");
 for (const match of text.matchAll(/`([^`\s]+)`/g)) {
  const file = FILE_CITATION.exec(match[1]);
  if (!file) continue;
  const cited = options.solutionsRoot && isAbsolute(file[1]) ? relative(options.solutionsRoot, file[1]).split(sep).join("/") : file[1];
  const check = options.checks?.find(row => row.path === cited);
  if (check) { refs.push({ check: check.path, experiment: trial.experimentId, sha256: check.sha256 }); continue; }
  const inside = relative(snapshot, resolve(snapshot, file[1])).split(sep).join("/");
  if (!inside || inside.startsWith("..") || isAbsolute(inside) || !existsSync(join(snapshot, inside))) continue;
  if (file[2] === undefined || Number(file[2]) >= 1) refs.push({ file: inside, line: Number(file[2] ?? 1), commit: trial.commit });
 }
 const unique = new Map(refs.filter(validRef).map(ref => [JSON.stringify(ref), ref]));
 return [...unique.values()];
}
/** ok, fix and advice bullets journal as fact, defect and idea; anything else is not a validation finding. */
export function validationKind(text: string): FindingKind | undefined {
 const prefix = /^\W*(ok|fix|advice)\W*[:\u2014-]/i.exec(text)?.[1]?.toLowerCase();
 return prefix === "ok" ? "fact" : prefix === "fix" ? "defect" : prefix === "advice" ? "idea" : undefined;
}
/** The one trial a validation request names, from `{experiment}` and `{check, experiment}` refs. */
export function validationExperiments(refs: readonly FindingRef[] = []): string[] {
 return [...new Set(refs.flatMap(ref => "experiment" in ref && ref.experiment ? [ref.experiment] : []))];
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
 if (roles.includes("validation") && validationExperiments(value.refs as FindingRef[] | undefined).length !== 1)
  return "validation needs exactly one measured trial: one {experiment} reference (or {check, experiment} references to the same trial)";
}
const clip = (value: string, length: number) => value.length > length ? `${value.slice(0, length - 1)}…` : value;

export function createScouts(options: ScoutsOptions) {
 if (!options.task.trim()) throw new Error("Scout requires task text (task.md with the unit introduction)");
 const citationBase = options.citationBase ?? statePath(REPO_ROOT);
 // Keep the requested scout roles sequential and journal observations before continuing.
 let tail: Promise<unknown> = Promise.resolve();
 const execute = async (request: ScoutRequest, signal: AbortSignal | undefined, toolCallId: string): Promise<ScoutReport> => {
  const problem = scoutRequestProblem(request);
  if (problem) throw new Error(`Invalid scout request: ${problem}`);
  const roles = [...new Set(Array.isArray(request.role) ? request.role : [request.role])];
  await options.prepare(roles, signal);
  const shared = options.prompts.render("team.shared", {});
  const output: string[] = [];
  const outcomes: ScoutRoleReport[] = [];
  const refs = await describeRefs(request.refs ?? [], options.trials);
  const failed = (role: ScoutRole, error: unknown) => {
   const reason = clip(error instanceof Error ? error.message : "unknown error", 200);
   output.push(options.prompts.render("team.failed", { role, reason }).text.trim());
   outcomes.push({ role, status: "failed", bullets: 0, reason });
  };
  for (const role of roles) {
   signal?.throwIfAborted();
   const budget = new ScoutBudget(options.budgets?.[role] ?? HARNESS_CONFIG.team.scouts[role].maxToolCalls, options.prompts);
   // Validation inspects one verified snapshot; when it cannot be resolved, the role fails and never falls back to live code.
   let trial: TrialSnapshot | undefined;
   if (role === "validation") try {
    if (!options.trials || !options.solutionsRoot) throw new Error("no trial records available; validation never uses live code");
    trial = await options.trials.snapshot(validationExperiments(request.refs)[0]);
   } catch (error) {
    signal?.throwIfAborted();
    failed(role, new Error(`snapshot unavailable: ${error instanceof Error ? error.message : "unknown error"}`));
    continue;
   }
   const system = role === "data" ? options.prompts.render("team.data", { taskId: options.taskId, budget: String(budget.limit), dataPaths: options.dataPaths, resources: options.resources })
    : role === "ideas" ? options.prompts.render("team.ideas", { taskId: options.taskId, budget: String(budget.limit), webSearches: String(HARNESS_CONFIG.team.scouts.ideas.webSearches), resources: options.resources })
    : options.prompts.render("team.validation", { taskId: options.taskId, budget: String(budget.limit), experiment: trial!.experimentId, commit: trial!.commit,
     checks: join(options.solutionsRoot!, "checks", options.taskId) });
   const earlier = await earlierFindings(options.journalPath, { runId: options.runId, datasetSha256: options.datasetSha256 });
   const opening = options.prompts.render("team.start", { task: options.task, question: request.question,
    refs, shown: String(earlier.lines.length), omitted: String(earlier.omitted),
    earlier: earlier.lines.length ? earlier.lines.join("\n") : "none" });
   let reply: ScoutReply;
   try {
    const result = await options.run({ role, toolCallId, shared, system, opening, budget, signal, ...trial ? { trial } : {} });
    reply = typeof result === "string" ? { text: result } : result;
   } catch (error) {
    signal?.throwIfAborted();
    // Earlier roles' bullets are already journaled; report this role and continue.
    failed(role, error);
    continue;
   }
   // Scout-written items only; the harness's stop or empty line is not a finding and is not journaled.
   const bullets = finalBullets(reply.text, "").filter(Boolean);
   outcomes.push({ role, status: reply.stopped ? "stopped" : bullets.length ? "completed" : "empty", bullets: bullets.length, ...reply.stopped ? { reason: reply.stopped } : {} });
   if (!bullets.length) {
    output.push((reply.stopped ? options.prompts.render("team.stopped", { reason: reply.stopped }) : options.prompts.render("team.empty", {})).text.trim());
    continue;
   }
   // Validation bullets must say ok, fix or advice; others are returned but not journaled.
   const unlabelled = role === "validation" ? bullets.filter(bullet => !validationKind(bullet.replace(/^- /, ""))) : [];
   const { rejected } = await appendValidFindings(options.journalPath, bullets.filter(bullet => !unlabelled.includes(bullet)).map(bullet => {
    const prose = bullet.replace(/^- /, "");
    return {
     kind: role === "ideas" ? "idea" as const : role === "validation" ? validationKind(prose)! : "fact" as const,
     author: { role, invocationId: options.invocationId, runId: options.runId },
     title: clip(prose.split("\n")[0].trim(), 100), text: clip(prose.split("\n").map(line => line.trim()).join(" "), 800),
     refs: trial ? validationRefs(bullet, trial, { solutionsRoot: options.solutionsRoot, checks: reply.checks }) : bulletRefs(bullet, { root: reply.root, base: citationBase }),
     datasetSha256: options.datasetSha256,
    };
   }), signal);
   rejected.push(...unlabelled.map(bullet => ({ index: -1, title: bullet.replace(/^- /, "").slice(0, 100), reason: "validation bullets start with ok, fix or advice" })));
   output.push(...bullets);
   if (rejected.length) output.push(options.prompts.render("team.rejected", { count: String(rejected.length),
    reasons: rejected.map(row => `"${clip(row.title, 40)}": ${row.reason}`).join("; ") }).text.trim());
  }
  return { text: output.join("\n"), roles: outcomes };
 };
 /** Lead-facing text plus each role's outcome, for callers that must tell completed scouts from failed or stopped ones. */
 const report = (request: ScoutRequest, signal?: AbortSignal, toolCallId: string = randomUUID()): Promise<ScoutReport> => {
  const pending = tail.then(() => execute(request, signal, toolCallId));
  tail = pending.catch(() => undefined);
  return pending;
 };
 const scout = async (request: ScoutRequest, signal?: AbortSignal, toolCallId?: string) => (await report(request, signal, toolCallId)).text;
 const role = Type.Union([Type.Literal("data"), Type.Literal("ideas"), Type.Literal("validation")]);
 const strict = { additionalProperties: false } as const;
 const tool = defineTool({ name: "scout", label: "Scout", description: options.prompts.render("team.scout-tool", {}).text,
  parameters: Type.Object({ role: Type.Union([role, Type.Array(role, { minItems: 1, maxItems: 3 })]), question: Type.String({ minLength: 1 }),
   refs: Type.Optional(Type.Array(Type.Union([
    Type.Object({ experiment: Type.String() }, strict), Type.Object({ file: Type.String(), line: Type.Integer({minimum: 1}), commit: Type.Optional(Type.String()) }, strict),
    Type.Object({ profile: Type.String() }, strict), Type.Object({ entry: Type.String() }, strict), Type.Object({ url: Type.String() }, strict),
    Type.Object({ check: Type.String(), sha256: Type.String(), experiment: Type.Optional(Type.String()) }, strict),
   ]))) }, strict),
  async execute(id, args, signal) { return { content: [{ type: "text", text: await scout(args, signal, id) }], details: {} }; },
 });
 return { scout, report, tool };
}
