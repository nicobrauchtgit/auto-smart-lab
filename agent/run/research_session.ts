import type { StageGuidance } from "../pipeline/guidance.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";
import type { InvocationFeedback } from "../pipeline/feedback.js";
import { HARNESS_CONFIG } from "../harness/config.js";
import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildResearchContext,
	findTask,
	PROJECT_ROOT,
	researchContextHash,
	writeResearchContext,
} from "../research/context.js";
import { validateResearchFile, WEB_SOURCES_LOG } from "../research/validate.js";
import { createBriefTools } from "../research/tools.js";
import { ResearchBudget } from "../research/budget.js";
import { buildDataProfile } from "../research/profile.js";
import { loadPromptSnapshot, type PromptSnapshot } from "../prompts/loader.js";
import { prepareResearchPrompts } from "../prompts/research.js";
import type { StageReporter } from "../pipeline/types.js";
import { readPythonEnvironment } from "./python_environment.js";
import { runSession } from "./session_runner.js";
import { isolatedSolveTools, prepareResearchSandbox, solvePythonEnvironmentTool } from "./solve_sandbox.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, "..");
const WEB_SEARCH_EXTENSION = join(AGENT_DIR, "tools", "web_search.ts");

export interface ResearchResult {
	documentPath: string;
	contextPath: string;
	valid: boolean;
	errors: string[];
	/** The brief has known gaps but is handed on: research never fails the run for running out of budget. */
	partial: boolean;
	budget: { used: number; limit: number; phase: string };
	attempts: number;
	contextSha256: string;
	datasetSha256: string;
}

export interface RunResearchOptions {
 /** Declares the targets and metric the startup profile describes. */
 taskConfiguration?: TaskConfiguration;
 guidance?: StageGuidance;
 feedback?: InvocationFeedback;
	injectStartupContext?: boolean;
	prompts?: PromptSnapshot;
	/**
	 * Stage reporter supplied by the pipeline executor. When present, each agent
	 * attempt, its supplied inputs, and every validation result are recorded under
	 * the enclosing stage invocation. Standalone runs simply omit it.
	 */
	report?: StageReporter;
	/** Abort the running agent session and stop before the next attempt. */
	signal?: AbortSignal;
}

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function traceRun(
	tracePath: string,
	entry: Record<string, unknown>,
): void {
	appendFileSync(tracePath, `${JSON.stringify(entry)}\n`);
}

