import { expect, test } from "bun:test";

import { pairedPromotion, pairedRepair } from "./promotion.js";

const champion = "a".repeat(40);
const comparison = { status: "completed", championCommit: champion, meanDifference: 0.01, standardError: 0.002, leadExceedsNoise: true };

test("repair requires a known paired verdict and rejects significant losses", () => {
 for (const [delta, se, expected] of [[0, 0, true], [0.0097, 0.0052, true], [-0.01, 0.01, true], [-0.03, 0.01, false], [-0.001, 0, false]] as const)
  expect(pairedRepair({...comparison, meanDifference:delta, standardError:se}, champion)).toBe(expected);
 for (const invalid of [{status:'partial'}, {championCommit:'stale'}, {standardError:null}, {standardError:NaN}, {standardError:-1}, {meanDifference:Infinity}, {leadExceedsNoise:undefined}])
  expect(pairedRepair({...comparison,...invalid}, champion)).toBe(false);
});

test("a paired lead beyond fold noise promotes the challenger", () => {
 expect(pairedPromotion(comparison, champion)).toEqual({ promote: true });
});

test("a positive but noisy lead keeps the current champion", () => {
 const decision = pairedPromotion({ ...comparison, standardError: 0.008, leadExceedsNoise: false }, champion);
 expect(decision).toEqual({ promote: false, reason: "paired lead over the current champion does not exceed fold noise" });
 // A missing noise verdict (e.g. a single paired fold) is not a lead either.
 const { leadExceedsNoise: _, ...unknown } = comparison;
 expect(pairedPromotion(unknown, champion).promote).toBe(false);
});

test("no improvement or no completed comparison keeps the current champion", () => {
 expect(pairedPromotion({ ...comparison, meanDifference: 0, leadExceedsNoise: false }, champion))
  .toEqual({ promote: false, reason: "no paired improvement over the current champion" });
 expect(pairedPromotion({ ...comparison, meanDifference: -0.02 }, champion).promote).toBe(false);
 expect(pairedPromotion({ ...comparison, status: "partial" }, champion).promote).toBe(false);
 expect(pairedPromotion({ ...comparison, championCommit: "b".repeat(40) }, champion).promote).toBe(false);
 expect(pairedPromotion(undefined, champion))
  .toEqual({ promote: false, reason: "no completed paired comparison against the current champion" });
});
