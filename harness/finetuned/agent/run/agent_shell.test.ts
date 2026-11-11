/**
 * Every agent shell call is supervised: the v2 P6 check end to end, machine
 * protection across shell calls and trials, one report per finding without a
 * kill, and the wiring that leaves no unsupervised bash tool.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, createBashToolDefinition, defineTool, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import { agentBashTool, assertSupervisedBash, bindAgentShells, hostShell, isAgentShellTool, type AgentShell } from "./agent_shell.js";
import { findBubblewrap, isolatedSolveTools, sandboxPolicy } from "./solve_sandbox.js";
import { runSession, sessionBashTool } from "./session_runner.js";
import { createChildBashTool, loadChildResources } from "../subagents/pi.js";
import { ExperimentSupervisor } from "../experiments/supervisor.js";
import { MachineProtection } from "../experiments/protection.js";
import { HARNESS_CONFIG } from "../harness/config.js";
import { processIdentity } from "../experiments/ownership.js";
import type { Wakeable } from "../experiments/index.js";
import type { SupervisorLimits } from "../experiments/types.js";
import { loadPromptSnapshot } from "../prompts/loader.js";

const prompts = loadPromptSnapshot();
const linux = process.platform === "linux";
const roots: string[] = [];
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close().catch(() => undefined)));
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
const text = (result: { content: { type: string; text?: string }[] }) => result.content.map((item) => item.text ?? "").join("\n");
const reading = (availableBytes: number) => ({ availableBytes, totalBytes: 16e9, swapTotalBytes: 0, swapFreeBytes: 0 });
/** A script that holds `mib` MiB, says so, then waits `ms`. */
function holdScript(root: string, name: string, mib: number, ms = 60_000): string {
	const path = join(root, `${name}.ts`);
	writeFileSync(path, `const memory = new Uint8Array(${mib} * 1024 * 1024).fill(1);\nconsole.log("holding ${name}");\nawait Bun.sleep(${ms});\nconsole.log(memory.length);\n`);
	return `"${process.execPath}" "${path}"`;
}
/** Everything the shell calls under `root` have printed so far. */
function shellOutput(root: string): string {
	const calls = join(root, "shell-calls");
	if (!existsSync(calls)) return "";
	return readdirSync(calls, { recursive: true }).map(String).filter((path) => path.endsWith("output.log"))
		.map((path) => { try { return readFileSync(join(calls, path), "utf8"); } catch { return ""; } }).join("");
}
function shell(root: string, extra: Partial<AgentShell> = {}, limits: Partial<SupervisorLimits> = {}): AgentShell {
	return { ...hostShell(root, { PATH: process.env.PATH! }, join(root, "shell-calls")),
		limits: { sampleIntervalMs: 25, stopGraceMs: 100, ...limits }, ...extra };
}
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