export async function runResearchSession(taskId: string, model?: string, options: RunResearchOptions = {}): Promise<ResearchResult> {
	const injectStartupContext = options.injectStartupContext ?? HARNESS_CONFIG.research.injectStartupContext;
	const report = options.report;
	const prompts = options.prompts ?? loadPromptSnapshot();
	const { context, prompt } = buildResearchContext(taskId, options.taskConfiguration);
	const workspace = join(PROJECT_ROOT, "runs", taskId, "research");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(join(workspace, "analysis"), { recursive: true });

	// The harness profiles the declared data before the agent starts, so the
	// agent does not rewrite the same survey. A failed profile is reported, not fatal.
	const profile = buildDataProfile({ taskId, configuration: options.taskConfiguration, workspace,
		datasetSnapshotSha256: context.dataset.snapshot_sha256 });
	context.data_profile = { status: profile.status, ...(profile.path ? { path: profile.path, sha256: profile.sha256, layers: profile.layers } : { reason: profile.reason }) };

	// The manifest is regenerated on every invocation. It identifies inputs but
	// includes a small labels-file profile, with no research conclusions.
	const contextPath = writeResearchContext(taskId, context);
	const taskPath = join(workspace, "task.md");
	writeFileSync(taskPath, prompt.endsWith("\n") ? prompt : `${prompt}\n`);

	const documentPath = join(workspace, "research.md");
	if (!existsSync(documentPath)) {
		writeFileSync(documentPath, `${prompts.render("research.initial-document", {
			title: context.task.title, taskId, contextHash: researchContextHash(context),
		}).text}\n`);
	}
	const before = readFileSync(documentPath, "utf8");
	const contextJson = readFileSync(contextPath, "utf8");
	const startedAt = new Date().toISOString();

	console.log(`[research] Workspace: ${workspace}`);
	console.log(`[research] Fresh context: ${contextPath}`);

	const contextSha256 = sha256(contextJson);
	report?.input({
		kind: "task_prompt",
		version: 1,
		delivery: "workspace_file",
		status: "available",
		artifact: taskPath,
		content_sha256: sha256(prompt),
	});
	report?.input({
		kind: "research_context",
		version: context.schema_version,
		delivery: "workspace_file",
		status: "available",
		artifact: contextPath,
		content_sha256: contextSha256,
		dataset_sha256: context.dataset.snapshot_sha256,
	});
	for (const [split, source] of Object.entries(context.dataset.research_inputs ?? {})) {
		report?.input({ kind: `research_${split}`, version: 1, delivery: source ? "workspace_file" : "none",
			status: source ? "available" : "unavailable", ...(source ? { artifact: resolve(workspace, source.path), content_sha256: source.sha256 } : {}),
			dataset_sha256: context.dataset.snapshot_sha256, labels_available: split === "training_labels",
		});
	}
	report?.input({
		kind: "data_profile", version: 1,
		delivery: profile.status === "available" ? "workspace_file" : "none",
		status: profile.status,
		...(profile.path ? { artifact: resolve(workspace, profile.path), content_sha256: profile.sha256 } : {}),
		dataset_sha256: context.dataset.snapshot_sha256,
	});
	report?.event("data_profile_built", {
		status: profile.status, records: profile.records, layers: profile.layers,
		duration_ms: profile.duration_ms, ...(profile.reason ? { reason: profile.reason } : {}),
	});
	if (profile.status !== "available") console.warn(`[research] Data profile unavailable: ${profile.reason}`);
	// The requested injection setting and the profile's actual availability are
	// recorded separately: enabling injection does not prove context was supplied.
	report?.input({
		kind: "startup_profile",
		version: 1,
		delivery: injectStartupContext ? "initial_prompt" : "none",
		status: context.startup_profile ? (context.startup_profile.status === "available" ? "available" : "degraded") : "unavailable",
		requested: injectStartupContext,
		profile_status: context.startup_profile?.status ?? "unavailable",
	});
	report?.event("research_context_prepared", {
		workspace,
		context_sha256: contextSha256,
		dataset_sha256: context.dataset.snapshot_sha256,
		dataset_files: context.dataset.total_files,
		web_search_calls: context.limits.web_search_calls,
	});

	let validation = validateResearchFile(documentPath, context);
	report?.event("artifact_validation", {
		phase: "before",
		attempt: 0,
		valid: validation.valid,
		errors: validation.errors,
		artifact: documentPath,
	});
	let attempts = 0;
	let sessionOutput = "";
	let sessionError: unknown;
	let sessionWarning: string | undefined;
	// One action budget spans the initial and any repair attempt.
	const budget = new ResearchBudget(prompts, HARNESS_CONFIG.research, (type, payload) => report?.event(type, payload));
	try {
		while (attempts < HARNESS_CONFIG.research.maxAttempts) {
			if (options.signal?.aborted) break;
			attempts++;
			if (attempts > 1) budget.startRepair();
			const prepared = prepareResearchPrompts(prompts, {
				taskId, contextHash: contextSha256, guidance: options.guidance,
				profile: injectStartupContext ? context.startup_profile : undefined,
				failedChecks: attempts > 1 ? validation.errors : undefined,
			});
			const attemptStartedAt = new Date().toISOString();
			report?.event("agent_attempt_start", {
				attempt: attempts,
				reason: attempts === 1 ? "initial" : "validation_repair",
				model: model ?? "pipeline-default",
				web_search_calls: attempts === 1 ? context.limits.web_search_calls : 0,
				prompt_snapshot_sha256: prompts.fingerprint,
				prompts: prepared.promptReferences,
			});
			const python = readPythonEnvironment();
			const identity = report?.agentIdentity(attempts);
			const { output, agentRunId } = await runSession({
				knowledge: { root: join(PROJECT_ROOT, "knowledge"), origin: { taskId, datasetSha256: context.dataset.snapshot_sha256,
					pipelineRunId: report?.agentIdentity(attempts).pipelineRunId ?? undefined, stageInvocationId: report?.agentIdentity(attempts).stageInvocationId ?? undefined } },
				...prepared,
				prompts,
				feedback: options.feedback,
				reportInput: report ? input => report.input(input) : undefined,
				model,
				env: { WEB_SEARCH_MAX_CALLS: attempts === 1 ? String(context.limits.web_search_calls) : "0", WEB_SEARCH_MAX_RESULTS: String(HARNESS_CONFIG.research.webSearchResults),
					WEB_SEARCH_LOG: join(workspace, WEB_SOURCES_LOG) },
				cwd: workspace,
				tools: ["web_search"],
				customTools: [
					...isolatedSolveTools(prepareResearchSandbox(workspace, findTask(taskId).dir, python)),
					solvePythonEnvironmentTool(python, prompts.render("solve.python-environment-tool", {}).text, PROJECT_ROOT, {
						pipelineRunId: identity?.pipelineRunId ?? "research", stageInvocationId: identity?.stageInvocationId ?? "research", attempt: attempts }),
					...createBriefTools({ documentPath, context, prompts,
						onCheck: result => report?.event("brief_self_check", { attempt: attempts, valid: result.valid, errors: result.errors.length }) }),
				],
				extensionPaths: [WEB_SEARCH_EXTENSION],
				extensionFactories: [budget.extension()],
				...(options.signal ? { signal: options.signal } : {}),
				...(report ? { observe: report.observation(attempts) } : {}),
			});
			sessionOutput = output;
			report?.event("agent_attempt_end", {
				attempt: attempts,
				agent_run_id: agentRunId,
				started_at: attemptStartedAt,
				output_received: output.trim().length > 0,
			});
			validation = validateResearchFile(documentPath, context);
			// Session completion is not stage success: the artifact is validated
			// separately and can send the stage into another attempt.
			report?.event("artifact_validation", {
				phase: "after_attempt",
				attempt: attempts,
				valid: validation.valid,
				errors: validation.errors,
				artifact: documentPath,
			});
			if (validation.valid) break;
			console.warn(`[research] Validation failed after attempt ${attempts}: ${validation.errors.join("; ")}`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// A weaker model can successfully write the artifact and then emit a malformed
		// final tool call. The validated filesystem document is authoritative, but only
		// when this run actually wrote it: a session that fails before touching the
		// workspace must not inherit the success of an earlier run.
		validation = validateResearchFile(documentPath, context);
		const documentWritten = existsSync(documentPath) && sha256(readFileSync(documentPath, "utf8")) !== sha256(before);
		report?.event("agent_attempt_error", {
			attempt: attempts,
			message,
			document_valid: validation.valid,
			document_written: documentWritten,
		});
		if (validation.valid && documentWritten) sessionWarning = `model ended with an error after writing a valid document: ${message}`;
		else {
			sessionError = error;
			validation = { valid: false, errors: [...validation.errors, `session error: ${message}`] };
		}
	}

	const after = existsSync(documentPath) ? readFileSync(documentPath, "utf8") : "";
	traceRun(join(workspace, "runs.jsonl"), {
		started_at: startedAt,
		finished_at: new Date().toISOString(),
		task_id: taskId,
		startup_context_injected: injectStartupContext,
		startup_profile_status: context.startup_profile?.status ?? "unavailable",
		prompt_snapshot_sha256: prompts.fingerprint,
		model: model ?? "pipeline-default",
		attempts,
		context_sha256: contextSha256,
		dataset_snapshot_sha256: context.dataset.snapshot_sha256,
		document_before_sha256: sha256(before),
		document_after_sha256: sha256(after),
		model_output_received: sessionOutput.trim().length > 0,
		valid: validation.valid,
		validation_errors: validation.errors,
		budget_used: budget.used,
		...(sessionWarning ? { session_warning: sessionWarning } : {}),
	});

	const documentChanged = sha256(before) !== sha256(after);
	// Research fails the run only when the session broke before doing anything:
	// then there is nothing to hand on. A budget that ran out, a stalled model or
	// remaining validation errors give a partial brief, and solve continues.
	const progressed = documentChanged || budget.used > 0;
	const partial = !validation.valid && !options.signal?.aborted && (!sessionError || progressed);
	report?.event("research_finished", {
		attempts,
		valid: validation.valid,
		partial,
		errors: validation.errors,
		document_changed: documentChanged,
		budget_used: budget.used, budget_limit: budget.limits.maxToolCalls, budget_phase: budget.phase,
		...(sessionWarning ? { session_warning: sessionWarning } : {}),
	});

	// Solve reads this to know whether it received a complete or a partial brief.
	mkdirSync(join(workspace, ".harness"), { recursive: true });
	writeFileSync(join(workspace, ".harness", "status.json"), `${JSON.stringify({
		valid: validation.valid, partial, errors: validation.errors.slice(0, 20),
		budget: { used: budget.used, limit: budget.limits.maxToolCalls }, dataset_snapshot_sha256: context.dataset.snapshot_sha256,
	}, null, 2)}\n`);
	if (sessionError && !progressed) throw sessionError;
	return {
		documentPath,
		contextPath,
		valid: validation.valid,
		errors: validation.errors,
		partial,
		budget: { used: budget.used, limit: budget.limits.maxToolCalls, phase: budget.phase },
		attempts,
		contextSha256,
		datasetSha256: context.dataset.snapshot_sha256,
	};
}
