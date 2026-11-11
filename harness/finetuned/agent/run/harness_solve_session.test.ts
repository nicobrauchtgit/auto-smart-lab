import { guidanceHash } from "../pipeline/guidance.js";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StageReporter, SuppliedInput } from "../pipeline/types.js";
import type { PythonEnvironment } from "./python_environment.js";
import { pythonManagerEnvironment, solvePythonEnvironmentTool, type PythonManagerIdentity } from "./solve_sandbox.js";
import { spamConfiguration } from "../pipeline/task_configuration.testing.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";
import {
	runHarnessSolveSession,
	recoveryTrainingRoot,
	type HarnessSolveDependencies,
} from "./harness_solve_session.js";

function fixtureWorkspace() {
	const root = mkdtempSync(join(tmpdir(), "harness-solve-session-"));
	const data = join(root, "data");
	const researchDir = join(root, "research");
	const solutionsRoot = join(root, "solutions");
	mkdirSync(data, { recursive: true });
	mkdirSync(researchDir, { recursive: true });
	mkdirSync(join(solutionsRoot, "tasks"), { recursive: true });
	const taskPath = join(root, "task.md");
	const devZip = join(data, "train-dev.zip");
	const manifest = join(data, "development-samples.json");
	writeFileSync(taskPath, "Train a classifier scored by balanced accuracy.\n");
	writeFileSync(devZip, "zip fixture");
	writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, samples: [
		{ id: "data/a.0", input: { archive: devZip, member: "data/a.0" }, target: 0 },
		{ id: "data/b.1", input: { archive: devZip, member: "data/b.1" }, target: 1 }] }));
	writeFileSync(join(researchDir, "research.md"), "# Research\n");
	return {
		root, solutionsRoot, entrypointPath: join(solutionsRoot, "tasks", "task.py"), taskPath, researchDir,
		configuration: spamConfiguration(),
		sampleManifestPath: manifest, measurement: { kind: "classification" as const, execution: "inductive" as const, sampleManifestPath: manifest }, devZip, sealedPath: join(data, "sealed.txt"), trainZip: devZip, testZip: join(data, "test.zip"),
		datasetPaths: [devZip], split: { sealedIds: [], fraction: 0.1, seed: 13, sha256: "a".repeat(64), scheme: "stratified" as const },
		recommendation: { scheme: "stratified_kfold" as const, folds: 2, repeats: 1, rationale: "fixture" },
		rowCount: 2, targets: manifest, targetSummary: "Class balance: class 0 1, class 1 1.", researchState: "research available",
		researchDocumentSha256: "b".repeat(64),
	};
}

function sandbox(workspace: ReturnType<typeof fixtureWorkspace>) {
 return { agentRoot: join(workspace.root, "agent"), executable: "/test/bwrap", cwd: workspace.root, mounts: [], env: {}, args: (command: string[]) => command };
}

function python(): PythonEnvironment {
	return {
		schema_version: 1, python_version: "3.13", executable: "/venv/bin/python", prefix: "/venv",
		packages: [], declared_dependencies: [], project_sha256: "a".repeat(64), lock_sha256: "b".repeat(64),
		healthy: true, lock_current: true, environment_matches_lock: true, dependency_errors: "",
		fingerprint: "c".repeat(64),
	};
}

function reporter() {
	const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
	const inputs: SuppliedInput[] = [];
	const report: StageReporter = {
		event(type, payload) { events.push({ type, payload }); },
		agentIdentity(attempt) { return { pipelineRunId: "pipeline-1", taskId: "task", stage: "solve", stageInvocationId: "stage-1", attempt }; },
		observation(attempt) { return { identity: this.agentIdentity(attempt), telemetry: { record() {}, close() {}, failures: [] } } as never; },
		input(input) { inputs.push(input); },
	};
	return { report, events, inputs };
}

