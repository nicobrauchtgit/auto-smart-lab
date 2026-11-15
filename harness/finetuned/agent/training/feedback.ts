/**
 * Agent-visible interpretation of paired development measurements.
 * `leadExceedsNoise` is |mean paired difference| > 2 standard errors of the
 * per-fold differences (smartlab_trial/search.py `_paired`), so a negative
 * difference beyond noise is significantly worse, not merely "not better".
 */
const signed = (value: number) => `${value >= 0 ? "+" : "-"}${Math.abs(value).toFixed(4)}`;
export function noiseVerdict(comparison?: Record<string, unknown>): string {
 if (comparison?.status !== "completed") return "no completed paired comparison";
 const difference = comparison.meanDifference;
 if (typeof difference !== "number" || !Number.isFinite(difference)) return "paired comparison has no mean difference";
 const error = typeof comparison.standardError === "number" && Number.isFinite(comparison.standardError) ? `, standard error ${comparison.standardError.toFixed(4)}` : "";
 if (comparison.leadExceedsNoise === true && difference > 0) return `${signed(difference)}: improvement beyond fold noise (paired lead exceeds 2 standard errors${error})`;
 if (comparison.leadExceedsNoise === true && difference < 0) return `${signed(difference)}: significantly worse than the champion (paired deficit exceeds 2 standard errors${error})`;
 return `${signed(difference)}: within fold noise (paired difference does not exceed 2 standard errors${error})`;
}
