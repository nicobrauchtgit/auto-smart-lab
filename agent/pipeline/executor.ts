/**
 * The one execution path for pipeline stages.
 *
 * Standalone module commands, scheduled runs, and (later) a decision agent all go
 * through `invokeStage`, so every execution is enforced and observed the same way:
 * enablement and input contracts are checked here, and each invocation records its
 * start, effective options, supplied inputs, artifacts, validation, and outcome.
 */

import { PROJECT_ROOT } from "./resolve_task.js";
import { getStage } from "./registry.js";
import { loadResolvedPipelineConfig, type ResolvedPipelineConfig } from "./config.js";
import { createPipelineTrace, type PipelineTrace } from "./trace.js";
import { loadPromptSnapshot, type PromptSnapshot } from "../prompts/loader.js";
import type {
	PipelineRunResult,
	StageArtifact,
	StageInput,
	StageInvocation,
	StageName,
	StageOutcome,
} from "./types.js";

/** Loop guard for configured scheduling; a run never chains more stages than this. */
const MAX_STAGE_INVOCATIONS = 8;

export interface InvokeStageOptions {
	prompts?: PromptSnapshot;
	stage: StageName;
	input: StageInput;
	config: ResolvedPipelineConfig;
	trace: PipelineTrace;
	/** Per-invocation option overrides, merged over the configured options. */
	optionOverrides?: unknown;
	/** Why this stage was invoked: configured scheduling, a CLI request, or an agent. */
	reason?: string;
	signal?: AbortSignal;
}

export async function invokeStage(options: InvokeStageOptions): Promise<StageInvocation> {
	const { config, trace, input } = options;
	const invocationId = crypto.randomUUID();
	const report = trace.stage(options.stage, invocationId);
	const settings = config.settings.stages[options.stage];
	if (!settings?.enabled) {
		// Availability is enforced for every caller, and the refusal is part of the
		// trace rather than an exception that leaves no record.
		const message = `Stage "${options.stage}" is not enabled in this pipeline configuration`;
		report.event("stage_rejected", { reason: "not_enabled", message, task_id: input.taskId });
		throw new Error(message);
	}
	const stage = getStage(options.stage);
	const startedAt = new Date().toISOString();
	const started = Date.now();

	const effective = options.optionOverrides === undefined
		? config.effectiveOptions[options.stage]
		: stage.parseOptions({
			...(settings.options as Record<string, unknown> ?? {}),
			...(options.optionOverrides as Record<string, unknown>),
		});

	report.event("stage_started", {
		stage_version: stage.version,
		reason: options.reason ?? "configured",
		options: effective,
		task_id: input.taskId,
		model: input.model ?? "pipeline-default",
		upstream_artifacts: input.upstream.map(({ kind, path, sha256 }) => ({ kind, path, sha256 })),
	});

	function finish(
		outcome: StageOutcome,
		extra: { artifacts?: StageArtifact[]; validation?: StageInvocation["validation"]; error?: string; attempts?: number },
	): StageInvocation {
		const invocation: StageInvocation = {
			stage: options.stage,
			invocationId,
			stageVersion: stage.version,
			options: effective,
			startedAt,
			finishedAt: new Date().toISOString(),
			outcome,
			artifacts: extra.artifacts ?? [],
			validation: extra.validation,
			attempts: extra.attempts ?? 0,
			error: extra.error,
		};
		report.event("stage_finished", {
			outcome,
			duration_ms: Date.now() - started,
			artifacts: invocation.artifacts,
			validation: invocation.validation,
			supplied_inputs: report.inputs(),
			attempts: invocation.attempts,
			...(invocation.error ? { error: invocation.error } : {}),
		});
		return invocation;
	}

	try {
		// Contract failures happen before any agent session exists, and are recorded
		// against the invocation rather than lost.
		stage.checkInput(input);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		report.event("stage_input_rejected", { message });
		return finish("failure", { error: message });
	}

	const controller = new AbortController();
	const abort = () => controller.abort();
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) controller.abort();

	try {
		const result = await stage.run({ input, options: effective, report, signal: controller.signal,
			prompts: options.prompts ?? loadPromptSnapshot() });
		const attempts = result.attempts ?? 0;
		if (result.summary) report.event("stage_summary", result.summary);
		if (result.validation && !result.validation.valid) {
			return finish("failure", {
				artifacts: result.artifacts,
				validation: result.validation,
				attempts,
				error: `artifact validation failed: ${result.validation.errors.join("; ")}`,
			});
		}
		return finish("success", { artifacts: result.artifacts, validation: result.validation, attempts });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const outcome: StageOutcome = controller.signal.aborted ? "cancelled" : "failure";
		report.event("stage_error", { outcome, message });
		return finish(outcome, { error: message });
	} finally {
		options.signal?.removeEventListener("abort", abort);
	}
}