test.skipIf(!linux)("P6: an agent shell call that pushes RAM below the reserve is stopped, its session is told, and the session continues", async () => {
	const root = workspace("p6-");
	const agentDir = join(root, "agent-dir"); mkdirSync(agentDir);
	let pressure = false;
	const guard = new MachineProtection(HARNESS_CONFIG.supervision, () => reading(pressure ? 0 : 64e9));
	const tool = agentBashTool(shell(root, { protection: guard }));
	const faux = fauxProvider({ provider: "p6-test", tokensPerSecond: 1_000_000 });
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
	runtime.registerNativeProvider(faux.provider);
	const contexts: string[] = [];
	const big = holdScript(root, "big", 64);
	faux.setResponses([
		() => {
			// The machine runs short once the script holds its memory.
			void until(() => shellOutput(root).includes("holding big")).then(() => Bun.sleep(200)).then(() => { pressure = true; });
			return fauxAssistantMessage(fauxToolCall("bash", { command: big }), { stopReason: "toolUse" });
		},
		(context) => {
			contexts.push(JSON.stringify(context));
			pressure = false;
			return fauxAssistantMessage(fauxToolCall("bash", { command: "echo next-call-ran" }), { stopReason: "toolUse" });
		},
		(context) => {
			contexts.push(JSON.stringify(context));
			return fauxAssistantMessage("done");
		},
	]);
	const resources = await loadChildResources({ cwd: root, agentDir, instructions: [] });
	const { session } = await createAgentSession({ cwd: root, agentDir, model: faux.getModel(), modelRuntime: runtime,
		...resources, sessionManager: SessionManager.inMemory(root), tools: ["bash"], customTools: [tool] });
	closers.push(async () => session.dispose());
	const steered: string[] = [];
	const spy: Wakeable = {
		get isStreaming() { return session.isStreaming; },
		steer: async (message) => { steered.push(message); await session.steer(message); },
		sendCustomMessage: async (message, options) => { steered.push(message.content); await session.sendCustomMessage(message, options); },
	};
	expect(bindAgentShells([tool], { session: spy, prompts })).toBe(1);
	await session.prompt("Run the experiment.");
	// The owner session was told, through the session itself.
	const told = steered.filter((message) => message.includes("this experiment was too big for the machine"));
	expect(told).toHaveLength(1);
	expect(told[0]).toMatch(/^\[experiment \S+\] machine-at-risk/);
	expect(contexts[0]).toContain("this experiment was too big for the machine");
	// The session continued: its next shell call ran and it finished its turn.
	expect(contexts[1]).toContain("next-call-ran");
	expect(contexts).toHaveLength(2);
	// Nothing of the stopped call survives.
	const records = readdirSync(join(root, "shell-calls")).flatMap((call) => readdirSync(join(root, "shell-calls", call))
		.filter((id) => existsSync(join(root, "shell-calls", call, id, "experiment.json")))
		.map((id) => JSON.parse(readFileSync(join(root, "shell-calls", call, id, "experiment.json"), "utf8"))));
	expect(records).toHaveLength(2);
	for (const record of records) expect(processIdentity(record.pid)?.state ?? "gone").toMatch(/gone|Z/);
}, 60_000);

test.skipIf(!linux)("machine protection chooses between agent shell calls and harness trials by size", async () => {
	for (const shellIsLarger of [true, false]) {
		const root = workspace("shell-vs-trial-");
		let pressure = false, freed = () => false;
		const guard = new MachineProtection(HARNESS_CONFIG.supervision, () => reading(pressure && !freed() ? 0 : 64e9));
		const trials = new ExperimentSupervisor({ root: join(root, "trials"), env: { PATH: process.env.PATH! }, protection: guard,
			deliver: () => undefined, limits: { sampleIntervalMs: 25, stopGraceMs: 100 } });
		closers.push(() => trials.close());
		const trial = trials.start({ cwd: root, argv: ["bash", "-c", holdScript(root, "trial", shellIsLarger ? 2 : 96)], scope: "fixture", hypothesis: "trial" });
		const { session, kinds } = owner();
		const tool = agentBashTool(shell(root, { protection: guard }));
		bindAgentShells([tool], { session, prompts });
		const call = tool.execute("call", { command: holdScript(root, "shell", shellIsLarger ? 96 : 2, 3_000) }, undefined, undefined, undefined as never);
		await until(() => trials.output(trial.id).text.includes("holding") && shellOutput(root).includes("holding shell"));
		await Bun.sleep(200);
		freed = shellIsLarger ? () => kinds().includes("machine-at-risk") : () => trials.status(trial.id).status !== "running";
		pressure = true;
		const result = text(await call);
		if (shellIsLarger) {
			expect(result).toContain("this experiment was too big for the machine");
			expect(kinds()).toContain("machine-at-risk");
			expect(trials.status(trial.id).status).toBe("running");
		} else {
			expect(result).toContain("holding shell");
			expect(result).toContain("exit code: 0");
			expect(kinds()).not.toContain("machine-at-risk");
			expect(trials.status(trial.id).status).toBe("stopped");
		}
		await trials.close();
	}
}, 60_000);

