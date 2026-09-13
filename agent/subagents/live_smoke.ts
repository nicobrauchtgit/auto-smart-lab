/** Explicit, paid live test: bun agent/subagents/live_smoke.ts. Never imported by the pipeline. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { initializeModel } from "../model_provider.js";
import { observeAgentSession } from "../observability.js";
import { loadResolvedPipelineConfig } from "../pipeline/config.js";
import { invokeStage } from "../pipeline/executor.js";
import { STAGE_REGISTRY } from "../pipeline/registry.js";
import { createPipelineTrace } from "../pipeline/trace.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { preparePythonEnvironment, readPythonEnvironment } from "../run/python_environment.js";
import { createSubagents, loadChildResources } from "./index.js";
import { assessSmokeContext } from "./smoke_validation.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export async function runLiveSmoke() {
	const root = mkdtempSync(join(tmpdir(), "subagents-live-"));
	const workspace = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(workspace); mkdirSync(agentDir);
	writeFileSync(join(root, "AGENTS.md"), "DEVELOPMENT_GUIDANCE_LIVE_SMOKE_EXCLUDED\n");
	const prompts = loadPromptSnapshot();
	const python = preparePythonEnvironment(prompts, readPythonEnvironment());
	const task = prompts.render("subagents.smoke-task", { python: JSON.stringify(python.env.VENV_DIR + "/bin/python") });
	writeFileSync(join(workspace, "TASK.md"), task.text);
	const opening = prompts.render("subagents.smoke-start", { workspace });
	const { resolved, config } = await loadResolvedPipelineConfig();
	const model = await initializeModel({ config });
	const pipelineRunId = randomUUID();
	const trace = await createPipelineTrace({ taskId: "subagents-live-smoke", pipelineRunId, runsDir: resolve("runs") });
	console.log(JSON.stringify({ event: "live_smoke_started", model: model.modelId, workspace, trace: trace.localPath }));
	trace.event("pipeline_run_start", { kind: "subagents_live_smoke", model: model.modelId,
		prompt_snapshot_sha256: prompts.fingerprint, workspace });
	let stoppedAfterSuccess = false;
	let verification: { valid: boolean; output: string } | undefined;
	let children: ReturnType<typeof createSubagents>["manager"] | undefined;
	const originalStage = STAGE_REGISTRY.solve;
	// Process-local test fixture, using the same executor as the existing stage tests.
	// The normal solve stage and pipeline configuration are never changed on disk.
	STAGE_REGISTRY.solve = {
		name: "solve", version: 1, description: "Live subagent implementation smoke fixture",
		parseOptions: () => ({ fixture: "subagents-live-smoke", stopAfterFirstSuccess: true }),
		checkInput: () => {},
		async run(context) {
			context.report.input(python.input);
			context.report.input({ kind: "task_prompt", version: 1, delivery: "workspace_file", status: "available",
				artifact: join(workspace, "TASK.md"), content_sha256: hash(task.text), prompt: task.reference });
			const scope = createSubagents({ cwd: workspace, agentDir, ...model, prompts,
				sharedInstructions: [python.prompt], inputs: [python.input],
				env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...python.env },
				observe: context.report.observation(1), signal: context.signal,
				limits: { maxChildren: 1, maxConcurrent: 1 }, turnTimeoutMs: 5 * 60_000 });
			let parent: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
			let observer: Awaited<ReturnType<typeof observeAgentSession>> | undefined;
			let unsubscribe: (() => void) | undefined;
			let stopping: Promise<void> | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const resources = await loadChildResources({ cwd: workspace, agentDir,
					instructions: [scope.parentInstructions, python.prompt] });
				({ session: parent } = await createAgentSession({ cwd: workspace, agentDir, ...model, ...resources,
					sessionManager: SessionManager.inMemory(workspace),
					tools: ["read", ...scope.tools.map(tool => tool.name)], customTools: scope.tools }));
				observer = await observeAgentSession({ session: parent, model: model.modelId, ...context.report.observation(1) });
				scope.bindParent(observer.agentRunId);
				children = scope.manager;
				observer.record("prompt_snapshot", { prompts: [scope.parentInstructions.reference, python.prompt.reference, opening.reference],
					effective_system_prompt: parent.systemPrompt, effective_system_prompt_sha256: hash(parent.systemPrompt), initial_prompt: opening.text });
				context.report.event("agent_attempt_start", { attempt: 1, model: model.modelId });
				unsubscribe = parent.subscribe(event => {
					if (event.type !== "tool_execution_end") return;
					console.log(JSON.stringify({ event: "parent_tool_end", tool: event.toolName, isError: event.isError }));
					if (event.toolName !== "subagent_wait" || event.isError || stoppedAfterSuccess) return;
					const text = event.result.content.find(block => block.type === "text");
					if (text?.type !== "text") return;
					let reply;
					try { reply = JSON.parse(text.text); } catch { return; }
					if (reply.status !== "idle" || !reply.output) return;
					verification = verify(python.env.VENV_DIR + "/bin/python", workspace);
					context.report.event("artifact_validation", verification);
					if (!verification.valid) return;
					stoppedAfterSuccess = true;
					observer!.record("live_smoke_stop", { reason: "first_validated_child_reply", child: reply });
					console.log(JSON.stringify({ event: "first_child_success", child: reply }));
					// Start abort synchronously at the completed tool boundary; never await it inside the subscriber.
					stopping = parent!.abort();
				});
				timer = setTimeout(() => { stopping = parent!.abort(); }, 6 * 60_000);
				await parent.prompt(opening.text);
				await stopping;
				context.report.event("agent_attempt_end", { attempt: 1, agent_run_id: observer.agentRunId, stoppedAfterSuccess });
			} finally {
				if (timer) clearTimeout(timer);
				unsubscribe?.();
				try { await scope.close(); }
				finally { await observer?.close(); parent?.dispose(); }
			}
			const valid = stoppedAfterSuccess && verification?.valid === true;
			return { artifacts: valid ? ["metrics.py", "test_metrics.py"].map(name => ({ kind: "smoke_implementation", path: join(workspace, name),
				sha256: hash(readFileSync(join(workspace, name), "utf8")) })) : [],
				validation: { valid, errors: valid ? [] : [verification?.output ?? "No successful child reply received"] }, attempts: 1 };
		},
	};
	try {
		const invocation = await invokeStage({ stage: "solve", input: { taskId: "subagents-live-smoke", upstream: [], model: model.modelId },
			config: resolved, trace, prompts, reason: "live_smoke", optionOverrides: {} });
		trace.event("pipeline_run_end", { outcome: invocation.outcome, stoppedAfterSuccess });
		await trace.close();
		const events = readFileSync(trace.localPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
		const parentId = children?.list()[0]?.parentAgentRunId;
		const childId = children?.list()[0]?.agentRunId;
		const contextAssessment = assessSmokeContext(events, parentId, childId);
		const childToolEvents = events.filter(event => event.agent_run_id === childId && event.event_type === "tool_execution_end");
		const checks = {
			artifactChecksPassed: verification?.valid === true,
			stoppedAfterSuccess,
			exactlyOneChild: children?.list().length === 1,
			childUsedBash: childToolEvents.some(event => event.payload.toolName === "bash"),
			markerInChildToolOutput: JSON.stringify(childToolEvents).includes("CHILD_BASH_ONLY_SMOKE_MARKER"),
			...contextAssessment.checks,
			developmentGuidanceExcluded: !JSON.stringify(events.filter(event => event.event_type === "prompt_snapshot")).includes("DEVELOPMENT_GUIDANCE_LIVE_SMOKE_EXCLUDED"),
			bothSessionsClosed: events.filter(event => event.event_type === "agent_run_end").length === 2,
			sharedInvocation: events.filter(event => event.event_type === "agent_run_start").every(event => event.stage_invocation_id === invocation.invocationId),
		};
		const summary = { model: model.modelId, workspace, trace: trace.localPath, invocation, checks,
			replyQuality: contextAssessment.replyQuality,
			verification, traceDegraded: trace.degraded(), traceFailures: trace.failures() };
		const summaryPath = trace.localPath.replace(/\.jsonl$/, ".summary.json");
		writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
		console.log(JSON.stringify({ event: "live_smoke_finished", summaryPath, checks, outcome: invocation.outcome, traceDegraded: trace.degraded() }));
		return invocation.outcome === "success" && Object.values(checks).every(Boolean);
	} finally { STAGE_REGISTRY.solve = originalStage; await trace.close(); }
}

function verify(python: string, cwd: string) {
	const script = `import math\nfrom metrics import balanced_accuracy as score\nchecks = [\n([0,0,0,1],[0,0,1,0],1/3),\n([0,0,1,1],[0,1,1,1],.75),\n(['a','b','c'],['a','x','c'],2/3),\n(['a','a'],['a','x'],.5),\n([0,1,2],[0,1,2],1.0),\n([0,1],[1,0],0.0),\n]\nfor y,p,expected in checks:\n assert math.isclose(score(y,p),expected), (y,p,score(y,p),expected)\nfor y,p in [([],[]),([0],[]),([],[0])]:\n try: score(y,p)\n except ValueError: pass\n else: raise AssertionError('expected ValueError')\nprint('9 independent checks passed')\n`;
	const independent = spawnSync(python, ["-c", script], { cwd, encoding: "utf8", timeout: 15_000 });
	const authored = spawnSync(python, ["-m", "unittest", "-v", "test_metrics"], { cwd, encoding: "utf8", timeout: 15_000 });
	return { valid: independent.status === 0 && authored.status === 0,
		output: [independent.stdout, independent.stderr, authored.stdout, authored.stderr].join("\n").trim() };
}

if (import.meta.main) process.exitCode = await runLiveSmoke() ? 0 : 1;
