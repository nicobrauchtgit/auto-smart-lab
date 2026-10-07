import { guidanceBlock, type StageGuidance } from "../pipeline/guidance.js";
import { renderStartupContextPrompt, type StartupProfile } from "../research/startup_context.js";
import type { PromptSnapshot } from "./loader.js";

/** Document existence and initial validation do not select the opening task. */
export function prepareResearchPrompts(
	prompts: PromptSnapshot,
	input: { guidance?: StageGuidance; taskId: string; contextHash: string; profile?: StartupProfile; failedChecks?: string[] },
) {
	const guidance = guidanceBlock(prompts, input.guidance);
	const system = prompts.render("research.system", {});
	const testDistribution = prompts.render("research.test-distribution", {});
	const profile = renderStartupContextPrompt(input.profile, prompts);
	const start = prompts.render("research.start", {
		taskId: input.taskId,
		contextHash: input.contextHash,
		startupContext: profile?.text ?? "",
        guidance: guidance?.text ?? "",
	});
	const feedback = input.failedChecks?.length
		? prompts.render("research.validation-feedback", { errors: input.failedChecks.map(error => `- ${error}`).join("\n") })
		: undefined;
	return {
		system,
		prompt: [start.text, testDistribution.text, feedback?.text].filter(Boolean).join("\n\n"),
		promptReferences: [system, profile, start, testDistribution, guidance, feedback].flatMap(part => part ? [part.reference] : []),
	};
}
