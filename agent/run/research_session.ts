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
	PROJECT_ROOT,
	researchContextHash,
	writeResearchContext,
} from "../research/context.js";
import { validateResearchFile } from "../research/validate.js";
import { loadPromptSnapshot, type PromptSnapshot } from "../prompts/loader.js";
import { prepareResearchPrompts } from "../prompts/research.js";
import type { StageReporter } from "../pipeline/types.js";
import { runSession } from "./session_runner.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, "..");
const WEB_SEARCH_EXTENSION = join(AGENT_DIR, "tools", "web_search.ts");

export interface ResearchResult {
	documentPath: string;
	contextPath: string;
	valid: boolean;
	errors: string[];
	attempts: number;
	contextSha256: string;
	datasetSha256: string;
}

export interface RunResearchOptions {
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
	const injectStartupContext = options.injectStartupContext ?? true;
	const report = options.report;
	const prompts = options.prompts ?? loadPromptSnapshot();
	const { context, prompt } = buildResearchContext(taskId);
	const workspace = join(PROJECT_ROOT, "runs", taskId, "research");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(join(workspace, "analysis"), { recursive: true });

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
	try {
		while (attempts < 2) {
			if (options.signal?.aborted) break;
			attempts++;
			const prepared = prepareResearchPrompts(prompts, {
				taskId, contextHash: contextSha256,
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
			const { output, agentRunId } = await runSession({
				...prepared,
				prompts,
				reportInput: report ? input => report.input(input) : undefined,
				model,
				env: { WEB_SEARCH_MAX_CALLS: attempts === 1 ? String(context.limits.web_search_calls) : "0", WEB_SEARCH_MAX_RESULTS: "4" },
				cwd: workspace,
				tools: ["read", "grep", "find", "ls", "edit", "write", "bash", "web_search"],
				extensionPaths: [WEB_SEARCH_EXTENSION],
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
		...(sessionWarning ? { session_warning: sessionWarning } : {}),
	});

	report?.event("research_finished", {
		attempts,
		valid: validation.valid,
		errors: validation.errors,
		document_changed: sha256(before) !== sha256(after),
		...(sessionWarning ? { session_warning: sessionWarning } : {}),
	});

	// Only a failed session is raised. A document that fails validation is a
	// result: the caller records it and decides what the stage outcome is.
	if (sessionError) throw sessionError;
	return {
		documentPath,
		contextPath,
		valid: validation.valid,
		errors: validation.errors,
		attempts,
		contextSha256,
		datasetSha256: context.dataset.snapshot_sha256,
	};
}
