/**
 * PROGRESS.json: the harness's own record of one lead run (expert-team-v2.md
 * section 5). Written by the harness after every lead tool call and every
 * trial result, never by the agent: champion, trials with their one-line
 * hypotheses, holdout (Ladder) verdicts and budget left. A killed or
 * compacted lead resumes from it and the solutions/ git history.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { atomicJson } from "../experiments/ownership.js";
import type { PromptSnapshot } from "../prompts/loader.js";

export interface LeadTrialRecord {
 experimentId: string;
 /** First sentence of the agent's hypothesis, at most 160 characters. */
 hypothesis: string;
 status: string;
 /** The task's primary development metric (mean over folds), when measured. */
 score?: number;
 verdict?: string;
 becameChampion?: boolean;
 startedAt: string;
 finishedAt?: string;
}
export interface LeadHoldoutRecord {
 experimentId: string;
 status: "completed" | "skipped" | "failed";
 verdict?: string;
 /** Released only with a significant improvement (Ladder), rounded. */
 score?: number;
 queryCount?: number;
 reason?: string;
}
export interface LeadHandOver {
 by: "lead" | "harness";
 /** Why the harness handed over on its own: budget, idle lead, failed session. */
 reason: string;
 experimentId: string;
 validation: { status: string; fix: string[]; advice: string[]; ok: string[] };
 at: string;
}
export interface LeadProgress {
 schemaVersion: 1;
 taskId: string;
 /** The run that owns this record; a resumed run keeps it. */
 runId: string;
 trainingRoot: string;
 status: "running" | "handing_over" | "handed_over" | "failed";
 startedAt: string;
 /** Every process start of this run (resumes included). */
 sessions: { startedAt: string; invocationId: string }[];
 firstTrialAt?: string;
 champion?: { experimentId: string; score?: number; commit?: string };
 trials: LeadTrialRecord[];
 holdout: LeadHoldoutRecord[];
 budget: { limit: number; used: number };
 scoutCalls: number;
 handOver?: LeadHandOver;
 delivery?: string;
 error?: string;
}

export function readProgress(path: string): LeadProgress | undefined {
 if (!existsSync(path)) return undefined;
 const value = JSON.parse(readFileSync(path, "utf8")) as LeadProgress;
 if (value?.schemaVersion !== 1 || typeof value.runId !== "string" || typeof value.trainingRoot !== "string" || !Array.isArray(value.trials)
  || !value.budget || !Number.isSafeInteger(value.budget.used)) throw new Error(`Corrupt lead progress at ${path}; restore or remove it before restarting`);
 return value;
}
export function writeProgress(path: string, progress: LeadProgress): void {
 mkdirSync(dirname(path), { recursive: true });
 atomicJson(path, progress);
}
/** The first sentence of a hypothesis, at most 160 characters: the one-line record. */
export function oneLine(text: string): string {
 const first = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s/)[0] ?? "";
 return first.length > 160 ? `${first.slice(0, 159)}…` : first;
}
const score = (value?: number) => value === undefined ? "unmeasured" : value.toFixed(4);
/** The record as the lead reads it after a resume or a context handoff. */
export function renderProgress(prompts: PromptSnapshot, progress: LeadProgress) {
 const holdout = progress.holdout.length ? progress.holdout.map(row => `${row.experimentId} ${row.status}${row.verdict ? `: ${row.verdict}` : ""}${row.score !== undefined ? ` (${row.score.toFixed(4)})` : ""}${row.reason ? ` (${row.reason})` : ""}`).join("; ")
  + `; queries used: ${Math.max(0, ...progress.holdout.map(row => row.queryCount ?? 0))}` : "none yet";
 return prompts.render("team.lead-progress", {
  champion: progress.champion ? `${progress.champion.experimentId} (${score(progress.champion.score)})` : "none yet",
  trials: progress.trials.length ? progress.trials.map(trial => `- ${trial.experimentId}: ${trial.status}, ${score(trial.score)}${trial.verdict ? `; ${trial.verdict}` : ""}${trial.becameChampion ? "; became champion" : ""} — ${trial.hypothesis}`).join("\n") : "- none yet",
  holdout, budget: `${progress.budget.used} of ${progress.budget.limit} used`, scouts: String(progress.scoutCalls),
 });
}
