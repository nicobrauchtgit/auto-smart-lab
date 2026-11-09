/**
 * Registry of implemented pipeline stages.
 *
 * Configuration enables registered capabilities; it cannot make an unimplemented
 * stage available. A stage joins this registry once it meets the module completion
 * criteria in docs/pipeline-integration.md.
 */

import { refitStage } from "./stages/refit.js";
import { submitStage } from "./stages/submit.js";
import { evaluateStage } from "./stages/evaluate.js";
import { researchStage } from "./stages/research.js";
import { solveStage } from "./stages/solve.js";
import type { StageDefinition, StageName } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- stage options are per-stage types
export const STAGE_REGISTRY: Partial<Record<StageName, StageDefinition<any>>> = {
	submit: submitStage,
	research: researchStage,
	refit: refitStage,
	evaluate: evaluateStage,
	solve: solveStage,
};

export const KNOWN_STAGES: StageName[] = ["research", "solve", "evaluate", "refit", "submit"];

export function getStage(name: StageName): StageDefinition<unknown> {
	const stage = STAGE_REGISTRY[name];
	if (!stage) throw new Error(`Stage "${name}" is not implemented`);
	return stage as StageDefinition<unknown>;
}

export function isImplemented(name: string): name is StageName {
	return name in STAGE_REGISTRY;
}
