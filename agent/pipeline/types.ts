/**
 * Typed contract shared by every pipeline stage.
 *
 * A stage declares its options and inputs, validates them at runtime, and returns
 * artifacts plus a terminal outcome. The executor owns identity, configuration
 * snapshots, and observability; stages never record lifecycle events themselves.
 */

import type { AgentObservation, EventIdentity } from "../observability.js";
import type { PromptSnapshot } from "../prompts/loader.js";

export type StageName = "research" | "solve" | "evaluate" | "submit";

export type StageOutcome = "success" | "failure" | "cancelled";

/** A supplied input, recorded as typed metadata rather than inferred from prompts. */
export interface SuppliedInput {
	kind: string;
	version: number;
	/** How the stage receives it: in the opening prompt, as a file, or not at all. */
	delivery: "initial_prompt" | "workspace_file" | "tool" | "none";
	status: "available" | "unavailable" | "degraded";
	artifact?: string;
	content_sha256?: string;
	dataset_sha256?: string;
	[key: string]: unknown;
}

export interface StageArtifact {
	kind: string;
	path: string;
	sha256?: string;
	bytes?: number;
}

export interface StageValidation {
	valid: boolean;
	errors: string[];
}

export interface StageInput {
	taskId: string;
	/** Artifacts produced by earlier stages of the same pipeline run. */
	upstream: StageArtifact[];
	/** Model override from the caller, if any. */
	model?: string;
}

/** Everything a stage may record while it runs. */
export interface StageReporter {
	/** Record a stage-scoped event under the enclosing invocation. */
	event(eventType: string, payload: Record<string, unknown>): void;
	/** Identity for one agent attempt inside this invocation. */
	agentIdentity(attempt: number): EventIdentity;
	/** Observation handle to attach to an agent session for this attempt. */
	observation(attempt: number): AgentObservation;
	/** Declare an input that was actually supplied to the stage. */
	input(input: SuppliedInput): void;
}

export interface StageContext<Options> {
	prompts: PromptSnapshot;
	input: StageInput;
	options: Options;
	report: StageReporter;
	signal: AbortSignal;
}

export interface StageResult {
	artifacts: StageArtifact[];
	validation?: StageValidation;
	/** Agent attempts the stage needed, including repair attempts. */
	attempts?: number;
	summary?: Record<string, unknown>;
}

export interface StageDefinition<Options> {
	name: StageName;
	version: number;
	description: string;
	/** Stage that follows this one when it is enabled. */
	next?: StageName;
	/** Validate raw configuration options and apply defaults. */
	parseOptions(raw: unknown): Options;
	/** Reject inputs the stage cannot run on before any work starts. */
	checkInput(input: StageInput): void;
	run(context: StageContext<Options>): Promise<StageResult>;
}

export interface StageInvocation {
	stage: StageName;
	invocationId: string;
	stageVersion: number;
	options: unknown;
	startedAt: string;
	finishedAt: string;
	outcome: StageOutcome;
	artifacts: StageArtifact[];
	validation?: StageValidation;
	attempts: number;
	error?: string;
}

export interface PipelineRunResult {
	pipelineRunId: string;
	taskId: string;
	invocations: StageInvocation[];
	outcome: StageOutcome;
	stoppedBecause: string;
	traceDegraded: boolean;
	traceFailures: string[];
	localTracePath?: string;
}
