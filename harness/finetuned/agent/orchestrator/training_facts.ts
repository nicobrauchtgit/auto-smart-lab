/** Read harness-owned evidence without depending on a solve session returning. */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "../paths.js";
import { championSelection } from "../training/development_selection.js";
import type { TrainingTrialResult } from "../training/results.js";

export const trainingDirectory = (taskId: string) => join(STATE_ROOT, taskId, "solve", "training");
export async function promotedChampion(taskId: string): Promise<TrainingTrialResult | undefined> {
 return (await championSelection({ trials: [], valid: false, errors: [], artifacts: [] }, join(STATE_ROOT, "solutions"), taskId)).selected;
}

/** Failed launches explicitly release their training budget and are not trials. */
export function startedTrials(parent: string, runId: string, solveIds: string[]): string[] {
 if (!existsSync(parent)) return [];
 const ids = new Set<string>();
 for (const root of readdirSync(parent, { withFileTypes: true }).filter(e => e.isDirectory())) {
  for (const trial of readdirSync(join(parent, root.name), { withFileTypes: true }).filter(e => e.isDirectory())) {
   const path = join(parent, root.name, trial.name, "recovery.json");
   if (!existsSync(path)) continue;
   const meta = JSON.parse(readFileSync(path, "utf8"));
   if (meta.originPipelineRunId !== runId || !solveIds.includes(meta.originStageInvocationId) || meta.budgetCharged === false) continue;
   if (meta.schemaVersion !== 1 || meta.trial?.id !== trial.name || meta.budgetUnit !== trial.name) throw new Error(`Invalid trial accounting evidence: ${path}`);
   ids.add(trial.name);
  }
 }
 return [...ids].sort();
}