export interface RunPipelineOptions {
	taskId: string;
	model?: string;
	configPath?: string;
	/** Start somewhere other than the configured entry stage. */
	entryStage?: StageName;
	/** Stop after this stage even if the next one is enabled. */
	stopAfter?: StageName;
	/** Option overrides per stage, applied over the configured options. */
	optionOverrides?: Partial<Record<StageName, unknown>>;
	signal?: AbortSignal;
	/** Print each recorded event to stdout. */
	echoEvents?: boolean;
	/** Extra metadata recorded with the run, such as the CLI invocation. */
	invokedBy?: Record<string, unknown>;
	/**
	 * Artifacts from earlier runs, supplied when entering the chain part-way.
	 * They are recorded as seeded rather than presented as this run's output, so a
	 * trace never implies a stage executed when it did not.
	 */
	seedArtifacts?: StageArtifact[];
	/** Root for the local trace mirror. Defaults to the project `runs/` directory. */
	runsDir?: string;
}

/**
 * Run configured stages for one task, starting at the entry stage and following
 * each stage's successor while it stays enabled.
 */
export async function runPipeline(options: RunPipelineOptions): Promise<PipelineRunResult> {
	const { resolved } = await loadResolvedPipelineConfig(options.configPath);
	for (const warning of resolved.warnings) console.warn(`[pipeline] ${warning}`);

	const pipelineRunId = crypto.randomUUID();
	const trace = await createPipelineTrace({
		taskId: options.taskId,
		pipelineRunId,
		runsDir: options.runsDir ?? `${PROJECT_ROOT}/runs`,
		echo: options.echoEvents,
	});

	const invocations: StageInvocation[] = [];
	const upstream: StageArtifact[] = [...(options.seedArtifacts ?? [])];
	let outcome: StageOutcome = "success";
	let stoppedBecause = "";

	trace.event("pipeline_run_start", {
		task_id: options.taskId,
		entry_stage: options.entryStage ?? resolved.settings.entryStage,
		enabled_stages: resolved.enabledStages,
		scheduling: resolved.settings.scheduling,
		model: options.model ?? "pipeline-default",
		config_fingerprint: resolved.fingerprint,
		config_snapshot: resolved.snapshot,
		invoked_by: options.invokedBy ?? { kind: "api" },
		seeded_artifacts: upstream.map(({ kind, path, sha256 }) => ({ kind, path, sha256 })),
	});

	try {
		const prompts = loadPromptSnapshot();
		trace.event("pipeline_prompt_snapshot", { prompt_snapshot_sha256: prompts.fingerprint });
		let next: StageName | undefined = options.entryStage ?? resolved.settings.entryStage;
		while (next) {
			if (options.signal?.aborted) {
				outcome = "cancelled";
				stoppedBecause = "cancelled before the next stage started";
				break;
			}
			if (invocations.length >= MAX_STAGE_INVOCATIONS) {
				stoppedBecause = `stage budget of ${MAX_STAGE_INVOCATIONS} invocations reached`;
				outcome = "failure";
				break;
			}
			const current: StageName = next;
			const invocation = await invokeStage({
				stage: current,
				prompts,
				input: { taskId: options.taskId, upstream: [...upstream], model: options.model },
				config: resolved,
				trace,
				optionOverrides: options.optionOverrides?.[current],
				reason: invocations.length === 0 ? "entry_stage" : "configured_successor",
				signal: options.signal,
			});
			invocations.push(invocation);
			upstream.push(...invocation.artifacts);

			if (invocation.outcome !== "success") {
				outcome = invocation.outcome;
				stoppedBecause = `${current} ended with ${invocation.outcome}`;
				break;
			}
			if (options.stopAfter === current) {
				stoppedBecause = `stopped after ${current} as requested`;
				break;
			}
			const successor = getStage(current).next;
			if (!successor) {
				stoppedBecause = `${current} is the last stage in the chain`;
				break;
			}
			if (!resolved.settings.stages[successor]?.enabled) {
				stoppedBecause = `${current} finished; next stage "${successor}" is not enabled`;
				break;
			}
			next = successor;
		}
	} catch (error) {
		// The terminal event must describe what actually happened, including a
		// failure raised before or between stages.
		outcome = options.signal?.aborted ? "cancelled" : "failure";
		stoppedBecause = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		trace.event("pipeline_run_end", {
			outcome,
			stopped_because: stoppedBecause,
			invocations: invocations.map(({ stage, invocationId, outcome: stageOutcome, attempts }) => ({
				stage, invocation_id: invocationId, outcome: stageOutcome, attempts,
			})),
			trace_degraded: trace.degraded(),
			trace_failures: trace.failures(),
		});
		await trace.close();
	}

	return {
		pipelineRunId,
		taskId: options.taskId,
		invocations,
		outcome,
		stoppedBecause,
		traceDegraded: trace.degraded(),
		traceFailures: trace.failures(),
		localTracePath: trace.localPath,
	};
}
