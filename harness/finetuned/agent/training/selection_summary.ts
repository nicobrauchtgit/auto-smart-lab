/** Selection receipts remain separate from the task's official metric. */
export function selectionSummary(result: Record<string, any> | undefined): Record<string, unknown> | undefined {
 const receipt = result?.selection;
 if (!receipt || receipt.basis !== "evidence") return undefined;
 const folds: Record<string, any>[] = Array.isArray(receipt.folds) ? receipt.folds : [];
 const sum = (key: string) => folds.reduce((total, fold) => total + (typeof fold?.[key] === "number" ? fold[key] : 0), 0);
 const validationRows = sum("validationRows"), labelledRows = sum("labelledRows");
 return { basis: receipt.basis, metric: receipt.metric, direction: receipt.direction, population: receipt.population,
  value: result?.metrics?.selectionScore, source: receipt.source, evidenceSha256: receipt.evidenceSha256,
  coverage: { unit: "validation_observations", validationRows, labelledRows, positiveRows: sum("positiveRows"), negativeRows: sum("negativeRows"),
   labelCoverage: validationRows ? labelledRows / validationRows : 0 },
  limitation: "Selection on supplied evidence does not establish official accuracy or label correctness" };
}
