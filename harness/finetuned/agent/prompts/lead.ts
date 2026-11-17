import { guidanceBlock, type StageGuidance } from '../pipeline/guidance.js';
import type { TaskConfiguration } from '../pipeline/task_configuration.js';
import type { PromptSnapshot, RenderedPrompt } from './loader.js';
import { HARNESS_CONFIG } from '../harness/config.js';
/** The task contract for the configured kind: input frame, harness calls and scoring. */
export function taskContract(prompts: PromptSnapshot, taskId: string, configuration: TaskConfiguration, evidencePath: string): RenderedPrompt[] {
 const contract = configuration.kind === "binary_classification"
  ? prompts.render("team.lead-task-binary_classification", { taskId })
  : configuration.kind === "multiclass_classification" ? prompts.render("team.lead-task-multiclass_classification", { taskId })
  : configuration.kind === "clustering"
   ? prompts.render("team.lead-task-clustering", { taskId, execution: configuration.execution, splitGuidance: configuration.holdout === "none" ? "" : prompts.render(configuration.holdout === "group" ? "team.lead-split-group" : "team.lead-split-stratified", {}).text })
   : prompts.render("team.lead-task-anomaly_detection", { taskId, execution: configuration.execution,
    scoreMethod: configuration.anomaly!.scoreMethod, scoreDirection: configuration.anomaly!.scoreDirection.replaceAll("_", " "),
    decisionContract: configuration.anomaly!.anomalyLabel === 1 ? prompts.render("team.lead-anomaly-binary", {}).text : prompts.render("team.lead-anomaly-label", { anomalyLabel: String(configuration.anomaly!.anomalyLabel) }).text });
 const contracts = [contract, ...(configuration.kind === "clustering" && configuration.execution === "batch" ? [prompts.render("team.lead-task-clustering-batch", {})] : [])];
 if (configuration.selection) return [...contracts, prompts.render("team.lead-evidence-selection", { evidencePath, metric: configuration.selection.metric })];
 return configuration.metric === "none" ? [...contracts, prompts.render("team.lead-label-free", {})] : contracts;
}


export function prepareLeadPrompts(prompts: PromptSnapshot, input: {
 taskId: string; configuration: TaskConfiguration; workspace: string; evidencePath?: string; datasetPaths: string[];
 targets: string; rowCount: number; targetSummary: string; foldRecommendation: string; maxIterations?: number;
 task?: string; resources?: string; followUp?: string; resume?: string; budget?: number; guidance?: StageGuidance;
}) {
 const system = prompts.render('team.lead-system', { taskId: input.taskId, budget: String(input.budget ?? HARNESS_CONFIG.team.lead.maxToolCalls), confirmationFeedback: prompts.render(input.configuration.kind === 'binary_classification' ? 'team.lead-confirmation-binary' : 'team.lead-confirmation-other', {}).text });
 const contract = taskContract(prompts, input.taskId, input.configuration, input.evidencePath ?? `${input.workspace}/evidence.json`);
 const guidance = guidanceBlock(prompts, input.guidance);
 const start = prompts.render('team.lead-start', {
  task: input.task ?? input.taskId, workspace: input.workspace, datasetPaths: input.datasetPaths.join('\n'), targets: input.targets,
  rowCount: String(input.rowCount), targetSummary: input.targetSummary, foldRecommendation: input.foldRecommendation,
  taskContract: contract.map(p => p.text).join('\n\n'), resources: input.resources ?? '', followUp: input.followUp ?? '', resume: input.resume ?? '', guidance: guidance?.text ?? '',
 });
 return { system, prompt: start.text, promptReferences: [system.reference, start.reference, ...contract.map(p=>p.reference), ...(guidance ? [guidance.reference] : [])] };
}
