/** Stable prompt IDs and their required string inputs. Prose belongs in files. */
export const PROMPTS = {
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
