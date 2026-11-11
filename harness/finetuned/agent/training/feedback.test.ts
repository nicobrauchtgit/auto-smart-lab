import { test, expect } from "bun:test";
import { noiseVerdict } from "./feedback.js";
test("a positive within-noise lead is stated explicitly", () => {
 expect(noiseVerdict({ status: "completed", meanDifference: .001, leadExceedsNoise: false })).toContain("within noise");
 expect(noiseVerdict({ status: "completed", meanDifference: .01, leadExceedsNoise: true })).toContain("beyond noise");
});