function pausedTrainingRoot(parent: string, id: string) {
	const root = join(parent, id), directory = join(root, "paused-trial");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "recovery.json"), JSON.stringify({ lifecycle: "service_closed", trial: { startedAt: 1 } }));
	writeFileSync(join(directory, "trial-result.json"), JSON.stringify({ status: "interrupted" }));
	writeFileSync(join(directory, "search-report.json"), JSON.stringify({ stopReason: "acknowledgement_required" }));
	return { root, directory };
}

describe("solve recovery root ownership", () => {
	test("fresh follow-up does not inherit a successful solve's paused search budget", () => {
		const parent = mkdtempSync(join(tmpdir(), "solve-root-budget-"));
		const prior = pausedTrainingRoot(parent, "successful-solve");
		expect(recoveryTrainingRoot(parent, "followup", [prior.root])).toBe(join(parent, "followup"));
		// Restarting that very invocation must still recover its charged budget.
		expect(recoveryTrainingRoot(parent, "successful-solve", [prior.root])).toBe(prior.root);
	});
	test("an uncompleted invocation retains its paused search across a new invocation", () => {
		const parent = mkdtempSync(join(tmpdir(), "solve-root-paused-"));
		const prior = pausedTrainingRoot(parent, "interrupted-solve");
		expect(recoveryTrainingRoot(parent, "recovery")).toBe(prior.root);
	});
	test("successful upstream evidence cannot hide an active recovery candidate", () => {
		const parent = mkdtempSync(join(tmpdir(), "solve-root-active-"));
		const prior = pausedTrainingRoot(parent, "prior");
		writeFileSync(join(prior.directory, "recovery.json"), JSON.stringify({ lifecycle: "active" }));
		writeFileSync(join(prior.directory, "search-report.json"), "{}");
		expect(recoveryTrainingRoot(parent, "followup", [prior.root])).toBe(prior.root);
	});
});

