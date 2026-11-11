import { test, expect } from "bun:test";
import { balancedLosses, ladderQuery } from "./ladder.js";

// spam1-sized held-back population: 201 ham and 200 spam rows.
const ids = Array.from({ length: 401 }, (_, index) => `row-${index}`);
const truth = ids.map((_, index) => index < 201 ? 0 : 1);
const predictionsWithErrors = (wrong: number[]) => truth.map((label, index) => wrong.includes(index) ? 1 - label : label);
const losses = (wrong: number[]) => balancedLosses(truth, predictionsWithErrors(wrong));

test("balanced losses average to the balanced error", () => {
 const values = losses([0, 1, 300]);
 const balancedAccuracy = 1 - ((2 / 201) + (1 / 200)) / 2;
 expect(1 - values.reduce((a, b) => a + b, 0) / values.length).toBeCloseTo(balancedAccuracy, 12);
});

test("a real improvement of about 0.005 on spam1-sized data is revealed with its score", () => {
 const first = ladderQuery(undefined, "champion-1", ids, losses([3, 50, 250, 390]));
 expect(first.feedback.verdict).toBe("holdout confirms the improvement");
 // Released at the holdout's own resolution, not a coarse grid.
 expect(first.feedback.score).toBeCloseTo(Math.round((1 - (2 / 201 + 2 / 200) / 2) * 401) / 401, 12);
 // The next champion fixes two of those errors and makes no new ones: +0.005.
 const better = ladderQuery(first.state, "champion-2", ids, losses([3, 250]));
 expect(better.feedback.verdict).toBe("holdout confirms the improvement");
 expect(better.feedback.improvement).toBeGreaterThan(0.004);
 expect(better.feedback.improvement).toBeLessThan(0.006);
 expect(better.feedback.score).toBeGreaterThan(0.99);
 expect(better.feedback.queryCount).toBe(2);
});

test("Ladder counts every new query, withholds insignificant scores, and reuses durable identities", () => {
 const first = ladderQuery(undefined, "a", ids, losses([10, 20, 210, 220]));
 // One error fixed, one new error: within noise, no score released.
 const noise = ladderQuery(first.state, "b", ids, losses([10, 20, 210, 230]));
 expect(noise.feedback).toEqual({ queryCount: 2, verdict: "no significant improvement" });
 const worse = ladderQuery(noise.state, "d", ids, losses([10, 20, 210, 220, 230, 240]));
 expect(worse.feedback).toEqual({ queryCount: 3, verdict: "no significant improvement" });
 expect(ladderQuery(worse.state, "b", ids, losses([0])).state.queries.length).toBe(3);
 expect(first.state.queries.length).toBe(1);
 // Feedback never carries per-row results or labels.
 expect(Object.keys(worse.feedback).sort()).toEqual(["queryCount", "verdict"]);
 expect(() => ladderQuery(worse.state, "e", ids.slice(1), losses([]).slice(1))).toThrow("changed Ladder population");
});
