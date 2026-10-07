import { isTerminalCandidate } from "./terminal.js";
import type { TrainingCollection } from "./results.js";
/** Retain all historical measurements; select only identities still open to development. */
export function developmentSelection(collection: TrainingCollection, repository: string, taskId: string): TrainingCollection {
 const eligible = collection.trials.filter(trial => {
  if (!trial.eligible || !trial.request) return false;
  const source = trial.invocation?.source as { commit?: string } | undefined;
  // Legacy/non-versioned test adapters have no source identity. The registered
  // harness always supplies it and verifies git evidence independently.
  return !source?.commit || !isTerminalCandidate(repository, taskId, source.commit, trial.request.pipeline);
 }).sort((a, b) => (b.result?.metrics?.balancedAccuracy ?? -Infinity) - (a.result?.metrics?.balancedAccuracy ?? -Infinity) || a.experimentId.localeCompare(b.experimentId));
 const selected = eligible[0];
 return { ...collection, selected, valid: !!selected, errors: selected || collection.errors.some(error => error.code === "no_eligible_result") ? collection.errors : [...collection.errors, { code: "no_eligible_result", message: "No independently validated candidate remains open for development; frozen evidence is historical only" } as any] };
}
