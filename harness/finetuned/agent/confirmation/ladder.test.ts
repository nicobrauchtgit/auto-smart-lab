import { test, expect } from "bun:test";
import { ladderQuery } from "./ladder.js";
test("Ladder counts every new query, withholds insignificant scores, and reuses durable identities", () => {
 const first = ladderQuery(undefined, "a", .8, 1000);
 expect(first.feedback.roundedScore).toBeCloseTo(.8);
 const noise = ladderQuery(first.state, "b", .81, 1000);
 expect(noise.feedback).toEqual({ queryCount: 2, verdict: "no significant improvement" });
 const better = ladderQuery(noise.state, "c", .96, 1000);
 expect(better.feedback.queryCount).toBe(3);
 expect(better.feedback.verdict).toBe("holdout confirms the improvement");
 expect(ladderQuery(better.state, "b", .81, 1000).state.queries.length).toBe(3);
 expect(first.state.queries.length).toBe(1);
});
