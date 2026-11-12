import { testTelemetry, traceEvents, traceEventsForDirectory, telemetryForDirectory } from "../telemetry/testing.js";
import { afterEach, describe, expect, test } from "bun:test";
import { spamConfiguration } from "./task_configuration.testing.js";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runPipeline } from "./executor.js";
import { STAGE_REGISTRY } from "./registry.js";
import type { StageDefinition, StageName, StageResult } from "./types.js";

// No trace database here either, so runs exercise the local mirror.


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
		pipeline: { version: 1, entryStage: "lead", scheduling: "configured", stages, tasks: { spam1: spamConfiguration() } },
		agent: { cwd: ".", agentDir: ".pi/agent", initialPrompt: "hi" },
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

function events(_runsDir: string, _taskId: string, pipelineRunId: string) { return traceEvents(pipelineRunId); }

describe("runPipeline", () => {
	test("shares one prompt snapshot across stages and records its fingerprint", async () => {
		let snapshot: import("../prompts/loader.js").PromptSnapshot | undefined;
		STAGE_REGISTRY.lead = {
			...stage("lead", "refit", async () => ({ artifacts: [] })),
			async run(context) {
				snapshot = context.prompts;
				const prompt = snapshot.render("team.lead-system", { budget: "80", taskId: context.input.taskId });
				context.report.event("prompt_reference_test", { prompt: prompt.reference });
				return { artifacts: [] };
			},
		};
		STAGE_REGISTRY.refit = {
			...stage("refit", undefined, async () => ({ artifacts: [] })),
			async run(context) {
				expect(context.prompts).toBe(snapshot!);
				return { artifacts: [] };
			},
		};
		const runsDir = workspace();
		const result = await runPipeline({ telemetry: telemetryForDirectory(runsDir),
			taskId: "spam1", runsDir,
			configPath: configFile(runsDir, { lead: { enabled: true }, refit: { enabled: true } }),
		});
		expect(result.outcome).toBe("success");
		const recorded = events(runsDir, "spam1", result.pipelineRunId);
		expect(recorded.find(event => event.event_type === "pipeline_prompt_snapshot")!.payload.prompt_snapshot_sha256)
			.toBe(snapshot!.fingerprint);
		const reference = recorded.find(event => event.event_type === "prompt_reference_test");
		expect(reference!.payload.prompt).toEqual(snapshot!.render("team.lead-system", { budget: "80", taskId: "spam1" }).reference);
		expect(reference!.pipeline_run_id).toBe(result.pipelineRunId);
		expect(reference!.stage_invocation_id).toBe(result.invocations[0].invocationId);
	});

	test("follows the stage chain while the next stage is enabled", async () => {
		const order: string[] = [];
		STAGE_REGISTRY.lead = stage("lead", "refit", async () => {
			order.push("lead");
			return { artifacts: [{ kind: "research_document", path: "/tmp/solve.md" }], attempts: 1 };
		});
		STAGE_REGISTRY.refit = stage("refit", "submit", async () => {
			order.push("refit");
			return { artifacts: [] };
		});
		const runsDir = workspace();
		const result = await runPipeline({ telemetry: telemetryForDirectory(runsDir),
			taskId: "spam1",
			runsDir,
			configPath: configFile(runsDir, { lead: { enabled: true }, refit: { enabled: true }, submit: { enabled: false } }),
		});

		expect(order).toEqual(["lead", "refit"]);
		expect(result.outcome).toBe("success");
		expect(result.stoppedBecause).toContain("configured chain completed");
		// Downstream stages see what earlier stages produced.
		const solveStarted = events(runsDir, "spam1", result.pipelineRunId)
			.filter((event) => event.event_type === "stage_started" && event.stage === "refit")[0];
		expect(solveStarted.payload.upstream_artifacts).toHaveLength(1);
	});

	test("stopAfter ends the run even when the next stage is enabled", async () => {
		const order: string[] = [];
		STAGE_REGISTRY.lead = stage("lead", "refit", async () => {
			order.push("lead");
			return { artifacts: [] };
		});
		STAGE_REGISTRY.refit = stage("refit", undefined, async () => {
			order.push("refit");
			return { artifacts: [] };
		});
		const runsDir = workspace();
		const result = await runPipeline({ telemetry: telemetryForDirectory(runsDir),
			taskId: "spam1",
			runsDir,
			stopAfter: "lead",
			configPath: configFile(runsDir, { lead: { enabled: true }, refit: { enabled: true } }),
		});

		expect(order).toEqual(["lead"]);
		expect(result.stoppedBecause).toContain("as requested");
	});

	test("a failed stage stops the chain and the run reports the failure", async () => {
		let solved = false;
		STAGE_REGISTRY.lead = stage("lead", "refit", async () => ({
			artifacts: [],
			validation: { valid: false, errors: ["missing sources section"] },
			attempts: 2,
		}));
		STAGE_REGISTRY.refit = stage("refit", undefined, async () => {
			solved = true;
			return { artifacts: [] };
		});
		const runsDir = workspace();
		const result = await runPipeline({ telemetry: telemetryForDirectory(runsDir),
			taskId: "spam1",
			runsDir,
			configPath: configFile(runsDir, { lead: { enabled: true }, refit: { enabled: true } }),
		});

		expect(solved).toBe(false);
		expect(result.outcome).toBe("failure");
		const end = events(runsDir, "spam1", result.pipelineRunId).at(-1)!;
		expect(end.event_type).toBe("pipeline_run_end");
		expect(end.payload.outcome).toBe("failure");
	});

	test("a run that throws out of the stage loop is not recorded as a success", async () => {
		const runsDir = workspace();
		const configPath = configFile(runsDir, { lead: { enabled: true }, refit: { enabled: false } });
		STAGE_REGISTRY.lead = stage("lead", "refit", async () => ({ artifacts: [] }));
		STAGE_REGISTRY.refit = stage("refit", undefined, async () => ({ artifacts: [] }));

		await expect(runPipeline({ telemetry: telemetryForDirectory(runsDir), taskId: "spam1", runsDir, configPath, entryStage: "refit" }))
			.rejects.toThrow(/not enabled/);

		const end = traceEventsForDirectory(runsDir).at(-1)!;
		expect(end.event_type).toBe("pipeline_run_end");
		expect(end.payload.outcome).toBe("failure");
		expect(end.payload.stopped_because).toContain("not enabled");
	});

	test("an abort between stages ends the run as cancelled", async () => {
		const controller = new AbortController();
		let solved = false;
		STAGE_REGISTRY.lead = stage("lead", "refit", async () => {
			controller.abort();
			return { artifacts: [] };
		});
		STAGE_REGISTRY.refit = stage("refit", undefined, async () => {
			solved = true;
			return { artifacts: [] };
		});
		const runsDir = workspace();
		const result = await runPipeline({ telemetry: telemetryForDirectory(runsDir),
			taskId: "spam1",
			runsDir,
			signal: controller.signal,
			configPath: configFile(runsDir, { lead: { enabled: true }, refit: { enabled: true } }),
		});

		expect(solved).toBe(false);
		expect(result.outcome).toBe("cancelled");
	});
});

