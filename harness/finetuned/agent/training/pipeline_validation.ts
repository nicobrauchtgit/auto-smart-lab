/** Time-bounded Layer 2 validation: build the real pipeline from the trial's worktree, never fit. */

import { spawn } from "node:child_process";

import { preview } from "./contract.js";
import type { ExperimentRequest, MeasurementConfig, ValidationIssue } from "./types.js";

export interface PipelineValidationInput {
	pythonExecutable: string;
	/** Fully formed controller sandbox command, when supplied. */
	command?: readonly string[];
	scriptPath: string;
	/** Root whose `solutions/` directory is the requested commit's worktree. */
	sourceRoot: string;
	request: ExperimentRequest;
	measurement?: MeasurementConfig;
	env?: Record<string, string>;
	cwd: string;
	timeoutMs: number;
}

export type PipelineValidator = (input: PipelineValidationInput) => Promise<ValidationIssue[]>;

function isIssue(value: unknown): value is ValidationIssue {
	if (value === null || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	return ["path", "problem", "expected", "hint"].every((key) => typeof entry[key] === "string");
}

/** A crash or timeout is a rejection with its reason, never a silent pass. */
export const runPipelineValidation: PipelineValidator = (input) => new Promise((settle) => {
	const command = input.command ?? [input.pythonExecutable, input.scriptPath];
	const child = spawn(command[0]!, command.slice(1), {
		cwd: input.cwd,
		env: { ...(input.env ?? process.env), PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" },
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
	let stdout = "";
	let stderr = "";
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
	}, input.timeoutMs);
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => { if (stdout.length < 4_000_000) stdout += chunk; });
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-8_000); });
	const failure = (problem: string, hint: string, message?: string): ValidationIssue[] => [{
		path: "pipeline", problem, received: preview(input.request.pipeline.module),
		expected: "a module and factory that build the pipeline quickly without fitting", hint,
		...(message ? { message } : {}),
	}];
	child.on("error", (error) => {
		clearTimeout(timer);
		settle(failure("validation could not start", "Check the project Python environment; this is a harness setup problem.", error.message));
	});
	child.on("close", (code) => {
		clearTimeout(timer);
		if (timedOut) {
			settle(failure(`validation did not finish within ${Math.round(input.timeoutMs / 1000)} s`,
				"Keep module import and factory construction cheap: do not fit, download, or read the dataset at import or build time."));
			return;
		}
		try {
			const parsed = JSON.parse(stdout) as { issues?: unknown };
			if (code === 0 && Array.isArray(parsed.issues) && parsed.issues.every(isIssue)) {
				settle(parsed.issues);
				return;
			}
		} catch {
			// Fall through to the crash report below.
		}
		const tail = stderr.trim().split("\n").slice(-6).join("\n");
		settle(failure("validation crashed while loading the pipeline",
			"Run the module locally to reproduce; the last lines of its error output are included.", tail || `exit code ${code}`));
	});
	child.stdin.end(JSON.stringify({ sourceRoot: input.sourceRoot, request: input.request, measurement: input.measurement }));
});
