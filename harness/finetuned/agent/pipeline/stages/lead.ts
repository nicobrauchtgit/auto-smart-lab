/**
 * Lead stage: the finetuned arm's entry (expert-team-v2.md section 2). One lead
 * agent drives the task with harness trials and blocking scouts, hands its
 * champion over (or the harness does at budget end), and the harness refits
 * that champion deterministically. Its outcome comes from the hand-over and
 * the refit, never from a finished agent session.
 */
import { existsSync } from "node:fs";
import { relative } from "node:path";

import { HARNESS_CONFIG } from "../../harness/config.js";
import { selectionSummary } from "../../training/selection_summary.js";
import { primaryMetric, productionScouts, runLeadSession } from "../../run/lead_session.js";
import { scoutRequirements } from "../../team/setup.js";
import { resolveTask } from "../resolve_task.js";
import { stageConfiguration, taskDataPaths } from "../task_configuration.js";
import type { StageArtifact, StageDefinition } from "../types.js";

export interface LeadOptions {
 /** Root seed for the sealed draw and harness-owned training seed lineage. */
 seed: number;
 foldPolicy: "auto" | { folds: number; repeats: number };
}

function parseFoldPolicy(raw: unknown): LeadOptions["foldPolicy"] {
 if (raw === undefined) return HARNESS_CONFIG.solve.foldPolicy;
 if (raw === "auto") return "auto";
 if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error('lead.foldPolicy must be "auto" or an object with folds and repeats');
 const value = raw as Record<string, unknown>;
 const unknown = Object.keys(value).filter(key => !["folds", "repeats"].includes(key));
 if (unknown.length) throw new Error(`unknown lead.foldPolicy keys: ${unknown.join(", ")}`);
 for (const key of ["folds", "repeats"] as const) if (!Number.isInteger(value[key]) || (value[key] as number) < 1) throw new Error(`lead.foldPolicy.${key} must be a positive integer`);
 if ((value.folds as number) < 2) throw new Error("lead.foldPolicy.folds must be at least 2");
 return { folds: value.folds as number, repeats: value.repeats as number };
}

/** Everything the lead, its scouts, its holdout checks and the terminal refit need, checked before the lead starts. */
export const LEAD_SETUP_REQUIREMENTS = [...new Set(["observability", "model", "python", "task", "training", "solve-isolation", "confirmation", "refit",
 ...scoutRequirements("data"), ...scoutRequirements("ideas"), ...scoutRequirements("validation")] as const)];

export const leadStage: StageDefinition<LeadOptions> = {
 name: "lead",
 setupRequirements: LEAD_SETUP_REQUIREMENTS,
 version: 1,
 description: "One lead agent with harness trials and blocking scouts; hand-over of the champion and its deterministic terminal refit",

 parseOptions(raw) {
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) throw new Error("lead options must be an object");
  const options = (raw ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(options).filter(key => !["seed", "foldPolicy"].includes(key));
  if (unknown.length) throw new Error(`unknown lead options: ${unknown.join(", ")}`);
  const seed = options.seed ?? HARNESS_CONFIG.solve.seed;
  if (!Number.isInteger(seed)) throw new Error("lead.seed must be an integer");
  return { seed: seed as number, foldPolicy: parseFoldPolicy(options.foldPolicy) };
 },

 checkInput(input) {
  const task = resolveTask({ taskId: input.taskId });
  if (!task.hasData) throw new Error(`Task ${task.taskId} has no local dataset; run \`npm run fetch-unit -- ${task.unitSlug}\``);
  const paths = taskDataPaths(task.taskId, stageConfiguration(input));
  for (const path of [paths.trainZip, paths.targetsPath].filter((p): p is string => !!p)) {
   if (!existsSync(path)) throw new Error(`Task ${task.taskId} lacks the declared file ${relative(paths.dataDir, path)}`);
  }
 },

 async run(context) {
  if (!context.setup) throw new Error("The lead stage needs the executor's setup session and telemetry for its scouts");
  const configuration = stageConfiguration(context.input);
  const result = await runLeadSession(context.input.taskId, {
   taskConfiguration: configuration, model: context.input.model, prompts: context.prompts, report: context.report,
   signal: context.signal, seed: context.options.seed, foldPolicy: context.options.foldPolicy,
   guidance: context.input.guidance, feedback: context.feedback, setup: context.setup,
   runId: context.report.agentIdentity(1).stageInvocationId ?? undefined,
   dependencies: { scouts: productionScouts({ prompts: context.prompts, taskId: context.input.taskId, configuration, report: context.report, setup: context.setup }) },
  });
  const artifacts: StageArtifact[] = result.collection.artifacts.map(({ kind, path, bytes, sha256 }) => ({ kind, path, bytes, sha256 }));
  if (result.collection.selected) {
   const selected = result.collection.selected.artifacts.find(entry => entry.kind === "training_trial_result");
   if (selected) artifacts.push({ kind: "training_selected_result", path: selected.path, bytes: selected.bytes, sha256: selected.sha256 });
  }
  if (result.confirmation) artifacts.push(result.confirmation.artifact);
  artifacts.push(...result.refitArtifacts);
  const progress = result.progress;
  const seconds = (at?: string) => at ? Math.round((Date.parse(at) - Date.parse(progress.startedAt)) / 1000) : null;
  return {
   artifacts,
   validation: { valid: result.valid, errors: result.errors },
   attempts: progress.sessions.length,
   summary: {
    stop_reason: result.stopReason, resumed: result.resumed, task_kind: configuration.kind,
    first_trial_seconds: seconds(progress.firstTrialAt), hand_over_seconds: seconds(progress.handOver?.at),
    trials: progress.trials.length, trial_ids: progress.trials.map(trial => trial.experimentId),
    champion: progress.champion?.experimentId, hand_over: progress.handOver,
    selected_metric: primaryMetric({ configuration }, result.collection.selected?.result?.metrics as Record<string, unknown> | undefined),
    selected_selection: selectionSummary(result.collection.selected?.result),
    holdout: progress.holdout, holdout_queries: Math.max(0, ...progress.holdout.map(row => row.queryCount ?? 0)),
    budget: progress.budget, scout_calls: progress.scoutCalls, delivery: progress.delivery,
    session_error: result.sessionError, trial_validation_errors: result.collection.errors,
   },
  };
 },
};
