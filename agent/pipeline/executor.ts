import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateGuidance, type StageGuidance, type StageFeedback } from "./guidance.js";
import { InvocationFeedback, type FeedbackReceipt } from "./feedback.js";
import { SetupSession, setupChecks } from "./setup.js";
/**
 * The one execution path for pipeline stages.
 *
 * Standalone module commands, scheduled runs, and (later) a decision agent all go
 * through `invokeStage`, so every execution is enforced and observed the same way:
 * enablement and input contracts are checked here, and each invocation records its
 * start, effective options, supplied inputs, artifacts, validation, and outcome.
 */

import { listTasks, PROJECT_ROOT } from "./resolve_task.js";
import { ensureTaskData } from "../setup/task_data.js";
import { getStage } from "./registry.js";
import { loadResolvedPipelineConfig, type ResolvedPipelineConfig } from "./config.js";
import { createPipelineTrace, type PipelineTrace } from "./trace.js";
import { loadPromptSnapshot, type PromptSnapshot } from "../prompts/loader.js";
import { resolveTaskConfiguration } from "./task_configuration.js";
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
	mode?: "execute" | "reconcile";
	/** Reserved by a durable coordinator before invoking; never supplied by a model. */
	invocationId?: string;
	executionGuard?: import("../observability.js").AgentObservation["executionGuard"];
	/** Shared only within one run, to avoid repeating successful prerequisite probes. */
	setupSession?: SetupSession;
	configPath?: string;
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