describe("agent-driven harness solve session", () => {
	test("exposes only constrained training controls and fails without promotion evidence", async () => {
		const workspace = fixtureWorkspace();
		const prior = pausedTrainingRoot(join(workspace.root, "training"), "successful-solve");
		const observed = reporter();
		let closed = false;
		let bound = false;
		let updateIntervalMs: number | undefined;
		let environmentIdentity: PythonManagerIdentity | undefined;
		const toolNames = ["experiment_start", "experiment_status", "experiment_output", "experiment_stop"];
		const dependencies: Partial<HarnessSolveDependencies> = {
			prepareWorkspace: () => workspace,
			prepareSandbox: () => sandbox(workspace),
			readPython: python,
			environmentTool: (python, description, root, identity) => {
				environmentIdentity = identity;
				return solvePythonEnvironmentTool(python, description, root, identity);
			},
			createTraining: (options) => {
				expect(options.root).toBe(join(workspace.root, "training", "stage-1"));
				updateIntervalMs = options.limits?.updateIntervalMs;
				expect(typeof options.sandboxCommand).toBe("function");
				expect(options.executionBoundaryFingerprint).toMatch(/^[a-f0-9]{64}$/);
				return {
					tools: toolNames.map((name) => ({ name })), toolPrompts: [], supervisor: {}, service: {},
					bindSession: () => { bound = true; }, close: async () => { closed = true; },
				} as never;
			},
			runAgentSession: async (options) => {
				expect(options.prompt).toContain("SOLVE_GUIDANCE");
                expect(options.promptReferences.map(p => p.id)).toContain("shared.stage-guidance");
                expect(options.extensionPaths).toEqual([join(import.meta.dir, "..", "tools", "web_search.ts")]);
				expect(options.tools).toEqual([]);
				expect(options.customTools?.map((tool) => tool.name)).toEqual([...toolNames, "read", "write", "edit", "bash", "grep", "find", "ls", "python_environment"]);
				expect(options.prompt).toContain("mount and PID namespace");
				expect(options.env?.SOLVE_WORKSPACE).toBe(join(workspace.root, "agent"));
				expect(options.customTools?.some((tool) => tool.name === "experiments_start")).toBe(false);
				// Packages the python_environment tool adds are attributed to this session.
				expect(options.pythonSessionId).toMatch(/^[0-9a-f-]{36}$/);
				expect(environmentIdentity?.sessionId).toBe(options.pythonSessionId);
				expect(pythonManagerEnvironment(python(), "/tmp/manager", environmentIdentity).PIPELINE_PYTHON_SESSION_ID).toBe(options.pythonSessionId!);
				await options.onSessionReady?.({} as never, { agentRunId: "agent-test", piSessionId: "session-test" });
				return { output: "done", agentRunId: "agent-1" };
			},
			collectResults: async () => ({
				trials: [], valid: false,
				errors: [{ code: "no_eligible_result", message: "no valid completed promotion is eligible for selection" }],
				artifacts: [],
			}),
		};

		const result = await runHarnessSolveSession("task", undefined, {
			guidance: (() => { const body = { id: "solve-note", version: 1, stage: "solve" as const, taskId: "task", content: "SOLVE_GUIDANCE", evidence: [] }; return { ...body, contentSha256: guidanceHash(body) }; })(),
            runId: "stage-1", report: observed.report, dependencies,
			upstream: [{ kind: "training_selected_result", path: join(prior.root, "selected-trial", "trial-result.json") }],
			experimentUpdateIntervalSeconds: 45,
		});
		expect(bound).toBe(true);
		expect(updateIntervalMs).toBe(45_000);
		expect(closed).toBe(true);
		expect(result.valid).toBe(false);
		expect(result.stopReason).toBe("no_promotion");
		expect(result.errors).toEqual(["no valid completed promotion is eligible for selection"]);
		expect(observed.inputs.some((input) => input.kind === "training_framework")).toBe(true);
	});

	test("always closes descendants when the agent session fails", async () => {
		const workspace = fixtureWorkspace();
		const observed = reporter();
		let closed = false;
		const dependencies: Partial<HarnessSolveDependencies> = {
			prepareWorkspace: () => workspace,
			prepareSandbox: () => sandbox(workspace),
			readPython: python,
			createTraining: () => ({
				tools: [], toolPrompts: [], supervisor: {}, service: {}, bindSession() {},
				close: async () => { closed = true; },
			} as never),
			runAgentSession: async () => { throw new Error("model session failed"); },
			collectResults: async () => ({ trials: [], valid: false,
				errors: [{ code: "no_eligible_result", message: "no promotion" }], artifacts: [] }),
		};

		const result = await runHarnessSolveSession("task", undefined, {
			runId: "stage-1", report: observed.report, dependencies,
		});
		expect(closed).toBe(true);
		expect(result.stopReason).toBe("agent_failed");
		expect(result.sessionError).toBe("model session failed");
		expect(observed.events.some((event) => event.type === "agent_attempt_error")).toBe(true);
	});
});


test("unrecoverable follow-up closes training and prevents agent execution", async () => {
 const { ensureSolutionsRepository, git } = await import("../training/git.js");
 const workspace = fixtureWorkspace();
 ensureSolutionsRepository(workspace.solutionsRoot);
 const directory = git(workspace.solutionsRoot, ["rev-parse", "--absolute-git-dir"]).stdout.trim();
 writeFileSync(join(directory, "smartlab-follow-up.json"), "corrupt");
 let called = false, closed = false;
 await expect(runHarnessSolveSession("task", undefined, { runId: "failed-recovery", dependencies: {
  prepareWorkspace: () => workspace, prepareSandbox: () => sandbox(workspace), readPython: python,
  createTraining: () => ({ tools: [], toolPrompts: [], supervisor: {}, service: {}, bindSession() {}, close: async () => { closed = true; } } as never),
  runAgentSession: async () => { called = true; throw new Error("must not execute"); },
 } })).rejects.toThrow("could not be closed");
 expect(called).toBe(false);
 expect(closed).toBe(true);
});
