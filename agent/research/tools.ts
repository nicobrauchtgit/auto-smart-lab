/** The research agent's self-check: the controller's own brief validator, run on demand. */
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import type { PromptSnapshot } from "../prompts/loader.js";
import type { ResearchContext } from "./context.js";
import { validateResearchFile } from "./validate.js";

export function createBriefTools(options: {
	documentPath: string;
	context: ResearchContext;
	prompts: PromptSnapshot;
	/** Records each self-check result under the stage invocation. */
	onCheck?: (result: { valid: boolean; errors: string[] }) => void;
}) {
	return [
		defineTool({
			name: "check_brief", label: "Check brief",
			description: options.prompts.render("research.check-brief-tool", {}).text,
			parameters: Type.Object({}),
			async execute() {
				const result = validateResearchFile(options.documentPath, options.context);
				options.onCheck?.(result);
				return { content: [{ type: "text" as const, text: JSON.stringify(result.valid ? { valid: true } : result) }], details: {} };
			},
		}),
	];
}
