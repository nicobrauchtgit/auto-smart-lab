/**
 * The champion promotion rule (D7): a challenger replaces the current champion
 * only when its paired lead on identical folds exceeds fold noise. A positive
 * mean difference alone is not enough; it can come from chance.
 */

export type PromotionDecision = { promote: true } | { promote: false; reason: string };

export function pairedPromotion(comparison: Record<string, unknown> | undefined, championCommit: string): PromotionDecision {
 if (comparison?.status !== "completed" || comparison.championCommit !== championCommit)
  return { promote: false, reason: "no completed paired comparison against the current champion" };
 if (typeof comparison.meanDifference !== "number" || comparison.meanDifference <= 0)
  return { promote: false, reason: "no paired improvement over the current champion" };
 // `leadExceedsNoise` comes from smartlab_trial/search.py `_paired`:
 // |mean difference| > 2 standard errors of the per-fold differences.
 if (comparison.leadExceedsNoise !== true)
  return { promote: false, reason: "paired lead over the current champion does not exceed fold noise" };
 return { promote: true };
}
