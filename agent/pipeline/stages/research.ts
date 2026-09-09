/**
 * Research stage: produce a validated research.md for a task.
 *
 * The stage owns its artifact contract. Agent attempts, supplied inputs, and
 * validation results are reported through the stage reporter, so a research run
 * that needs a repair attempt stays visible as one invocation.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

import { runResearchSession } from "../../run/research_session.js";
import { resolveTask } from "../resolve_task.js";
import type { StageDefinition, StageArtifact } from "../types.js";

export interface ResearchOptions {
	/** Put the compact training-label profile into the opening prompt. */
	injectStartupContext: boolean;
}

function artifact(kind: string, path: string): StageArtifact | undefined {
	if (!existsSync(path)) return undefined;
	const content = readFileSync(path);
	return {
		kind,
		path,
		bytes: statSync(path).size,
		sha256: createHash("sha256").update(content).digest("hex"),
	};
}

export const researchStage: StageDefinition<ResearchOptions> = {
	name: "research",
	version: 1,
	description: "Grounded research for a task, ending in a validated research.md",
	next: "solve",

	parseOptions(raw) {
		if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
			throw new Error("research options must be an object");
		}
		const options = (raw ?? {}) as Record<string, unknown>;
		const known = new Set(["injectStartupContext"]);
		const unknown = Object.keys(options).filter((key) => !known.has(key));
		if (unknown.length > 0) throw new Error(`unknown research options: ${unknown.join(", ")}`);
		const injectStartupContext = options.injectStartupContext ?? true;
		if (typeof injectStartupContext !== "boolean") {
			throw new Error("research.injectStartupContext must be a boolean");
		}
		return { injectStartupContext };
	},

	checkInput(input) {
		const task = resolveTask({ taskId: input.taskId });
		if (!task.hasData) {
			throw new Error(`Task ${task.taskId} has no local dataset; run \`npm run fetch-unit -- ${task.unitSlug}\``);
		}
	},

	async run(context) {
		const result = await runResearchSession(context.input.taskId, context.input.model, {
			injectStartupContext: context.options.injectStartupContext,
			prompts: context.prompts,
			report: context.report,
			signal: context.signal,
		});
		const artifacts = [
			artifact("research_document", result.documentPath),
			artifact("research_context", result.contextPath),
		].filter((entry): entry is StageArtifact => entry !== undefined);
		return {
			artifacts,
			validation: { valid: result.valid, errors: result.errors },
			attempts: result.attempts,
			summary: {
				attempts: result.attempts,
				context_sha256: result.contextSha256,
				dataset_sha256: result.datasetSha256,
			},
		};
	},
};
