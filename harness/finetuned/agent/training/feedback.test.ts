import { test, expect } from "bun:test";
import { noiseVerdict } from "./feedback.js";
test("the verdict states the paired difference and separates noise from significantly worse", () => {
 expect(noiseVerdict({ status: "completed", meanDifference: .0004, standardError: .001, leadExceedsNoise: false }))
  .toBe("+0.0004: within fold noise (paired difference does not exceed 2 standard errors, standard error 0.0010)");
 expect(noiseVerdict({ status: "completed", meanDifference: .01, leadExceedsNoise: true })).toStartWith("+0.0100: improvement beyond fold noise");
 expect(noiseVerdict({ status: "completed", meanDifference: -.003, leadExceedsNoise: false })).toStartWith("-0.0030: within fold noise");
 expect(noiseVerdict({ status: "completed", meanDifference: -.02, leadExceedsNoise: true })).toStartWith("-0.0200: significantly worse than the champion");
 expect(noiseVerdict({ status: "partial" })).toBe("no completed paired comparison");
});
