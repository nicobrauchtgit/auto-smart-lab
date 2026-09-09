#!/usr/bin/env bun

import { buildResearchContext, researchContextHash } from "./research/context.js";
import { loadPromptSnapshot } from "./prompts/loader.js";
import { prepareResearchPrompts } from "./prompts/research.js";

function usage(): never {
	console.error("Usage: npm run research -- <task_id> [--model <provider/model>] [--no-startup-context] [--preview-context]");
	process.exit(1);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	function takeFlag(flag: string): boolean {
		const index = args.indexOf(flag);
		if (index < 0) return false;
		args.splice(index, 1);
		return true;
	}
	const injectStartupContext = !takeFlag("--no-startup-context");
	const preview = takeFlag("--preview-context");
	const modelIndex = args.indexOf("--model");
	let model: string | undefined;
	if (modelIndex >= 0) {
		model = args[modelIndex + 1];
		if (!model) usage();
		args.splice(modelIndex, 2);
	}
	const taskId = args[0];
	if (!taskId || args.length !== 1) usage();

	if (preview) {
		const { context } = buildResearchContext(taskId);
		console.log(prepareResearchPrompts(loadPromptSnapshot(), {
			taskId, contextHash: researchContextHash(context),
			profile: injectStartupContext ? context.startup_profile : undefined,
		}).prompt);
		return;
	}
	// Standalone research runs through the pipeline executor, so it is observed
	// exactly like a scheduled run.
	const { runResearchStage } = await import("./pipeline/run_research.js");
	const result = await runResearchStage({
		taskId,
		model,
		injectStartupContext,
		invokedBy: { kind: "cli", command: "research" },
	});
	if (result.outcome !== "success") {
		console.error(`[research] Failed: ${result.error ?? result.stoppedBecause}`);
		process.exitCode = 1;
		return;
	}
	console.log(`[research] Complete: ${result.documentPath}`);
	console.log(`[research] Pipeline run: ${result.pipelineRunId}`);
}

main().catch((error) => {
	console.error("[research] Fatal error:", error);
	process.exit(1);
});
