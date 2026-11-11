/**
 * Controller-only Ladder state: the parameter-free Ladder (Blum & Hardt,
 * ICML 2015, peer-reviewed, Algorithm 2). A new champion's holdout score is
 * released only when its loss beats the best so far by one standard error of
 * the paired per-row loss differences, s/sqrt(n). Released scores are rounded
 * to the holdout's own resolution 1/n, not to a coarse grid.
 *
 * The threshold uses the same paired standard error as the development
 * promotion rule (agent/training/promotion.ts), on the holdout rows. Per-row
 * losses stay in the controller ledger; feedback carries a verdict, the query
 * count and, on a significant improvement, the rounded score.
 */
import { createHash } from "node:crypto";

export const LADDER_RULE = "parameter-free-ladder-blum-hardt-2015";
export type LadderVerdictText = "holdout confirms the improvement" | "no significant improvement";
export interface LadderVerdict {
 queryCount: number;
 verdict: LadderVerdictText;
 /** Released only with a significant improvement, rounded to 1/rows. */
 score?: number;
 /** Signed improvement over the previous best score, rounded to 1/rows; released with the score. */
 improvement?: number;
}
export interface LadderState {
 version: 2;
 rule: typeof LADDER_RULE;
 rows: number;
 /** Identity of the sealed population (ordered row IDs); losses are aligned to it. */
 populationSha256: string;
 best: { identity: string; score: number; losses: number[] } | null;
 queries: { identity: string; verdict: LadderVerdict }[];
}

/** Per-row balanced-error contributions: mean(losses) = 1 - balanced accuracy. */
export function balancedLosses(truth: readonly number[], predicted: readonly number[]): number[] {
 if (truth.length !== predicted.length || !truth.length) throw new Error("Ladder losses need aligned, non-empty holdout rows");
 const counts = new Map<number, number>();
 for (const label of truth) counts.set(label, (counts.get(label) ?? 0) + 1);
 const classes = counts.size;
 return truth.map((label, index) => predicted[index] === label ? 0 : truth.length / (classes * counts.get(label)!));
}

export const populationIdentity = (ids: readonly string[]) => createHash("sha256").update(JSON.stringify(ids)).digest("hex");
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const round = (value: number, rows: number) => Math.round(value * rows) / rows;

/** Paired standard error of the per-row loss differences (sample standard deviation over sqrt(n)). */
export function pairedStandardError(candidate: readonly number[], best: readonly number[]): number {
 const differences = candidate.map((value, index) => value - best[index]!);
 const average = mean(differences);
 const variance = differences.reduce((sum, value) => sum + (value - average) ** 2, 0) / Math.max(1, differences.length - 1);
 return Math.sqrt(variance / differences.length);
}

/** One counted holdout query. A repeated identity returns its recorded verdict without a new query. */
export function ladderQuery(prior: LadderState | undefined, identity: string, ids: readonly string[], losses: readonly number[]): { state: LadderState; feedback: LadderVerdict } {
 const rows = ids.length;
 if (!identity || rows < 2 || losses.length !== rows || losses.some(loss => !Number.isFinite(loss) || loss < 0)) throw new Error("Invalid Ladder query");
 const populationSha256 = populationIdentity(ids);
 if (prior && (prior.version !== 2 || prior.rule !== LADDER_RULE || prior.rows !== rows || prior.populationSha256 !== populationSha256
  || !Array.isArray(prior.queries) || (prior.best !== null && (prior.best.losses?.length !== rows || !Number.isFinite(prior.best.score)))))
  throw new Error("Corrupt or changed Ladder population");
 const cached = prior?.queries.find(query => query.identity === identity);
 if (cached) return { state: prior!, feedback: cached.verdict };
 const state: LadderState = prior ? structuredClone(prior) : { version: 2, rule: LADDER_RULE, rows, populationSha256, best: null, queries: [] };
 const score = 1 - mean(losses);
 const improved = state.best === null || mean(losses) < mean(state.best.losses) - pairedStandardError(losses, state.best.losses);
 const feedback: LadderVerdict = { queryCount: state.queries.length + 1,
  verdict: improved ? "holdout confirms the improvement" : "no significant improvement",
  ...(improved ? { score: round(score, rows), ...(state.best ? { improvement: round(score - state.best.score, rows) } : {}) } : {}) };
 if (improved) state.best = { identity, score, losses: [...losses] };
 state.queries.push({ identity, verdict: feedback });
 return { state, feedback };
}
