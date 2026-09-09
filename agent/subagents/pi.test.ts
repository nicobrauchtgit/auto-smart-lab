import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { observeAgentSession, type EventRecord, type EventSink } from "../observability.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { createSubagents } from "./index.js";
import { createChildBashTool, loadChildResources } from "./pi.js";

const prompts = loadPromptSnapshot();

test("child loader includes selected common and child guidance, excluding ambient instructions", async () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-resources-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	const marker = "DEVELOPMENT_GUIDANCE_MUST_NEVER_ENTER_CHILD";
	for (const path of [join(root, "AGENTS.md"), join(cwd, "AGENTS.md"), join(cwd, "CLAUDE.md"), join(agentDir, "AGENTS.md")]) {
		writeFileSync(path, marker);
	}
	writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), marker);
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const instructions = [prompts.render("research.system", {}), prompts.render("subagents.child", {})];
		const resources = await loadChildResources({ cwd, agentDir, instructions });
		({ session } = await createAgentSession({ cwd, agentDir, ...resources,
			sessionManager: SessionManager.inMemory(cwd), tools: [] }));
		assert.doesNotMatch(session.systemPrompt, new RegExp(marker));
		for (const instruction of instructions) assert.ok(session.systemPrompt.includes(instruction.text));
		assert.equal(resources.resourceLoader.getExtensions().extensions.length, 0);
		assert.equal(resources.resourceLoader.getSkills().skills.length, 0);
	} finally { session?.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("concurrent bash tools receive separate immutable environments without process mutation", async () => {
	const before = process.env.SUBAGENT_TEST_VALUE;
	const firstEnv = { PATH: process.env.PATH, SUBAGENT_TEST_VALUE: "first" };
	const first = createChildBashTool(process.cwd(), firstEnv);
	const second = createChildBashTool(process.cwd(), { PATH: process.env.PATH, SUBAGENT_TEST_VALUE: "second" });
	firstEnv.SUBAGENT_TEST_VALUE = "mutated after construction";
	const execute = (tool: typeof first) => tool.execute("test", { command: 'printf "%s" "$SUBAGENT_TEST_VALUE"' }, undefined, undefined, undefined as never);
	const results = await Promise.all([execute(first), execute(second)]);
	assert.equal(results[0].content[0].type, "text");
	assert.deepEqual(results.map(result => result.content[0].type === "text" ? result.content[0].text : ""), ["first", "second"]);
	assert.equal(process.env.SUBAGENT_TEST_VALUE, before);
});

test("real Pi children execute tools, preserve follow-up context, and keep transcripts out of parent replies", async () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-pi-"));
	const agentDir = join(root, "agent"); mkdirSync(agentDir);
	const events: EventRecord[] = [];
	let sinkClosed = false;
	const sink: EventSink = { databaseConnected: false, failures: [],
		record: event => events.push(event), async close() { sinkClosed = true; } };
	const faux = fauxProvider({ provider: "child-test", tokensPerSecond: 1_000_000 });
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	const marker = "LARGE_CHILD_TOOL_OUTPUT";
	const contexts: string[] = [];
	faux.setResponses([
		context => {
			contexts.push(JSON.stringify(context));
			return fauxAssistantMessage(fauxToolCall("bash", { command: `printf ${marker}` }), { stopReason: "toolUse" });
		},
		context => {
			contexts.push(JSON.stringify(context));
			return fauxAssistantMessage("Implemented. See solution.py.");
		},
		context => {
			contexts.push(JSON.stringify(context));
			return fauxAssistantMessage("Reviewed. Checks passed.");
		},
	]);
	const pipelineRunId = randomUUID();
	const stageInvocationId = randomUUID();
	const parentAgentRunId = randomUUID();
	const scope = createSubagents({ cwd: root, agentDir, model: faux.getModel(), modelRuntime: runtime,
		prompts, sharedInstructions: [prompts.render("research.system", {})],
		env: { PATH: process.env.PATH }, inputs: [], parentAgentRunId,
		observe: { identity: { pipelineRunId, stageInvocationId, stage: "solve", attempt: 1 }, sink } });
	try {
		const execute = async (name: string, args: unknown) => {
			const result = await scope.tools.find(tool => tool.name === name)!
				.execute(`call-${name}`, args, undefined, undefined, undefined as never);
			assert.equal(result.content[0].type, "text");
			if (result.content[0].type !== "text") throw new Error("Expected tool text");
			return result.content[0].text;
		};
		const spawned = await execute("subagent_spawn", { task: "Implement a solution" });
		const child = JSON.parse(spawned);
		const result = await execute("subagent_wait", { id: child.logicalAgentId });
		assert.match(result, /Implemented/);
		assert.doesNotMatch(result, new RegExp(marker));
		assert.match(contexts[1], new RegExp(marker));
		assert.doesNotMatch(contexts[0], /subagent_spawn/);
		await execute("subagent_followup", { id: child.logicalAgentId, message: "Review that implementation" });
		const reviewed = await execute("subagent_wait", { id: child.logicalAgentId });
		assert.match(reviewed, /Checks passed/);
		assert.match(contexts[2], /Implemented/);
		assert.match(contexts[2], /Review that implementation/);
		assert.equal(scope.manager.list().length, 1);
		assert.ok(events.some(event => event.eventType === "tool_execution_end" && JSON.stringify(event.payload).includes(marker)));
		assert.ok(events.some(event => event.eventType === "subagent_link" && (event.payload as any).parentAgentRunId === parentAgentRunId));
		assert.ok(events.every(event => event.identity?.pipelineRunId === pipelineRunId && event.identity?.stageInvocationId === stageInvocationId));
		assert.equal(events.filter(event => event.eventType === "agent_run_start").length, 1);
		assert.equal(events.filter(event => event.eventType === "prompt_snapshot").length, 2);
	} finally { await scope.close(); rmSync(root, { recursive: true, force: true }); }
	assert.equal(events.filter(event => event.eventType === "agent_run_end").length, 1);
	assert.equal(sinkClosed, false);
});

