/** Agent-visible interpretation of paired development measurements. */
export function noiseVerdict(comparison?: Record<string, unknown>): string {
 if (comparison?.status !== "completed") return "no completed paired comparison";
 return comparison.leadExceedsNoise === true && typeof comparison.meanDifference === "number" && comparison.meanDifference > 0
  ? "improvement beyond noise: paired lead exceeds 2 standard errors"
  : "within noise or worse: paired lead does not exceed 2 standard errors";
}
