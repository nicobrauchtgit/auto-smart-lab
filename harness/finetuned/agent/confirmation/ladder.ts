/** Controller-only Ladder state; release only rounded significant improvements. */
export interface LadderVerdict { queryCount: number; verdict: "holdout confirms the improvement" | "no significant improvement"; roundedScore?: number }
export interface LadderState { step: number; best: number | null; queries: { identity: string; verdict: LadderVerdict }[] }
/** Fixed Ladder resolution n^(-1/3); the accepted rounded score is its next threshold. */
export function ladderQuery(prior: LadderState | undefined, identity: string, score: number, rows: number): { state: LadderState; feedback: LadderVerdict } {
 if (!identity || !Number.isFinite(score) || score < 0 || score > 1 || !Number.isInteger(rows) || rows < 2) throw new Error("Invalid Ladder query");
 const step = rows ** (-1 / 3);
 if (prior && (prior.step !== step || !Array.isArray(prior.queries) || (prior.best !== null && !Number.isFinite(prior.best)))) throw new Error("Corrupt or changed Ladder population");
 const cached = prior?.queries.find(query => query.identity === identity);
 if (cached) return { state: prior!, feedback: cached.verdict };
 const state: LadderState = prior ? structuredClone(prior) : { step, best: null, queries: [] };
 const improved = state.best === null || score > state.best + step;
 const rounded = Math.round(score / step) * step;
 const feedback: LadderVerdict = { queryCount: state.queries.length + 1, verdict: improved ? "holdout confirms the improvement" : "no significant improvement", ...(improved ? { roundedScore: Math.max(0, Math.min(1, rounded)) } : {}) };
 if (improved) state.best = rounded;
 state.queries.push({ identity, verdict: feedback });
 return { state, feedback };
}