test("an observed Pi parent can spawn and collect a child through the optional tools", async () => {
	const root = mkdtempSync(join(tmpdir(), "subagent-parent-"));
	const agentDir = join(root, "agent"); mkdirSync(agentDir);
	const events: EventRecord[] = [];
	const sink: EventSink = { databaseConnected: false, failures: [], record: event => events.push(event), async close() {} };
	const observe = { identity: { pipelineRunId: randomUUID(), stageInvocationId: randomUUID(), attempt: 2, stage: "solve" }, sink };
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	const parentProvider = fauxProvider({ provider: "test-parent", tokensPerSecond: 1_000_000 });
	const childProvider = fauxProvider({ provider: "test-child", tokensPerSecond: 1_000_000 });
	runtime.registerNativeProvider(parentProvider.provider);
	runtime.registerNativeProvider(childProvider.provider);
	childProvider.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "printf PRIVATE_CHILD_TOOL_LOG" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Implemented and checked file.py"),
	]);
	parentProvider.setResponses([
		context => {
			const names = context.tools?.map(tool => tool.name) ?? [];
			assert.ok(names.includes("subagent_spawn"));
			assert.ok(!names.includes("bash") && !names.includes("write"));
			return fauxAssistantMessage(fauxToolCall("subagent_spawn", { task: "Implement file.py" }), { stopReason: "toolUse" });
		},
		context => {
			const result = [...context.messages].reverse().find(message => message.role === "toolResult");
			assert.equal(result?.role, "toolResult");
			if (result?.role !== "toolResult" || result.content[0].type !== "text") throw new Error("Missing spawn result");
			const child = JSON.parse(result.content[0].text);
			return fauxAssistantMessage(fauxToolCall("subagent_wait", { id: child.logicalAgentId }), { stopReason: "toolUse" });
		},
		context => {
			assert.match(JSON.stringify(context.messages), /Implemented and checked/);
			assert.doesNotMatch(JSON.stringify(context.messages), /PRIVATE_CHILD_TOOL_LOG/);
			return fauxAssistantMessage("Collected the implementation result.");
		},
	]);
	const scope = createSubagents({ cwd: root, agentDir, model: childProvider.getModel(), modelRuntime: runtime,
		prompts, sharedInstructions: [], env: { PATH: process.env.PATH }, inputs: [], observe });
	let parent: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	let observer: Awaited<ReturnType<typeof observeAgentSession>> | undefined;
	try {
		assert.throws(() => scope.manager, /Bind the observed parent/);
		const resources = await loadChildResources({ cwd: root, agentDir, instructions: [scope.parentInstructions] });
		({ session: parent } = await createAgentSession({ cwd: root, agentDir, ...resources,
			model: parentProvider.getModel(), modelRuntime: runtime,
			sessionManager: SessionManager.inMemory(root), tools: scope.tools.map(tool => tool.name), customTools: scope.tools }));
		observer = await observeAgentSession({ session: parent, model: "test-parent/faux", ...observe });
		scope.bindParent(observer.agentRunId);
		assert.throws(() => scope.bindParent(randomUUID()), /already has a parent/);
		await parent.prompt("Delegate the implementation and collect its result.");
		assert.equal(parent.getLastAssistantText(), "Collected the implementation result.");
		assert.equal(scope.manager.list()[0].parentAgentRunId, observer.agentRunId);
		assert.notEqual(scope.manager.list()[0].agentRunId, observer.agentRunId);
	} finally {
		try { await scope.close(); }
		finally { await observer?.close(); parent?.dispose(); rmSync(root, { recursive: true, force: true }); }
	}
	assert.equal(events.filter(event => event.eventType === "agent_run_end").length, 2);
});
