/**
 * Review round 3 of the agent shell: a call returns when its command ends and
 * leaves what it backgrounded tracked, `timeout` stops the tree, findings
 * reach the agent through a real session, a wrapped supervised bash (stream
 * C's scout runner wraps every tool) is accepted and bound as a replacement,
 * nothing escapes a sandboxed call, and the sandbox worker has no raw shell.
 */
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, createBashToolDefinition, defineTool, ModelRuntime, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { agentBashTool, bindAgentShells, closeAgentShells, hostShell, isAgentShellTool, replaceToolsByName, wrapAgentTool, type AgentShell } from "./agent_shell.js";
import { findBubblewrap, isolatedSolveTools, sandboxPolicy } from "./solve_sandbox.js";
import { createPiChildFactory, loadChildResources } from "../subagents/pi.js";
import { processIdentity } from "../experiments/ownership.js";
import type { Wakeable } from "../experiments/index.js";
import type { SupervisorLimits } from "../experiments/types.js";
import type { ObservationTelemetry } from "../observability.js";
import { loadPromptSnapshot } from "../prompts/loader.js";

const prompts = loadPromptSnapshot();
const linux = process.platform === "linux";
const roots: string[] = [];
const tools: object[] = [];
const strays: number[] = [];
afterEach(async () => {
	await closeAgentShells(tools.splice(0));
	for (const pid of strays.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function workspace(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}
const until = async (predicate: () => boolean, timeoutMs = 15_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) { if (predicate()) return; await Bun.sleep(20); }
	throw new Error("condition did not become true");
};
const alive = (pid: number) => { const identity = processIdentity(pid); return !!identity && !["Z", "X"].includes(identity.state); };
const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((item) => item.text ?? "").join("\n");
const fast = { sampleIntervalMs: 25, stopGraceMs: 200 };
function shell(root: string, limits: Partial<SupervisorLimits> = {}): AgentShell {
	return { ...hostShell(root, { PATH: process.env.PATH! }, join(root, "shell-calls")), limits: { ...fast, ...limits } };
}
function tool(root: string, limits: Partial<SupervisorLimits> = {}): ToolDefinition {
	const made = agentBashTool(shell(root, limits));
	tools.push(made);
	return made;
}
const run = (bash: ToolDefinition, args: { command: string; timeout?: number }, signal?: AbortSignal) =>
	bash.execute(`call-${randomUUID().slice(0, 6)}`, args, signal, undefined, undefined as never);
/** An owner session that is mid-turn, as during a blocking tool call. */
function owner() {
	const steered: string[] = [];
	const session: Wakeable = {
		isStreaming: true,
		async steer(message) { steered.push(message); },
		async sendCustomMessage(message) { steered.push(message.content); },
	};
	return { session, steered, kinds: () => steered.map((message) => message.match(/^\[experiment \S+\] (\S+)/)?.[1]) };
}

test.skipIf(!linux)("`sleep 30 &` returns promptly and reports a background process that stays tracked until stopped", async () => {
	const root = workspace("background-");
	const bash = tool(root, { minStallMs: 250, importPreludeMs: 250 });
	const { session, kinds } = owner();
	bindAgentShells([bash], { session, prompts });
	const started = Date.now();
	const result = await run(bash, { command: "sleep 30 & echo started" });
	expect(Date.now() - started).toBeLessThan(3_000);
	const body = text(result);
	const pids = (result.details as { remainingPids: number[] }).remainingPids;
	expect(pids).toHaveLength(1);
	strays.push(...pids);
	expect(body).toContain("started\n");
	expect(body).toContain("exit code: 0");
	expect(body).toContain(`1 process(es) this command started are still running: PIDs ${pids[0]}. They stay tracked:`);
	expect(body).toContain(`Stop them with \`kill ${pids[0]}\``);
	expect(alive(pids[0])).toBe(true);
	// Still under the supervisor after the call: a finding about it reaches the owner.
	await until(() => kinds().includes("stalled"));
	// Stopped as the agent was told, the run finishes and nothing more is reported.
	process.kill(pids[0], "SIGTERM");
	await until(() => !alive(pids[0]));
	// Another call that leaves something behind is stopped when the session's tools close.
	const second = await run(bash, { command: "setsid sleep 30 >/dev/null 2>&1 < /dev/null &" });
	const left = (second.details as { remainingPids: number[] }).remainingPids;
	expect(left).toHaveLength(1);
	strays.push(...left);
	await closeAgentShells([bash]);
	expect(alive(left[0])).toBe(false);
	// A closed tool starts afresh on its next call.
	expect(text(await run(bash, { command: "echo again" }))).toContain("again");
}, 30_000);

test.skipIf(!linux)("`timeout: 1` on a hang returns at about one second with the whole tree stopped", async () => {
	const root = workspace("timeout-");
	const bash = tool(root);
	const started = Date.now();
	const result = await run(bash, { command: "sleep 300 & echo $!; sleep 301", timeout: 1 });
	const elapsed = Date.now() - started;
	expect(elapsed).toBeGreaterThanOrEqual(1_000);
	expect(elapsed).toBeLessThan(2_500);
	const body = text(result);
	const child = Number(body.split("\n")[0]);
	strays.push(child);
	expect(body).toContain("stopped: timed out after 1 s; the command and every process it started were stopped");
	expect(body).not.toContain("still running");
	expect((result.details as { timedOut: boolean; status: string }).timedOut).toBe(true);
	expect((result.details as { status: string }).status).toBe("stopped");
	expect(alive(child)).toBe(false);
	const records = readdirSync(join(root, "shell-calls")).map((id) => JSON.parse(readFileSync(join(root, "shell-calls", id, "experiment.json"), "utf8")));
	for (const record of records) expect(alive(record.pgid)).toBe(false);
}, 20_000);

/** A faux model that calls bash once with `command`, then records the next context. */
async function fauxSession(name: string, command: string) {
	const faux = fauxProvider({ provider: name, tokensPerSecond: 1_000_000 });
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	const contexts: string[] = [];
	faux.setResponses([
		() => fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
		(context) => { contexts.push(JSON.stringify(context)); return fauxAssistantMessage("done"); },
	]);
	return { faux, runtime, contexts };
}

test.skipIf(!linux)("a finding raised during a call reaches the agent with the result", async () => {
	const root = workspace("finding-in-call-");
	const agentDir = join(root, "agent-dir"); mkdirSync(agentDir);
	const bash = tool(root, { minStallMs: 250, importPreludeMs: 250 });
	const { faux, runtime, contexts } = await fauxSession("finding-test", "sleep 1.5; echo slept");
	const resources = await loadChildResources({ cwd: root, agentDir, instructions: [] });
	const { session } = await createAgentSession({ cwd: root, agentDir, model: faux.getModel(), modelRuntime: runtime,
		...resources, sessionManager: SessionManager.inMemory(root), tools: ["bash"], customTools: [bash] });
	try {
		bindAgentShells([bash], { session, prompts });
		await session.prompt("Run it.");
		expect(contexts).toHaveLength(1);
		// The model call after the tool result carries both the result and the finding.
		expect(contexts[0]).toContain("slept");
		expect(contexts[0]).toMatch(/\[experiment \S+\] stalled/);
	} finally { session.dispose(); }
}, 30_000);

test.skipIf(!linux)("a C-style wrapped supervised bash passed as a replacement is accepted, bound, and its findings reach the child", async () => {
	const root = workspace("wrapped-replacement-");
	const agentDir = join(root, "agent-dir"); mkdirSync(agentDir);
	const original = tool(root, { minStallMs: 250, importPreludeMs: 250 });
	let executions = 0;
	// Stream C's trackScoutTools: every tool copied into a wrapper by object spread.
	const spread = { ...original, execute(...args: Parameters<ToolDefinition["execute"]>) { executions++; return original.execute(...args); } } as ToolDefinition;
	const helper = wrapAgentTool(original, (execute) => (...args) => { executions++; return execute(...args); });
	expect(isAgentShellTool(spread)).toBe(true);
	expect(isAgentShellTool(helper)).toBe(true);
	// The brand cannot be forged onto a raw shell, and a raw replacement is refused before any child starts.
	const raw = defineTool(createBashToolDefinition(root));
	expect(isAgentShellTool({ ...raw, ...Object.fromEntries(Object.entries(raw)) })).toBe(false);
	const base = { cwd: root, agentDir, prompts, sharedInstructions: [], env: { PATH: process.env.PATH }, inputs: [] };
	const sink: ObservationTelemetry = { failures: [], record() {}, async close() {} };
	const observe = { identity: { pipelineRunId: "p", stageInvocationId: "s", stage: "solve", attempt: 1 }, telemetry: sink };
	for (const wrapper of [spread, helper]) {
		const { faux, runtime, contexts } = await fauxSession(`wrapped-${executions}`, "sleep 1.5; echo wrapped-ran");
		expect(() => createPiChildFactory({ ...base, model: faux.getModel(), modelRuntime: runtime, observe, customTools: [raw] })).toThrow("agentBashTool");
		const factory = createPiChildFactory({ ...base, model: faux.getModel(), modelRuntime: runtime, observe, customTools: [wrapper] });
		const child = await factory({ logicalAgentId: randomUUID(), parentAgentRunId: "parent", spawnToolCallId: "spawn" }, new AbortController().signal);
		try {
			const before = executions;
			await child.prompt(prompts.render("subagents.start", { task: "Run it." }));
			// The replacement ran (not a built-in bash), and its finding reached the child's next model call.
			expect(executions).toBe(before + 1);
			expect(contexts[0]).toContain("wrapped-ran");
			expect(contexts[0]).toMatch(/\[experiment \S+\] stalled/);
		} finally { await child.close(); }
	}
	// The final set replaces by name: the wrapper, not the default.
	const defaults = [{ name: "read" }, { name: "bash", marker: "default" }];
	expect(replaceToolsByName(defaults, [{ name: "bash", marker: "wrapper" }])).toEqual([{ name: "read" }, { name: "bash", marker: "wrapper" }]);
}, 60_000);

let bubblewrap = false;
try { findBubblewrap(); bubblewrap = true; } catch { bubblewrap = false; }

test.skipIf(!bubblewrap)("nothing a sandboxed call starts outlives it: detached descendants end with its PID namespace", async () => {
	const root = workspace("sandbox-escape-");
	const policy = sandboxPolicy({ mounts: [{ source: root, writable: true }], cwd: root,
		env: { PATH: ["/run/current-system/sw/bin", "/usr/bin", "/bin"].join(":") } });
	const bash = isolatedSolveTools(policy).find((candidate) => candidate.name === "bash")!;
	tools.push(bash);
	const marker = `escape-${randomUUID()}`;
	const started = Date.now();
	const result = await run(bash, { command: `setsid bash -c 'sleep 30; echo ${marker}' >/dev/null 2>&1 < /dev/null & (sleep 31; echo ${marker}) & echo launched` });
	expect(Date.now() - started).toBeLessThan(5_000);
	expect(text(result)).toContain("launched");
	expect(text(result)).not.toContain("still running");
	await Bun.sleep(200);
	// No host process carries the marker: the sandbox's init ended them all.
	const survivors = readdirSync("/proc").filter((name) => /^\d+$/.test(name)).filter((pid) => {
		try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(marker); } catch { return false; }
	});
	expect(survivors).toEqual([]);
}, 30_000);

test("the sandbox worker has no shell: a bash request is refused", () => {
	const worker = resolve(import.meta.dir, "solve_tool_worker.ts");
	for (const name of ["bash", "constructor", "__proto__"]) {
		const result = spawnSync(process.execPath, [worker], { input: JSON.stringify({ name, id: "x", params: { command: "echo reached" }, cwd: tmpdir() }), encoding: "utf8" });
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("Unknown isolated tool");
		expect(result.stdout).not.toContain("reached");
	}
});
