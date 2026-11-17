/** Factual feedback from completed diagnostic folds; never selection evidence. */
type Detail = Record<string, any>;
const object = (value: unknown): Detail => value && typeof value === "object" ? value as Detail : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const numbers = (values: unknown[]) => values.filter(finite);
const format = (value: unknown) => finite(value) ? value.toFixed(3) : "unavailable";
const mean = (values: unknown[]) => { const ns = numbers(values); return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : undefined; };
const range = (values: unknown[]) => { const ns = numbers(values); return ns.length ? `${Math.min(...ns)}-${Math.max(...ns)}` : "unavailable"; };
const available = (value: unknown) => object(value).available === false ? {} : object(value);

/** Accepts compact describe results, including optional anchored-batch diagnostics. */
export function checkpointDigest(kind: string, described: unknown): string | undefined {
 const folds = object(object(described).diagnostics).folds;
 return Array.isArray(folds) && folds.some(fold => fold && (fold.status === undefined || fold.status === "completed")) ? trialDigest(kind, described) : undefined;
}

/** Digest labels are factual measurement labels. */
export function trialDigest(kind: string, described: unknown): string {
 const result = object(described), diagnostics = available(result.diagnostics);
 const folds: Detail[] = (Array.isArray(diagnostics.folds) ? diagnostics.folds : [])
  .filter((fold: any) => fold && (fold.status === undefined || fold.status === "completed"))
  .map((fold: any) => available(fold.diagnostics));
 const avg = (section: string, key: string) => format(mean(folds.map(fold => available(fold[section])[key])));
 if (kind === "clustering") {
  const stability = available(diagnostics.stability);
  const comparisons = Array.isArray(stability.comparisons) ? stability.comparisons : [];
  const ari = mean(comparisons.map((row: any) => object(row).adjustedRandIndex)) ?? available(stability.summary).mean;
  const lines = [
   `clusters per batch ${range(folds.map(fold => available(fold.structure).clusterCount))}; mean singleton fraction ${avg("structure", "singletonFraction")}; mean largest-cluster share ${avg("structure", "largestClusterShare")}`,
   `mean pair precision ${avg("external", "pairPrecision")} (false merges), recall ${avg("external", "pairRecall")} (false splits); cross-repeat stability mean ARI ${format(ari)}`,
  ];
  if (folds.some(fold => fold.testPart !== undefined) || diagnostics.testAgreement !== undefined) {
   const agreement = available(diagnostics.testAgreement);
   lines.push(`test part: clusters ${range(folds.map(fold => available(fold.testPart).clusterCount))}, singleton fraction ${avg("testPart", "singletonFraction")}, largest share ${avg("testPart", "largestClusterShare")}; agreement across fits mean ${format(agreement.meanAdjustedRandIndex)}, min ${format(agreement.minAdjustedRandIndex)}`);
  }
  return lines.join("\n");
 }
 if (kind === "multiclass_classification") {
  // describe() returns compact diagnostics; trial metrics sit under diagnostics.metrics there.
  const metrics = object(result.metrics ?? diagnostics.metrics);
  const worst = Object.entries(object(metrics.perClassRecall)).sort((a, b) => Number(a[1]) - Number(b[1])).slice(0, 5);
  return `balanced accuracy ${format(metrics.balancedAccuracy)}; worst-recall classes ${worst.map(([label, recall]) => `${label}: ${format(recall)}`).join(", ")}; top confusions ${JSON.stringify(metrics.topConfusions ?? [])}`;
 }
 if (kind === "binary_classification") {
  const recall = mean(folds.map(fold => {
   const points = available(fold.lowFpr).points;
   return Array.isArray(points) ? points.find((point: any) => point?.maxFpr === 0.01)?.recall : undefined;
  }));
  const comparison = available(diagnostics.championComparison ?? result.championComparison);
  return [
   `mean ROC AUC ${avg("ranking", "rocAuc")}, average precision ${avg("ranking", "averagePrecision")}; mean recall at 1% FPR ${format(recall)}`,
   `threshold sweep (threshold picked on validation rows): mean default balanced accuracy ${avg("thresholdSweep", "defaultBalancedAccuracy")} vs best ${avg("thresholdSweep", "bestBalancedAccuracy")}`,
   `champion errors: corrected ${finite(comparison.correctedErrors) ? comparison.correctedErrors : "unavailable"}, introduced ${finite(comparison.introducedErrors) ? comparison.introducedErrors : "unavailable"}`,
  ].join("\n");
 }
 if (kind === "anomaly_detection") {
  const constants = folds.map(fold => typeof fold.constantScores === "boolean" ? Number(fold.constantScores) : undefined);
  return `score health (proxy): mean tie fraction ${format(mean(folds.map(fold => fold.tieFraction)))}; constant-score fold fraction ${format(mean(constants))}; mean flagged share ${format(mean(folds.map(fold => fold.predictedAnomalyFraction)))}`;
 }
 return "unavailable";
}