export interface StageInvocationHandle {
 invocationId: string;
 result: Promise<StageInvocation>;
 state(): InvocationFeedback["state"];
 cancel(): void;
 feedback(note: StageFeedback): Promise<FeedbackReceipt>;
}
export function startStageInvocation(options: InvokeStageOptions): StageInvocationHandle {
 const invocationId = options.invocationId ?? crypto.randomUUID();
 const input = structuredClone(options.input);
 const baseReport = options.trace.stage(options.stage, invocationId);
 const report = { ...baseReport, observation: (attempt: number) => ({ ...baseReport.observation(attempt), executionGuard: options.executionGuard }) };
 let prompts: PromptSnapshot;
 try { prompts = options.prompts ?? loadPromptSnapshot(); }
 catch (error) { report.event("stage_input_rejected", { message: error instanceof Error ? error.message : String(error) }); throw error; }
 const controller = new AbortController();
 const abort = () => controller.abort();
 options.signal?.addEventListener("abort", abort, { once: true });
 if (options.signal?.aborted) abort();
 const feedback = new InvocationFeedback({ stage: options.stage, taskId: input.taskId,
  catalog: [...input.upstream, ...(input.evidenceCatalog ?? [])], prompts, report,
  journalPath: `${options.trace.localPath}.${invocationId}.feedback.jsonl` });
 controller.signal.addEventListener("abort", () => { void feedback.finish().catch(error => report.event("stage_feedback_error", { message: String(error) })); }, { once: true });
 if (controller.signal.aborted) void feedback.finish();
 const result = executeStage({ ...options, input, prompts, signal: controller.signal }, invocationId, report, feedback)
  .finally(async () => { await feedback.finish(); options.signal?.removeEventListener("abort", abort); });
 return { invocationId, result, state: () => feedback.state, cancel: abort, feedback: note => feedback.send(note) };
}
export async function invokeStage(options: InvokeStageOptions): Promise<StageInvocation> {
 return startStageInvocation(options).result;
}
async function executeStage(options: InvokeStageOptions, invocationId: string,
 report: ReturnType<PipelineTrace["stage"]>, feedback: InvocationFeedback): Promise<StageInvocation> {
	const { config, trace, input } = options;

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
		extra: { artifacts?: StageArtifact[]; validation?: StageInvocation["validation"]; error?: string; attempts?: number; summary?: Record<string, unknown> },
	): StageInvocation {
		const invocation: StageInvocation = {
			stage: options.stage,
			invocationId,
			stageVersion: stage.version,
			options: effective,
			startedAt,
			finishedAt: new Date().toISOString(),
			outcome,
			artifacts: (extra.artifacts ?? []).map(artifact => ({ ...artifact, ...(/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "") ? { provenance: { artifactId: `${invocationId}:${artifact.kind}:${createHash("sha256").update(artifact.path).update(artifact.sha256!).digest("hex")}`, taskId: input.taskId, pipelineRunId: trace.pipelineRunId, invocationId, sha256: artifact.sha256! } } : {}) })),
			validation: extra.validation,
			attempts: extra.attempts ?? 0,
			error: extra.error,
			summary: extra.summary,
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
		const prompts = options.prompts!;
		// Every stage runs under one explicit configuration; a task without a
		// declared or known default configuration cannot start a stage.
		// Reconciliation only reads durable ledgers, so it never waits for one.
		let configuration: ReturnType<typeof resolveTaskConfiguration> | undefined;
		try { configuration = resolveTaskConfiguration(input.taskId, input.taskConfiguration, config.taskConfigurations?.[input.taskId]); }
		catch (error) { if (options.mode !== "reconcile") throw error; }
		input.taskConfiguration = configuration?.configuration;
		report.input(configuration
			? { kind: "task_configuration", version: 1, delivery: "none", status: "available",
				content_sha256: configuration.sha256, source: configuration.source, task_kind: configuration.configuration.kind,
				metric: configuration.configuration.metric, execution: configuration.configuration.execution, configuration: configuration.configuration }
			: { kind: "task_configuration", version: 1, delivery: "none", status: "unavailable", reason: "reconciliation without a declared configuration" });
        if (input.guidance !== undefined) {
            input.guidance = validateGuidance(input.guidance, options.stage, input.taskId, [...input.upstream, ...(input.evidenceCatalog ?? [])]);
            const path = `${trace.localPath}.${invocationId}.guidance.json`;
            mkdirSync(dirname(path), { recursive: true });
            const snapshot = JSON.stringify({ schemaVersion: 1, pipelineRunId: trace.pipelineRunId, stageInvocationId: invocationId, note: input.guidance }, null, 2) + "\n";
            writeFileSync(path, snapshot, { flag: "wx", flush: true });
            report.input({ kind: "stage_guidance", version: 1, delivery: "initial_prompt", status: "available", artifact: path,
                content_sha256: input.guidance.contentSha256, snapshot_sha256: createHash("sha256").update(snapshot).digest("hex"), note_id: input.guidance.id, note_version: input.guidance.version,
                stage: input.guidance.stage, task_id: input.taskId, author: input.guidance.author, evidence: input.guidance.evidence });
        }
		await (options.setupSession ?? new SetupSession()).check(
			setupChecks(options.mode === "reconcile" ? stage.recoverySetupRequirements ?? [] : stage.setupRequirements ?? [], { taskId: input.taskId, taskConfiguration: input.taskConfiguration, model: input.model, configPath: options.configPath, prompts, submissionPolicy: input.submissionPolicy, refitTrainingRoot: options.stage === "refit" ? (effective as { trainingRoot?: string })?.trainingRoot : undefined }),
			options.signal ?? new AbortController().signal, report.event,
		);
		stage.checkInput(input);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		report.event("stage_input_rejected", { message });
		return finish(options.signal?.aborted ? "cancelled" : "failure", { error: message });
	}

	const controller = new AbortController();
	const abort = () => controller.abort();
	options.signal?.addEventListener("abort", abort, { once: true });
	if (options.signal?.aborted) controller.abort();

	try {
		controller.signal.throwIfAborted();
		const runner = options.mode === "reconcile" ? stage.reconcile : stage.run;
		if (!runner) throw new Error(`Stage ${options.stage} has no registered reconciliation path`);
		const result = await runner({ input, options: effective, report, feedback, signal: controller.signal,
			prompts: options.prompts! });
        if (controller.signal.aborted) return finish("cancelled", { artifacts: result.artifacts, validation: result.validation, attempts: result.attempts });
		const attempts = result.attempts ?? 0;
		if (result.summary) report.event("stage_summary", result.summary);
		if (result.validation && !result.validation.valid) {
			return finish("failure", {
				artifacts: result.artifacts,
				validation: result.validation,
				attempts,
				summary: result.summary,
				error: `artifact validation failed: ${result.validation.errors.join("; ")}`,
			});
		}
		return finish("success", { artifacts: result.artifacts, validation: result.validation, attempts, summary: result.summary });
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
	/** Verify prerequisites without executing any stage. */
	checkSetupOnly?: boolean;
 guidance?: Partial<Record<StageName, StageGuidance>>;
 /** Observe ownership of each configured invocation without adding a coordinator. */
 onInvocation?: (handle: StageInvocationHandle) => void;
 evidenceCatalog?: StageArtifact[];
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
	const requestedGuidance = structuredClone(options.guidance === undefined ? {} : options.guidance);
 const seededArtifacts = structuredClone(options.seedArtifacts ?? []);
 const evidenceCatalog = structuredClone(options.evidenceCatalog ?? []);
	const { resolved } = await loadResolvedPipelineConfig(options.configPath);
	if (resolved.settings.scheduling === "agent") {
		const { runOrchestrator } = await import("../orchestrator/run.js");
		// The generic chain API never grants uploading; autonomous CLI/API invocation
		// must explicitly choose an immutable submission policy.
		return runOrchestrator({ taskId: options.taskId, model: options.model, configPath: options.configPath, noSubmit: true, checkSetupOnly: options.checkSetupOnly, signal: options.signal, runsDir: options.runsDir });
	}
	for (const warning of resolved.warnings) console.warn(`[pipeline] ${warning}`);

	const pipelineRunId = crypto.randomUUID();
	const trace = await createPipelineTrace({
		taskId: options.taskId,
		pipelineRunId,
		runsDir: options.runsDir ?? `${PROJECT_ROOT}/runs`,
		echo: options.echoEvents,
	});

	const invocations: StageInvocation[] = [];
	const upstream: StageArtifact[] = [...seededArtifacts];
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
		if (!requestedGuidance || typeof requestedGuidance !== "object" || Array.isArray(requestedGuidance)) throw new Error("Guidance map must be an object");
        if (!Array.isArray(evidenceCatalog)) throw new Error("Evidence catalog must be an array");
        const prompts = loadPromptSnapshot();
		// One configuration for the whole chain, resolved before any setup check.
		const taskConfiguration = resolveTaskConfiguration(options.taskId, undefined, resolved.taskConfigurations[options.taskId]);
		// Only this task's data is downloaded, and only what is missing; setup then checks it.
		if (listTasks().some(task => task.taskId === options.taskId)) await ensureTaskData(options.taskId, { record: trace.event, signal: options.signal });
		trace.event("pipeline_task_configuration", { source: taskConfiguration.source, sha256: taskConfiguration.sha256, configuration: taskConfiguration.configuration });
		trace.event("pipeline_prompt_snapshot", { prompt_snapshot_sha256: prompts.fingerprint });
		const setupSession = new SetupSession();
		const planned: StageName[] = [];
		let plannedStage: StageName | undefined = options.entryStage ?? resolved.settings.entryStage;
		while (plannedStage) {
			if (plannedStage === "submit") break; // Enablement alone cannot authorize uploads.
			if (planned.includes(plannedStage)) throw new Error("Pipeline stage cycle detected during setup");
			if (!resolved.settings.stages[plannedStage]?.enabled) throw new Error(`Stage "${plannedStage}" is not enabled`);
			planned.push(plannedStage);
			if (plannedStage === options.stopAfter) break;
			const successor = getStage(plannedStage).next;
			plannedStage = successor && resolved.settings.stages[successor]?.enabled ? successor : undefined;
		}
		for (const [name, note] of Object.entries(requestedGuidance)) {
            if (!planned.includes(name as StageName)) throw new Error(`Guidance supplied for unrequested stage ${name}`);
            requestedGuidance[name as StageName] = validateGuidance(note!, name as StageName, options.taskId, [...upstream, ...evidenceCatalog]);
        }
        // Validate all effective options before the first session, including later stages.
		for (const name of planned) {
			getStage(name).parseOptions({ ...(resolved.settings.stages[name].options as Record<string, unknown> ?? {}),
				...(options.optionOverrides?.[name] as Record<string, unknown> ?? {}) });
		}
		await setupSession.check(setupChecks(planned.flatMap(name => [...(getStage(name).setupRequirements ?? [])]), {
			taskId: options.taskId, taskConfiguration: taskConfiguration.configuration, model: options.model, configPath: options.configPath, prompts,
            candidateProducedUpstream: planned.includes("solve"), refitTrainingRoot: (options.optionOverrides?.refit as { trainingRoot?: string })?.trainingRoot ?? (resolved.effectiveOptions.refit as { trainingRoot?: string })?.trainingRoot,
		}), options.signal ?? new AbortController().signal, trace.event);
		if (trace.degraded()) console.warn("[setup] Trace database unavailable; local JSONL recording remains active.");
		let next: StageName | undefined = options.checkSetupOnly ? undefined : planned[0];
		if (options.checkSetupOnly) stoppedBecause = "setup checks passed; no stages executed";
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
			const handle = startStageInvocation({
				stage: current,
				setupSession,
				configPath: options.configPath,
				prompts,
				input: { taskId: options.taskId, taskConfiguration: taskConfiguration.configuration, upstream: [...upstream], model: options.model, guidance: requestedGuidance[current], evidenceCatalog },
				config: resolved,
				trace,
				optionOverrides: options.optionOverrides?.[current],
				reason: invocations.length === 0 ? "entry_stage" : "configured_successor",
				signal: options.signal,
			});
			try { options.onInvocation?.(handle); }
            catch (error) { handle.cancel(); await handle.result; throw error; }
            const invocation = await handle.result;
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
			if (successor === "submit") { stoppedBecause = "configured chain completed; submission requires explicit autonomous run policy"; break; }
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
