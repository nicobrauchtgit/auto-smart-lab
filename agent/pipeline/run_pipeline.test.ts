import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPipeline } from "./executor.js";
import { STAGE_REGISTRY } from "./registry.js";
import type { StageDefinition, StageName, StageResult } from "./types.js";

// No trace database here either, so runs exercise the local mirror.
process.env.AGENT_DATABASE_PORT = "1";

const workspaces: string[] = [];
const realStages = { ...STAGE_REGISTRY };

afterEach(() => {
	for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
	for (const name of Object.keys(STAGE_REGISTRY) as StageName[]) delete STAGE_REGISTRY[name];
	Object.assign(STAGE_REGISTRY, realStages);
});

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "pipeline-run-"));
	workspaces.push(dir);
	return dir;
}

function configFile(dir: string, stages: Record<string, { enabled: boolean }>): string {
	const path = join(dir, "pipeline.config.json");
	writeFileSync(path, JSON.stringify({
		pipeline: { version: 1, entryStage: "research", scheduling: "configured", stages },
		agent: { cwd: ".", agentDir: ".pi/agent", initialPrompt: "hi" },
		defaultModel: "saia/test-model",
		providers: {},
	}));
	return path;
}

function stage(name: StageName, next: StageName | undefined, run: () => Promise<StageResult>): StageDefinition<unknown> {
	return {
		name,
		version: 1,
		description: `test ${name}`,
		next,
		parseOptions: () => ({}),
		checkInput: () => undefined,
		run,
	};
}

