/** Stable prompt IDs and their required string inputs. Prose belongs in files. */
export const PROMPTS = {
	"subagents.parent": { file: "subagents/parent.md", variables: [] },
	"subagents.smoke-start": { file: "subagents/smoke-start.md", variables: ["workspace"] },
	"subagents.smoke-task": { file: "subagents/smoke-task.md", variables: ["python"] },
	"subagents.child": { file: "subagents/child.md", variables: [] },
	"subagents.start": { file: "subagents/start.md", variables: ["task"] },
	"subagents.followup": { file: "subagents/followup.md", variables: ["message"] },
	"subagents.spawn-tool": { file: "subagents/spawn-tool.md", variables: [] },
	"subagents.check-tool": { file: "subagents/check-tool.md", variables: [] },
	"subagents.wait-tool": { file: "subagents/wait-tool.md", variables: [] },
	"subagents.followup-tool": { file: "subagents/followup-tool.md", variables: [] },
	"subagents.cancel-tool": { file: "subagents/cancel-tool.md", variables: [] },
	"subagents.list-tool": { file: "subagents/list-tool.md", variables: [] },
	"experiments.start-tool": { file: "experiments/start-tool.md", variables: [] },
	"experiments.status-tool": { file: "experiments/status-tool.md", variables: [] },
	"experiments.output-tool": { file: "experiments/output-tool.md", variables: [] },
	"experiments.stop-tool": { file: "experiments/stop-tool.md", variables: [] },
	"shared.python-environment": { file: "shared/python-environment.md", variables: ["pythonExecutable", "declaredDependencies", "totalDistributions", "environmentHash", "projectPath", "lockPath", "notesPath", "pythonCommand", "managerCommand"] },
	"research.system": { file: "research/system.md", variables: [] },
	"research.start": { file: "research/start.md", variables: ["taskId", "contextHash", "startupContext"] },
	"research.validation-feedback": { file: "research/validation-feedback.md", variables: ["errors"] },
	"research.startup-context": { file: "research/startup-context.md", variables: ["facts"] },
	"research.launch": { file: "research/launch.md", variables: ["request", "taskId", "contextHash", "startupContext"] },
	"research.initial-document": { file: "research/initial-document.md", variables: ["title", "taskId", "contextHash"] },
	"solve.system": { file: "solve/system.md", variables: ["taskId"] },
	"solve.start": { file: "solve/start.md", variables: ["taskId", "workspace", "datasetPaths", "labelsPath", "rowCount", "classBalance", "foldRecommendation", "researchState", "maxIterations"] },
	"solve.iteration": { file: "solve/iteration.md", variables: ["signal", "guidance"] },
	"solve.observable-fits": { file: "solve/observable-fits.md", variables: [] },
	// The `solver.*` prompts below drive the pre-executor orchestrate.ts path and
	// are kept unchanged until it is retired.
	"solver.system": { file: "solver/system.md", variables: [] },
	"solver.start": { file: "solver/start.md", variables: ["taskId", "researchState"] },
	"solver.retry": { file: "solver/retry.md", variables: ["taskId", "feedback", "researchState"] },
	"evaluation.system": { file: "evaluation/system.md", variables: [] },
	"evaluation.start": { file: "evaluation/start.md", variables: ["taskId"] },
	"submission.system": { file: "submission/system.md", variables: [] },
} as const;

export type PromptId = keyof typeof PROMPTS;
type VariableName<Id extends PromptId> = (typeof PROMPTS)[Id]["variables"][number];
export type PromptVariables<Id extends PromptId> = [VariableName<Id>] extends [never]
	? Record<string, never>
	: Record<VariableName<Id>, string>;
