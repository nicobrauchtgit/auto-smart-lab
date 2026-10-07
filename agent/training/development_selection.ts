import { join, resolve } from "node:path";
import { isRepositoryRoot, tagMessage } from "./git.js";
import { isTerminalCandidate } from "./terminal.js";
import { collectTrainingTrial, type TrainingCollection, type TrainingResultError, type TrainingTrialResult } from "./results.js";

export const CHAMPION_TAG = "champion";

/** The solutions repository a versioned trial recorded as its source. */
export function recordedRepository(trial: TrainingTrialResult | undefined): string | undefined {
 const repository = (trial?.invocation?.source as { repository?: unknown } | undefined)?.repository;
 return typeof repository === "string" ? repository : undefined;
}

/**
 * The champion tag is the only selection rule: a trial becomes champion only
 * when its paired lead over the previous champion exceeds noise (D7), so a
 * higher raw CV mean alone never selects a trial. The champion may come from
 * an earlier solve run; its evidence is then read from the training root the
 * tag records and its artifacts join the collection.
 */
export async function championSelection(collection: TrainingCollection, repository: string | undefined, taskId: string): Promise<TrainingCollection> {
 const { selected: _, ...rest } = collection;
 // Surface corrupt terminal markers of any open-looking trial, not just the champion's.
 if (repository) for (const trial of collection.trials) {
  const commit = (trial.invocation?.source as { commit?: string } | undefined)?.commit;
  if (trial.eligible && trial.request && commit) isTerminalCandidate(repository, taskId, commit, trial.request.pipeline);
 }
 const fail = (message: string): TrainingCollection => ({ ...rest, valid: false,
  errors: collection.errors.some(error => error.code === "no_eligible_result") ? collection.errors
   : [...collection.errors, { code: "no_eligible_result", message } as TrainingResultError] });
 if (!repository || !isRepositoryRoot(repository)) return fail("No solutions repository records a champion");
 const tag = tagMessage(repository, CHAMPION_TAG);
 if (!tag) return fail("No champion: no completed promotion has been tagged");
 let message: { experimentId?: unknown; trainingRoot?: unknown };
 try { message = JSON.parse(tag.message); } catch { return fail("Malformed champion tag"); }
 if (typeof message.experimentId !== "string") return fail("Malformed champion tag");
 const experimentId = message.experimentId;
 const local = collection.trials.find(trial => trial.experimentId === experimentId);
 const champion = local ?? (typeof message.trainingRoot === "string"
  ? await collectTrainingTrial(join(message.trainingRoot, experimentId)) : undefined);
 if (!champion?.eligible || !champion.request) return fail(`Champion ${experimentId} has no valid eligible evidence`);
 const source = champion.invocation?.source as { commit?: string } | undefined;
 if (source?.commit !== tag.commit || resolve(recordedRepository(champion) ?? "") !== resolve(repository))
  return fail(`Champion ${experimentId} evidence does not match the champion tag`);
 if (isTerminalCandidate(repository, taskId, tag.commit, champion.request.pipeline))
  return fail("No independently validated candidate remains open for development; frozen evidence is historical only");
 return { ...rest, selected: champion, valid: true,
  artifacts: local ? collection.artifacts : [...collection.artifacts, ...champion.artifacts] };
}