function events(runsDir: string, taskId: string, pipelineRunId: string) {
	// Trace files lead with a timestamp, so find this run by its id suffix
	// rather than reconstructing a name the writer chose.
	const directory = join(runsDir, taskId, "pipeline");
	const name = readdirSync(directory).find((entry) => entry.endsWith(`-${pipelineRunId.slice(0, 8)}.jsonl`));
	if (!name) throw new Error(`No trace for ${pipelineRunId} in ${directory}: ${readdirSync(directory).join(", ")}`);
	return readFileSync(join(directory, name), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

describe("runPipeline", () => {
	test("shares one prompt snapshot across stages and records its fingerprint", async () => {
		let snapshot: import("../prompts/loader.js").PromptSnapshot | undefined;
		STAGE_REGISTRY.research = {
			...stage("research", "solve", async () => ({ artifacts: [] })),
			async run(context) {
				snapshot = context.prompts;
				const prompt = snapshot.render("evaluation.start", { taskId: context.input.taskId });
				context.report.event("prompt_reference_test", { prompt: prompt.reference });
				return { artifacts: [] };
			},
		};
		STAGE_REGISTRY.solve = {
			...stage("solve", undefined, async () => ({ artifacts: [] })),
			async run(context) {
				expect(context.prompts).toBe(snapshot);
				return { artifacts: [] };
			},
		};
		const runsDir = workspace();
		const result = await runPipeline({
			taskId: "spam1", runsDir,
			configPath: configFile(runsDir, { research: { enabled: true }, solve: { enabled: true } }),
		});
		expect(result.outcome).toBe("success");
		const recorded = events(runsDir, "spam1", result.pipelineRunId);
		expect(recorded.find(event => event.event_type === "pipeline_prompt_snapshot").payload.prompt_snapshot_sha256)
			.toBe(snapshot!.fingerprint);
		const reference = recorded.find(event => event.event_type === "prompt_reference_test");
		expect(reference.payload.prompt).toEqual(snapshot!.render("evaluation.start", { taskId: "spam1" }).reference);
		expect(reference.pipeline_run_id).toBe(result.pipelineRunId);
		expect(reference.stage_invocation_id).toBe(result.invocations[0].invocationId);
	});

	test("follows the stage chain while the next stage is enabled", async () => {
		const order: string[] = [];
		STAGE_REGISTRY.research = stage("research", "solve", async () => {
			order.push("research");
			return { artifacts: [{ kind: "research_document", path: "/tmp/research.md" }], attempts: 1 };
		});
		STAGE_REGISTRY.solve = stage("solve", "evaluate", async () => {
			order.push("solve");
			return { artifacts: [] };
		});
		const runsDir = workspace();
		const result = await runPipeline({
			taskId: "spam1",
			runsDir,
			configPath: configFile(runsDir, { research: { enabled: true }, solve: { enabled: true }, evaluate: { enabled: false } }),
		});

		expect(order).toEqual(["research", "solve"]);
		expect(result.outcome).toBe("success");
		expect(result.stoppedBecause).toContain("evaluate");
		// Downstream stages see what earlier stages produced.
		const solveStarted = events(runsDir, "spam1", result.pipelineRunId)
			.filter((event) => event.event_type === "stage_started" && event.stage === "solve")[0];
		expect(solveStarted.payload.upstream_artifacts).toHaveLength(1);
	});

	test("stopAfter ends the run even when the next stage is enabled", async () => {
		const order: string[] = [];
		STAGE_REGISTRY.research = stage("research", "solve", async () => {
			order.push("research");
			return { artifacts: [] };
		});
		STAGE_REGISTRY.solve = stage("solve", undefined, async () => {
			order.push("solve");
			return { artifacts: [] };
		});
		const runsDir = workspace();
		const result = await runPipeline({
			taskId: "spam1",
			runsDir,
			stopAfter: "research",
			configPath: configFile(runsDir, { research: { enabled: true }, solve: { enabled: true } }),
		});

		expect(order).toEqual(["research"]);
		expect(result.stoppedBecause).toContain("as requested");
	});

	test("a failed stage stops the chain and the run reports the failure", async () => {
		let solved = false;
		STAGE_REGISTRY.research = stage("research", "solve", async () => ({
			artifacts: [],
			validation: { valid: false, errors: ["missing sources section"] },
			attempts: 2,
		}));
		STAGE_REGISTRY.solve = stage("solve", undefined, async () => {
			solved = true;
			return { artifacts: [] };
		});
		const runsDir = workspace();
		const result = await runPipeline({
			taskId: "spam1",
			runsDir,
			configPath: configFile(runsDir, { research: { enabled: true }, solve: { enabled: true } }),
		});

		expect(solved).toBe(false);
		expect(result.outcome).toBe("failure");
		const end = events(runsDir, "spam1", result.pipelineRunId).at(-1);
		expect(end.event_type).toBe("pipeline_run_end");
		expect(end.payload.outcome).toBe("failure");
	});

	test("a run that throws out of the stage loop is not recorded as a success", async () => {
		const runsDir = workspace();
		const configPath = configFile(runsDir, { research: { enabled: true }, solve: { enabled: false } });
		STAGE_REGISTRY.research = stage("research", "solve", async () => ({ artifacts: [] }));
		STAGE_REGISTRY.solve = stage("solve", undefined, async () => ({ artifacts: [] }));

		await expect(runPipeline({ taskId: "spam1", runsDir, configPath, entryStage: "solve" }))
			.rejects.toThrow(/not enabled/);

		const traceDir = join(runsDir, "spam1", "pipeline");
		const file = readFileSync(join(traceDir, readdirSync(traceDir)[0]), "utf8");
		const end = file.trim().split("\n").map((line) => JSON.parse(line)).at(-1);
		expect(end.event_type).toBe("pipeline_run_end");
		expect(end.payload.outcome).toBe("failure");
		expect(end.payload.stopped_because).toContain("not enabled");
	});

	test("an abort between stages ends the run as cancelled", async () => {
		const controller = new AbortController();
		let solved = false;
		STAGE_REGISTRY.research = stage("research", "solve", async () => {
			controller.abort();
			return { artifacts: [] };
		});
		STAGE_REGISTRY.solve = stage("solve", undefined, async () => {
			solved = true;
			return { artifacts: [] };
		});
		const runsDir = workspace();
		const result = await runPipeline({
			taskId: "spam1",
			runsDir,
			signal: controller.signal,
			configPath: configFile(runsDir, { research: { enabled: true }, solve: { enabled: true } }),
		});

		expect(solved).toBe(false);
		expect(result.outcome).toBe("cancelled");
	});
});

describe("seeded upstream artifacts", () => {
	test("entering mid-chain supplies earlier artifacts and records them as seeded", async () => {
		let received: import("./types.js").StageArtifact[] | undefined;
		STAGE_REGISTRY.solve = {
			...stage("solve", undefined, async () => ({ artifacts: [] })),
			async run(context) {
				received = context.input.upstream;
				return { artifacts: [] };
			},
		};
		const runsDir = workspace();
		const seed = { kind: "research_document", path: "/prior/research.md", sha256: "abc123" };
		const result = await runPipeline({
			taskId: "spam1", runsDir, entryStage: "solve", seedArtifacts: [seed],
			configPath: configFile(runsDir, { research: { enabled: true }, solve: { enabled: true } }),
		});

		expect(result.outcome).toBe("success");
		expect(received).toEqual([seed]);
		// Only solve ran: seeding must not imply research executed in this run.
		expect(result.invocations.map((invocation) => invocation.stage)).toEqual(["solve"]);
		const start = events(runsDir, "spam1", result.pipelineRunId)
			.find((event) => event.event_type === "pipeline_run_start");
		expect(start.payload.seeded_artifacts).toEqual([seed]);
	});

	test("records an empty seed list when the run starts from the beginning", async () => {
		STAGE_REGISTRY.research = stage("research", undefined, async () => ({ artifacts: [] }));
		const runsDir = workspace();
		const result = await runPipeline({
			taskId: "spam1", runsDir,
			configPath: configFile(runsDir, { research: { enabled: true } }),
		});
		const start = events(runsDir, "spam1", result.pipelineRunId)
			.find((event) => event.event_type === "pipeline_run_start");
		expect(start.payload.seeded_artifacts).toEqual([]);
	});
});