describe("seeded upstream artifacts", () => {
	test("entering mid-chain supplies earlier artifacts and records them as seeded", async () => {
		let received: import("./types.js").StageArtifact[] | undefined;
		STAGE_REGISTRY.refit = {
			...stage("refit", undefined, async () => ({ artifacts: [] })),
			async run(context) {
				received = context.input.upstream;
				return { artifacts: [] };
			},
		};
		const runsDir = workspace();
		const seed = { kind: "research_document", path: "/prior/solve.md", sha256: "abc123" };
		const result = await runPipeline({ telemetry: telemetryForDirectory(runsDir),
			taskId: "spam1", runsDir, entryStage: "refit", seedArtifacts: [seed],
			configPath: configFile(runsDir, { lead: { enabled: true }, refit: { enabled: true } }),
		});

		expect(result.outcome).toBe("success");
		expect(received).toEqual([seed]);
		// Only refit ran: seeding must not imply solve executed in this run.
		expect(result.invocations.map((invocation) => invocation.stage)).toEqual(["refit"]);
		const start = events(runsDir, "spam1", result.pipelineRunId)
			.find((event) => event.event_type === "pipeline_run_start");
		expect(start!.payload.seeded_artifacts).toEqual([seed]);
	});

	test("records an empty seed list when the run starts from the beginning", async () => {
		STAGE_REGISTRY.lead = stage("lead", undefined, async () => ({ artifacts: [] }));
		const runsDir = workspace();
		const result = await runPipeline({ telemetry: telemetryForDirectory(runsDir),
			taskId: "spam1", runsDir,
			configPath: configFile(runsDir, { lead: { enabled: true } }),
		});
		const start = events(runsDir, "spam1", result.pipelineRunId)
			.find((event) => event.event_type === "pipeline_run_start");
		expect(start!.payload.seeded_artifacts).toEqual([]);
	});
});

