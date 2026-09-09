import { renderStartupContextPrompt, type StartupProfile } from "../research/startup_context.js";
import type { PromptSnapshot } from "./loader.js";

/** Document existence and initial validation do not select the opening task. */
export function prepareResearchPrompts(
	prompts: PromptSnapshot,
	input: { taskId: string; contextHash: string; profile?: StartupProfile; failedChecks?: string[] },
) {
	const system = prompts.render("research.system", {});
	const profile = renderStartupContextPrompt(input.profile, prompts);
	const start = prompts.render("research.start", {
		taskId: input.taskId,
		contextHash: input.contextHash,
		startupContext: profile?.text ?? "",
	});
	const feedback = input.failedChecks?.length
		? prompts.render("research.validation-feedback", { errors: input.failedChecks.map(error => `- ${error}`).join("\n") })
		: undefined;
	return {
		system,
		prompt: [start.text, feedback?.text].filter(Boolean).join("\n\n"),
		promptReferences: [system, profile, start, feedback].flatMap(part => part ? [part.reference] : []),
	};
}
