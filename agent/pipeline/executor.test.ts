import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolvePipelineSettings } from "./config.js";
import { invokeStage } from "./executor.js";
import { STAGE_REGISTRY } from "./registry.js";
import { createPipelineTrace } from "./trace.js";
import type { PipelineConfig } from "../pipeline_config.js";
import type { StageDefinition } from "./types.js";

// The trace database is deliberately unreachable here, so these tests also cover
// the degraded recording path and the local JSON-lines mirror.
process.env.AGENT_DATABASE_PORT = "1";

const workspaces: string[] = [];
function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipeline-trace-"));
	workspaces.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
	delete STAGE_REGISTRY.solve;
});

function settings(stageOptions: unknown = {}) {
	return resolvePipelineSettings({
		pipeline: {
			version: 1,
			entryStage: "research",
			scheduling: "configured",
			stages: { research: { enabled: true }, solve: { enabled: true, options: stageOptions } },
		},
		agent: { cwd: ".", agentDir: ".pi/agent", initialPrompt: "hi" },
		defaultModel: "saia/test-model",
		providers: {},
	} as PipelineConfig);
}

function fakeStage(run: StageDefinition<{ label: string }>["run"]): StageDefinition<{ label: string }> {
	return {
		name: "solve",
		version: 3,
		description: "test stage",
		parseOptions: (raw) => ({ label: String((raw as { label?: string })?.label ?? "default") }),
		checkInput: (input) => {
			if (input.taskId === "missing") throw new Error("no local dataset");
		},
		run,
	};
}

async function runFakeStage(stage: StageDefinition<{ label: string }>, taskId = "spam1") {
	STAGE_REGISTRY.solve = stage;
	const runsDir = workspace();
	const trace = await createPipelineTrace({ taskId, pipelineRunId: crypto.randomUUID(), runsDir });
	const invocation = await invokeStage({
		stage: "solve",
		input: { taskId, upstream: [] },
		config: settings({ label: "configured" }),
		trace,
		reason: "test",
	});
	await trace.close();
	const events = readFileSync(trace.localPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	return { invocation, events, trace };
}

describe("invokeStage", () => {
	test("records a successful invocation with artifacts and inputs", async () => {
		const { invocation, events } = await runFakeStage(fakeStage(async (context) => {
			context.report.input({ kind: "task_prompt", version: 1, delivery: "workspace_file", status: "available" });
			context.report.event("agent_attempt_start", { attempt: 1 });
			return {
				artifacts: [{ kind: "solution", path: "/tmp/solution.py", sha256: "abc" }],
				validation: { valid: true, errors: [] },
				attempts: 1,
				summary: { attempts: 1, dataset_sha256: "dataset" },
			};
		}));

		expect(invocation.outcome).toBe("success");
		expect(invocation.stageVersion).toBe(3);
		expect(invocation.options).toEqual({ label: "configured" });
		expect(invocation.artifacts).toHaveLength(1);
		expect(invocation.attempts).toBe(1);

		const types = events.map((event) => event.event_type);
		expect(types).toEqual([
			"stage_started", "stage_input", "agent_attempt_start", "stage_summary", "stage_finished",
		]);
		// Stage events carry the shared identity and no PI session.
		for (const event of events) {
			expect(event.stage).toBe("solve");
			expect(event.stage_invocation_id).toBe(invocation.invocationId);
			expect(event.pi_session_id).toBeNull();
		}
		const finished = events.at(-1);
		expect(finished.payload.outcome).toBe("success");
		expect(finished.payload.supplied_inputs).toHaveLength(1);
	});

	test("a stage whose artifact fails validation is a failed invocation", async () => {
		const { invocation, events } = await runFakeStage(fakeStage(async () => ({
			artifacts: [{ kind: "research_document", path: "/tmp/research.md" }],
			validation: { valid: false, errors: ["missing sources section"] },
			attempts: 2,
			summary: { attempts: 2, dataset_sha256: "dataset" },
		})));

		expect(invocation.outcome).toBe("failure");
		expect(invocation.attempts).toBe(2);
		expect(invocation.error).toContain("missing sources section");
		// A failed run keeps the artifacts and fingerprints that make it comparable.
		expect(invocation.artifacts).toHaveLength(1);
		expect(events.map((event) => event.event_type)).toContain("stage_summary");
	});

	test("input rejection is recorded before any agent session exists", async () => {
		let ran = false;
		const { invocation, events } = await runFakeStage(
			fakeStage(async () => {
				ran = true;
				return { artifacts: [] };
			}),
			"missing",
		);

		expect(ran).toBe(false);
		expect(invocation.outcome).toBe("failure");
		expect(events.map((event) => event.event_type)).toEqual([
			"stage_started", "stage_input_rejected", "stage_finished",
		]);
	});

	test("a thrown stage error is recorded as a failure with its message", async () => {
		const { invocation, events } = await runFakeStage(fakeStage(async () => {
			throw new Error("model provider unreachable");
		}));

		expect(invocation.outcome).toBe("failure");
		expect(invocation.error).toBe("model provider unreachable");
		expect(events.map((event) => event.event_type)).toContain("stage_error");
	});

	test("an aborted stage is recorded as cancelled", async () => {
		STAGE_REGISTRY.solve = fakeStage(async (context) => {
			await new Promise((resolve, reject) => {
				context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
			return { artifacts: [] };
		});
		const runsDir = workspace();
		const trace = await createPipelineTrace({ taskId: "spam1", pipelineRunId: crypto.randomUUID(), runsDir });
		const controller = new AbortController();
		const pending = invokeStage({
			stage: "solve",
			input: { taskId: "spam1", upstream: [] },
			config: settings(),
			trace,
			signal: controller.signal,
		});
		controller.abort();
		const invocation = await pending;
		await trace.close();
		expect(invocation.outcome).toBe("cancelled");
	});

	test("a disabled stage is refused and the refusal is recorded", async () => {
		STAGE_REGISTRY.solve = fakeStage(async () => ({ artifacts: [] }));
		const runsDir = workspace();
		const trace = await createPipelineTrace({ taskId: "spam1", pipelineRunId: crypto.randomUUID(), runsDir });
		const config = resolvePipelineSettings({
			pipeline: { entryStage: "research", stages: { research: { enabled: true }, solve: { enabled: false } } },
			agent: { cwd: ".", agentDir: ".pi/agent", initialPrompt: "hi" },
			defaultModel: "saia/test-model",
			providers: {},
		} as PipelineConfig);
		await expect(invokeStage({
			stage: "solve",
			input: { taskId: "spam1", upstream: [] },
			config,
			trace,
		})).rejects.toThrow(/not enabled/);
		await trace.close();
		const events = readFileSync(trace.localPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(events.map((event) => event.event_type)).toEqual(["stage_rejected"]);
	});

	test("recording degradation is reported rather than hidden", async () => {
		const { trace } = await runFakeStage(fakeStage(async () => ({ artifacts: [] })));
		expect(trace.degraded()).toBe(true);
		expect(trace.failures().join(" ")).toContain("trace database unavailable");
	});
});
