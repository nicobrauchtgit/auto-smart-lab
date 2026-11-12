import { guidanceBlock, type StageGuidance } from '../pipeline/guidance.js';
import type { TaskConfiguration } from '../pipeline/task_configuration.js';
import type { PromptSnapshot, RenderedPrompt } from './loader.js';
/** The task contract for the configured kind: input frame, harness calls and scoring. */
export function taskContract(prompts: PromptSnapshot, taskId: string, configuration: TaskConfiguration, evidencePath: string): RenderedPrompt[] {
 const contract = configuration.kind === "binary_classification"
  ? prompts.render("team.lead-task-binary_classification", { taskId })
  : configuration.kind === "clustering"
   ? prompts.render("team.lead-task-clustering", { taskId, execution: configuration.execution })
   : prompts.render("team.lead-task-anomaly_detection", { taskId, execution: configuration.execution,
    scoreMethod: configuration.anomaly!.scoreMethod, scoreDirection: configuration.anomaly!.scoreDirection.replaceAll("_", " "),
    anomalyLabel: String(configuration.anomaly!.anomalyLabel) });
 if (configuration.selection) return [contract, prompts.render("team.lead-evidence-selection", { evidencePath, metric: configuration.selection.metric })];
 return configuration.metric === "none" ? [contract, prompts.render("team.lead-label-free", {})] : [contract];
}


export function prepareLeadPrompts(prompts: PromptSnapshot, input: {
 taskId: string; configuration: TaskConfiguration; workspace: string; evidencePath?: string; datasetPaths: string[];
 targets: string; rowCount: number; targetSummary: string; foldRecommendation: string; maxIterations?: number;
 task?: string; resources?: string; followUp?: string; resume?: string; budget?: number; guidance?: StageGuidance;
}) {
 const system = prompts.render('team.lead-system', { taskId: input.taskId, budget: String(input.budget ?? 80) });
 const contract = taskContract(prompts, input.taskId, input.configuration, input.evidencePath ?? `${input.workspace}/evidence.json`);
 const guidance = guidanceBlock(prompts, input.guidance);
 const start = prompts.render('team.lead-start', {
  task: input.task ?? input.taskId, workspace: input.workspace, datasetPaths: input.datasetPaths.join('\n'), targets: input.targets,
  rowCount: String(input.rowCount), targetSummary: input.targetSummary, foldRecommendation: input.foldRecommendation,
  taskContract: contract.map(p => p.text).join('\n\n'), resources: input.resources ?? '', followUp: input.followUp ?? '', resume: input.resume ?? '', guidance: guidance?.text ?? '',
 });
 return { system, prompt: start.text, promptReferences: [system.reference, start.reference, ...contract.map(p=>p.reference), ...(guidance ? [guidance.reference] : [])] };
}
