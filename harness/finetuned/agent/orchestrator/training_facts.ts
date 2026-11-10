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