test.skipIf(!linux).each([
	["stalled", "sleep 30", {}],
	["stale", `"${process.execPath}" -e 'for (let i = 0; i < 6; i++) { console.log("epoch " + i); await Bun.sleep(80); } while (true) Math.sqrt(Math.random());'`, {}],
	["flooding", "head -c 20000 /dev/zero | tr '\\0' x; echo; sleep 30", { outputCapBytes: 4_096, minStallMs: 60_000 }],
] as const)("an agent shell call that is %s produces exactly one report and no kill", async (kind, command, limits) => {
	const root = workspace(`shell-${kind}-`);
	const { session, kinds } = owner();
	const tool = agentBashTool(shell(root, {}, { minStallMs: 250, importPreludeMs: 250, ...limits }));
	bindAgentShells([tool], { session, prompts });
	const abort = new AbortController();
	let settled = false;
	const call = tool.execute("call", { command }, abort.signal, undefined, undefined as never).finally(() => { settled = true; });
	call.catch(() => undefined);
	await until(() => kinds().includes(kind));
	await Bun.sleep(500);
	expect(kinds()).toEqual([kind]);
	// The report did not end the call: it is still running.
	expect(settled).toBe(false);
	abort.abort();
	// Cancelling the owning session ends the call.
	await call.catch(() => undefined);
}, 30_000);

test("every agent bash tool is supervised, and an unsupervised one is refused", async () => {
	const root = workspace("wiring-");
	const raw = defineTool(createBashToolDefinition(root));
	expect(() => assertSupervisedBash([raw])).toThrow("agentBashTool");
	const session = sessionBashTool(root, { PATH: process.env.PATH! }, join(root, "session"));
	const child = createChildBashTool(root, { PATH: process.env.PATH }, join(root, "child"));
	expect(isAgentShellTool(session)).toBe(true);
	expect(isAgentShellTool(child)).toBe(true);
	expect(() => assertSupervisedBash([session, child, { name: "read" }])).not.toThrow();
	// The shared session runner refuses an unsupervised bash before anything starts.
	await expect(runSession({ prompts, system: prompts.render("subagents.child", {}), promptReferences: [], prompt: "x", tools: ["bash"], customTools: [raw] }))
		.rejects.toThrow("agentBashTool");
	// Findings before a session exists join its next turn instead of being lost.
	const tool = agentBashTool(shell(root, {}, { minStallMs: 250, importPreludeMs: 250 }));
	const abort = new AbortController();
	const call = tool.execute("early", { command: "sleep 30" }, abort.signal, undefined, undefined as never);
	call.catch(() => undefined);
	await Bun.sleep(900);
	const { session: late, steered } = owner();
	expect(bindAgentShells([raw, tool], { session: late, prompts })).toBe(1);
	await until(() => steered.length > 0);
	expect(steered[0]).toMatch(/^\[experiment \S+\] stalled/);
	abort.abort();
	// Cancelling the owning session ends the call.
	await call.catch(() => undefined);
}, 20_000);

let bubblewrap = false;
try { findBubblewrap(); bubblewrap = true; } catch { bubblewrap = false; }

test.skipIf(!bubblewrap)("a sandboxed session's bash is supervised with the sandbox as its process", async () => {
	const root = workspace("sandboxed-shell-");
	const policy = sandboxPolicy({ mounts: [{ source: root, writable: true }], cwd: root,
		env: { PATH: ["/run/current-system/sw/bin", "/usr/bin", "/bin"].join(":") } });
	const bash = isolatedSolveTools(policy).find((tool) => tool.name === "bash")!;
	expect(isAgentShellTool(bash)).toBe(true);
	const result = text(await bash.execute("sandboxed", { command: `test ! -e /home && echo "isolated $PYTHONUNBUFFERED"` }, undefined, undefined, undefined as never));
	expect(result).toContain("isolated 1");
	// The supervised process is the sandbox launcher, and its output is inside the agent's workspace.
	const calls = join(root, ".shell-calls");
	const [call] = readdirSync(calls);
	const [id] = readdirSync(join(calls, call));
	const record = JSON.parse(readFileSync(join(calls, call, id, "experiment.json"), "utf8"));
	expect(record.argv[0]).toBe(policy.executable);
	expect(record.argv).toContain("--unshare-all");
}, 30_000);
