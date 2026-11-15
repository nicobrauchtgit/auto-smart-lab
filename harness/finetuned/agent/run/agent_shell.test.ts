/**
 * Every agent shell call is supervised: the v2 P6 check end to end, machine
 * protection across shell calls and trials, one report per finding without a
 * kill, and the wiring that leaves no unsupervised bash tool.
 */
import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, createBashToolDefinition, defineTool, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";

import { agentBashTool, assertSupervisedBash, bindAgentShells, closeAgentShells, hostShell, isAgentShellTool, sandboxShell, type AgentShell } from "./agent_shell.js";
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
	const records = readdirSync(join(root, "shell-calls"))
		.filter((id) => existsSync(join(root, "shell-calls", id, "experiment.json")))
		.map((id) => JSON.parse(readFileSync(join(root, "shell-calls", id, "experiment.json"), "utf8")));
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

const SANDBOX_PATH = ["/run/current-system/sw/bin", "/usr/bin", "/bin"].join(":");

test.skipIf(!bubblewrap)("a sandboxed session's bash is supervised with the sandbox as its process", async () => {
	const root = workspace("sandboxed-shell-"), logs = workspace("sandboxed-shell-logs-");
	const policy = sandboxPolicy({ mounts: [{ source: root, writable: true }], cwd: root, env: { PATH: SANDBOX_PATH } });
	const bash = isolatedSolveTools(policy, { root: logs }).find((tool) => tool.name === "bash")!;
	expect(isAgentShellTool(bash)).toBe(true);
	const result = text(await bash.execute("sandboxed", { command: `test ! -e /home && test ! -e ${logs} && echo "isolated $PYTHONUNBUFFERED"` }, undefined, undefined, undefined as never));
	expect(result).toContain("isolated 1");
	// The supervised process is the sandbox launcher; its records stay with the harness, outside the sandbox.
	const [id] = readdirSync(logs);
	const record = JSON.parse(readFileSync(join(logs, id, "experiment.json"), "utf8"));
	expect(record.argv[0]).toBe(policy.executable);
	expect(record.argv).toContain("--unshare-all");
	// The agent reads a copy of the full output in its workspace, named in the result.
	const copy = join(root, ".shell-calls", `${id}.log`);
	expect(readdirSync(join(root, ".shell-calls"))).toEqual([`${id}.log`]);
	expect(readFileSync(copy, "utf8")).toBe("isolated 1\n");
	expect(result).toContain(`full output: ${copy}`);
}, 30_000);

test.skipIf(!bubblewrap)("a sandboxed shell's log root may not overlap a writable mount", async () => {
	const root = workspace("sandboxed-overlap-");
	const policy = sandboxPolicy({ mounts: [{ source: root, writable: true }], cwd: root, env: { PATH: SANDBOX_PATH } });
	for (const logs of [join(root, "logs"), dirname(root)]) {
		const bash = isolatedSolveTools(policy, { root: logs }).find((tool) => tool.name === "bash")!;
		await expect(bash.execute("overlap", { command: "true" }, undefined, undefined, undefined as never)).rejects.toThrow("harness-owned");
	}
});

/**
 * The attack: a sandboxed call replaces its own log (where the old layout kept
 * it, in the agent's workspace), every copy it can see, and the copy folder
 * itself with symlinks to a host file its sandbox does not mount. Neither the
 * call's result, nor a later call's, nor any finding, nor a copy the harness
 * writes may contain that file's content, and the file is never written.
 */
test.skipIf(!bubblewrap)("a sandboxed call that swaps its logs and copies for symlinks to a host-only file never sees that file", async () => {
	const root = workspace("sandboxed-symlink-"), logs = workspace("sandboxed-symlink-logs-"), hidden = workspace("withheld-");
	const marker = `WITHHELD_LABELS_${Date.now()}_${Math.random().toString(36).slice(2)}`;
	const secret = join(hidden, "labels.csv");
	writeFileSync(secret, `id,label\n1,${marker}\n`);
	const policy = sandboxPolicy({ mounts: [{ source: root, writable: true }], cwd: root, env: { PATH: SANDBOX_PATH } });
	const { session, steered } = owner();
	const records: { eventType: string; payload: Record<string, unknown> }[] = [];
	const bash = agentBashTool({ ...sandboxShell(policy, { root: logs }), limits: { sampleIntervalMs: 25, stopGraceMs: 100, minStallMs: 250, importPreludeMs: 250 } });
	bindAgentShells([bash], { session, prompts, record: (eventType, payload) => records.push({ eventType, payload }) });
	closers.push(() => closeAgentShells([bash]));
	const run = async (command: string) => text(await bash.execute("call", { command }, undefined, undefined, undefined as never));

	const first = await run("echo first-call");
	expect(first).toContain("first-call");
	// Inside the sandbox the host file and the harness's logs do not exist.
	expect(await run(`test ! -e ${secret} && test ! -e ${logs} && echo hidden`)).toContain("hidden");
	// Replace the newest call folder's log (the old layout's own log), every copy, then the copy folder itself.
	const swap = [
		`d=$(ls -td .shell-calls/*/ 2>/dev/null | head -1); if [ -n "$d" ]; then rm -f "$d/output.log" "$d/command.json"; ln -s ${secret} "$d/output.log"; ln -s ${secret} "$d/command.json"; fi`,
		`for f in .shell-calls/*.log; do rm -f "$f"; ln -s ${secret} "$f"; done`,
		"echo swapped; sleep 0.6; echo after-swap",
	].join("; ");
	const second = await run(swap);
	expect(second).toContain("swapped");
	expect(second).toContain("after-swap");
	const third = await run(`mv .shell-calls .shell-calls-moved && ln -s ${hidden} .shell-calls && sleep 0.4 && echo folder-swapped`);
	expect(third).toContain("folder-swapped");
	const fourth = await run("cat .shell-calls/*.log 2>&1; echo done");
	expect(fourth).toContain("done");

	for (const result of [first, second, third, fourth]) expect(result).not.toContain(marker);
	// Every finding delivered to the session (the 0.6 s silence is reported as stalled).
	expect(steered.join("\n")).not.toContain(marker);
	// No copy the harness wrote holds the file, and the file was never written through a symlink.
	const copies = readdirSync(join(root, ".shell-calls-moved"));
	for (const name of copies) {
		const path = join(root, ".shell-calls-moved", name);
		if (lstatSync(path).isSymbolicLink()) continue; // the agent's own symlinks, which the harness never reads
		expect(readFileSync(path, "utf8")).not.toContain(marker);
	}
	expect(readdirSync(hidden)).toEqual(["labels.csv"]);
	expect(readFileSync(secret, "utf8")).toBe(`id,label\n1,${marker}\n`);
	// The swapped call's copy is a regular file with its real output.
	const swapped = copies.filter((name) => !lstatSync(join(root, ".shell-calls-moved", name)).isSymbolicLink());
	expect(swapped.map((name) => readFileSync(join(root, ".shell-calls-moved", name), "utf8")).join("")).toContain("after-swap");
	// With the copy folder a symlink, the copy is refused, not written into the host folder.
	expect(records.some((record) => record.eventType === "experiment_spill_failed")).toBe(true);
	// The harness's own logs are regular files outside the sandbox.
	for (const id of readdirSync(logs)) expect(lstatSync(join(logs, id, "output.log")).isFile()).toBe(true);
}, 60_000);
