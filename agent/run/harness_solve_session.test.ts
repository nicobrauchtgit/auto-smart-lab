import { guidanceHash } from "../pipeline/guidance.js";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { StageReporter, SuppliedInput } from "../pipeline/types.js";
import type { PythonEnvironment } from "./python_environment.js";
import { spamConfiguration } from "../pipeline/task_configuration.testing.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";
import {
	runHarnessSolveSession,
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
		observation(attempt) { return { identity: this.agentIdentity(attempt), sink: { record() {}, close() {}, databaseConnected: false, failures: [] } } as never; },
		input(input) { inputs.push(input); },
	};
	return { report, events, inputs };
}

describe("agent-driven harness solve session", () => {
	test("exposes only constrained training controls and fails without promotion evidence", async () => {
		const workspace = fixtureWorkspace();
		const observed = reporter();
		let closed = false;
		let bound = false;
		let updateIntervalMs: number | undefined;
		const toolNames = ["experiment_start", "experiment_status", "experiment_output", "experiment_stop"];
		const dependencies: Partial<HarnessSolveDependencies> = {
			prepareWorkspace: () => workspace,
			readPython: python,
			createTraining: (options) => {
				updateIntervalMs = options.limits?.updateIntervalMs;
				return {
					tools: toolNames.map((name) => ({ name })), toolPrompts: [], supervisor: {}, service: {},
					bindSession: () => { bound = true; }, close: async () => { closed = true; },
				} as never;
			},
			runAgentSession: async (options) => {
				expect(options.prompt).toContain("SOLVE_GUIDANCE");
                expect(options.promptReferences.map(p => p.id)).toContain("shared.stage-guidance");
                expect(options.extensionPaths).toEqual([join(import.meta.dir, "..", "tools", "web_search.ts")]);
				expect(options.customTools?.map((tool) => tool.name)).toEqual(toolNames);
				expect(options.customTools?.some((tool) => tool.name === "experiments_start")).toBe(false);
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