test("a missing later-stage prerequisite blocks every stage and records the failure", async () => {
 expect(realStages.lead!.setupRequirements).toContain("web-search");
 const before = process.env.TAVILY_API_KEY;
 process.env.TAVILY_API_KEY = "";
 let ran = false;
 const runsDir = workspace();
 try {
  STAGE_REGISTRY.lead = stage("lead", "refit", async () => { ran = true; return { artifacts: [] }; });
  STAGE_REGISTRY.refit = { ...stage("refit", undefined, async () => { ran = true; return { artifacts: [] }; }), setupRequirements: realStages.lead!.setupRequirements?.filter(requirement => requirement === "web-search") };
  const configPath = configFile(runsDir, { lead: { enabled: true }, refit: { enabled: true } });
  await expect(runPipeline({ telemetry: telemetryForDirectory(runsDir), taskId: "spam1", runsDir, configPath })).rejects.toThrow("TAVILY_API_KEY");
  expect(ran).toBe(false);
  const records = traceEventsForDirectory(runsDir);
  expect(records.some(record => record.event_type === "setup_finished" && record.payload.valid === false)).toBe(true);
  expect(records.some(record => record.event_type === "stage_started")).toBe(false);
  expect(records.at(-1)!.payload.outcome).toBe("failure");
 } finally {
  if (before === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = before;
 }
});

test("setup-only runs do not execute stages; stop-after excludes later requirements", async () => {
 let ran = false;
 STAGE_REGISTRY.lead = stage("lead", "refit", async () => { ran = true; return { artifacts: [] }; });
 STAGE_REGISTRY.refit = { ...stage("refit", undefined, async () => ({ artifacts: [] })), setupRequirements: ["web-search"] };
 const runsDir = workspace();
 const configPath = configFile(runsDir, { lead: { enabled: true }, refit: { enabled: true } });
 const result = await runPipeline({ telemetry: telemetryForDirectory(runsDir), taskId: "spam1", runsDir, configPath, stopAfter: "lead", checkSetupOnly: true });
 expect(result.outcome).toBe("success");
 expect(result.invocations).toHaveLength(0);
 expect(ran).toBe(false);
});

test("invalid guidance prevents every stage before any session, including setup-only", async () => {
 const { guidanceHash } = await import('./guidance.js');
 let ran = 0;
 STAGE_REGISTRY.lead = stage("lead", "refit", async () => { ran++; return { artifacts: [] }; });
 STAGE_REGISTRY.refit = stage("refit", undefined, async () => { ran++; return { artifacts: [] }; });
 const runsDir = workspace();
 const body = { id: "later", version: 1, taskId: "other-task", stage: "lead" as const, content: "Investigate shift", evidence: [] };
 const guidance = { lead: { ...body, contentSha256: guidanceHash(body) } };
 await expect(runPipeline({ telemetry: telemetryForDirectory(runsDir), taskId: "spam1", runsDir, guidance,
  configPath: configFile(runsDir, { lead: { enabled: true }, refit: { enabled: true } }) })).rejects.toThrow(/binding/);
 expect(ran).toBe(0);
});

test('fresh pipeline and standalone check-setup pass scout source checks before TaskData exists', async()=>{
 const { runLeadStage }=await import('./run_lead.js');
 const { readTaskData }=await import('../solve/task_data.js');
 for(const taskId of ['spam1','spam2','spam3']) {
  expect(readTaskData(taskId)).toBeUndefined();
  let ran=0;
  STAGE_REGISTRY.lead={...stage('lead',undefined,async()=>{ran++;return {artifacts:[]};}),setupRequirements:['scouts']};
  const runsDir=workspace();const configPath=configFile(runsDir,{lead:{enabled:true}});
  const config=JSON.parse(readFileSync(configPath,'utf8'));config.pipeline.tasks={[taskId]:spamConfiguration()};writeFileSync(configPath,JSON.stringify(config));
  const result=await runPipeline({telemetry:telemetryForDirectory(runsDir),taskId,runsDir,configPath});
  expect(result.outcome).toBe('success');expect(ran).toBe(1);
  const checked=await runLeadStage({telemetry:telemetryForDirectory(runsDir),taskId,runsDir,configPath,checkSetupOnly:true});
  expect(checked.outcome).toBe('success');expect(checked.invocations).toHaveLength(0);expect(ran).toBe(1);
  expect(readTaskData(taskId)).toBeUndefined();
 }
});
