/**
 * Review round 2: stops that leave nothing behind, protection that never
 * repeats a victim, warnings before stops, a ceiling on busy silence, state that
 * survives a reattach, and capped reads that never split a character.
 */
import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExperimentSupervisor } from "./supervisor.js";
import { MachineProtection } from "./protection.js";
import { HARNESS_CONFIG, parseHarnessConfig } from "../harness/config.js";
import { birthOf, confirmedTargets, ownedMembers, processIdentity, sameProcessAlive, type ProcessIdentity } from "./ownership.js";
import { linuxProcesses, type MachineSample } from "./sampler.js";
import type { ExperimentRecord, SupervisorLimits, Update } from "./types.js";
import { COMMAND_STATUS_FILE, readCommandStatus } from "./launcher.js";

const linux = process.platform === "linux";
const roots: string[] = [];
const supervisors: ExperimentSupervisor[] = [];
const strays: number[] = [];
afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.close()));
	for (const pid of strays.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function workspace(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}
const until = async (predicate: () => boolean, timeoutMs = 10_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) { if (predicate()) return; await Bun.sleep(20); }
	throw new Error("condition did not become true");
};
function supervisor(root: string, options: { protection?: MachineProtection; limits?: Partial<SupervisorLimits>; kill?: (pid: number, signal: NodeJS.Signals) => void } = {}) {
	const updates: Update[] = [];
	const created = new ExperimentSupervisor({ root, env: { PATH: process.env.PATH! },
		deliver: (_, update) => { updates.push(update); }, ...options,
		limits: { sampleIntervalMs: 25, stopGraceMs: 100, ...options.limits } });
	supervisors.push(created);
	return { supervisor: created, updates };
}
/** The command's own PID, as the launcher records it (the run's group is led by the launcher). */
const pidOf = (root: string, id: string) => {
	const deadline = Date.now() + 5_000;
	for (;;) {
		const status = readCommandStatus(join(root, id, COMMAND_STATUS_FILE));
		if (status) return status.pid;
		if (Date.now() > deadline) throw new Error("the launcher recorded no command");
		Bun.sleepSync(5);
	}
};
const launcherOf = (root: string, id: string) => JSON.parse(readFileSync(join(root, id, "experiment.json"), "utf8")).pid as number;
const alive = (pid: number) => { const identity = processIdentity(pid); return !!identity && !["Z", "X"].includes(identity.state); };
const reading = (availableBytes: number): MachineSample => ({ availableBytes, totalBytes: 16e9, swapTotalBytes: 0, swapFreeBytes: 0 });
const holding = (mib: number) => [process.execPath, "-e", `const memory = new Uint8Array(${mib} * 1024 * 1024).fill(1); console.log("holding"); await Bun.sleep(60_000); console.log(memory.length)`];

test.skipIf(!linux)("a stop whose leader already exited still ends the group and reports stopped only once nothing remains", async () => {
	const root = workspace("exited-leader-");
	const { supervisor: owner } = supervisor(root);
	const view = owner.start({ argv: ["bash", "-c", "sleep 30 & echo $!"], cwd: root, hypothesis: "leader exits", scope: "fixture" });
	const leader = pidOf(root, view.id);
	await until(() => owner.output(view.id).text.trim().length > 0 && !alive(leader));
	const worker = Number(owner.output(view.id).text.trim());
	strays.push(worker);
	expect(alive(worker)).toBe(true);
	// The group outlives its leader, so the run is still running.
	expect(owner.status(view.id).status).toBe("running");
	const stopped = await owner.stop(view.id, "too big");
	expect(stopped.status).toBe("stopped");
	expect(alive(worker)).toBe(false);
	expect(JSON.parse(readFileSync(join(root, view.id, "supervisor-state.json"), "utf8")).status).toBe("stopped");
}, 20_000);

test.skipIf(!linux)("a setsid descendant stays tracked after its parent has gone, and the stop ends it", async () => {
	const root = workspace("escaped-");
	const { supervisor: owner } = supervisor(root);
	// The descendant leaves the group, then its parent exits: no group or parent link remains.
	const view = owner.start({ argv: ["bash", "-c", "setsid sleep 30 & echo $!; sleep 0.5"], cwd: root, hypothesis: "escape", scope: "fixture" });
	const leader = pidOf(root, view.id);
	await until(() => owner.output(view.id).text.trim().length > 0);
	const escaped = Number(owner.output(view.id).text.trim());
	strays.push(escaped);
	await until(() => !alive(leader));
	await Bun.sleep(100);
	expect(processIdentity(escaped)?.pgid).not.toBe(leader);
	expect(owner.status(view.id).status).toBe("running");
	// Persisted by birth identity, so a restarted harness still knows it.
	const members = JSON.parse(readFileSync(join(root, view.id, "supervisor-state.json"), "utf8")).members as ProcessIdentity[];
	expect(members.map((member) => member.pid)).toContain(escaped);
	expect((await owner.stop(view.id, "too big")).status).toBe("stopped");
	expect(alive(escaped)).toBe(false);
}, 20_000);

test.skipIf(!linux)("a scan entry whose PID was reused since the scan is never a stop target", () => {
	const own = linuxProcesses().find((p) => p.pid === process.pid)!;
	expect(confirmedTargets([own]).map((target) => target.pid)).toEqual([process.pid]);
	// The enumerated birth differs from the PID's current one: a different process.
	expect(confirmedTargets([{ ...own, startTicks: own.startTicks + 1 }])).toEqual([]);
	// A tracked identity whose birth no longer matches is dropped, not adopted.
	const stale: ProcessIdentity = { pid: own.pid, pgid: own.pgid, birth: birthOf(own.startTicks + 1), state: "R" };
	expect(ownedMembers(-1, [own], [stale], false).members).toEqual([]);
	expect(ownedMembers(-1, [own], [{ ...stale, birth: birthOf(own.startTicks) }], false).members.map((p) => p.pid)).toEqual([own.pid]);
	expect(sameProcessAlive(stale)).toBe(false);
});

test.skipIf(!linux)("machine protection never stops the same victim twice; an unkillable one is passed over for the next largest", async () => {
	const root = workspace("unkillable-");
	let pressure = false;
	const guard = new MachineProtection(HARNESS_CONFIG.supervision, () => reading(pressure ? 0 : 8e9));
	// Signals to the large run are lost, as for a process that cannot be killed.
	const large = supervisor(join(root, "large"), { protection: guard, kill: () => undefined });
	const small = supervisor(join(root, "small"), { protection: guard });
	const big = large.supervisor.start({ cwd: root, argv: holding(96), scope: "fixture", hypothesis: "large" });
	const little = small.supervisor.start({ cwd: root, argv: holding(4), scope: "fixture", hypothesis: "small" });
	strays.push(pidOf(join(root, "large"), big.id), launcherOf(join(root, "large"), big.id));
	await until(() => large.supervisor.output(big.id).text.includes("holding") && small.supervisor.output(little.id).text.includes("holding"));
	await Bun.sleep(100);
	pressure = true;
	await until(() => small.supervisor.status(little.id).status === "stopped");
	await Bun.sleep(400); // many more pressure checks
	const atRisk = (updates: Update[]) => updates.filter((update) => update.kind === "machine-at-risk");
	expect(atRisk(large.updates)).toHaveLength(1);
	expect(atRisk(small.updates)).toHaveLength(1);
	// The stop could not end it: not reported as stopped, still watched, its reason kept.
	const view = large.supervisor.status(big.id);
	expect(view.status).toBe("running");
	expect(view.stopReason).toContain("this experiment was too big for the machine");
	pressure = false;
	process.kill(pidOf(join(root, "large"), big.id), "SIGKILL");
	// Finished as stopped once the last process is gone.
	await until(() => large.supervisor.status(big.id).status === "stopped");
}, 30_000);

test("a pressure check acts on the reading it is given rather than taking another", async () => {
	const guard = new MachineProtection(HARNESS_CONFIG.supervision, () => { throw new Error("second reading"); });
	let stopped: MachineSample | undefined;
	guard.register({ rssBytes: 1, largestProcessBytes: 1, peakBytes: 1, async stop(_peak, machine) { stopped = machine; } });
	const given = reading(0);
	await guard.check(0, given);
	expect(stopped).toBe(given);
});

test.skipIf(!linux)("on a sudden jump the memory warning reaches the owner in the same tick, before the stop", async () => {
	const root = workspace("sudden-");
	let pressure = false;
	const guard = new MachineProtection(HARNESS_CONFIG.supervision, () => reading(pressure ? 0 : 64e9));
	// Ticks far apart, so two updates less than one interval apart came from one tick.
	const { supervisor: owner, updates } = supervisor(root, { protection: guard, limits: { sampleIntervalMs: 400 } });
	const view = owner.start({ cwd: root, argv: holding(8), scope: "fixture", hypothesis: "sudden" });
	await until(() => owner.output(view.id).text.includes("holding"));
	await Bun.sleep(100);
	expect(updates).toEqual([]);
	pressure = true; // from plenty of headroom straight below the reserve
	await until(() => owner.status(view.id).status === "stopped");
	await until(() => updates.some((update) => update.kind === "exited"));
	expect(updates.map((update) => update.kind)).toEqual(["memory", "machine-at-risk", "exited"]);
	expect(updates[1].at - updates[0].at).toBeLessThan(400);
}, 20_000);

test.skipIf(!linux)("the victim of another owner's pressure check is warned before it is stopped", async () => {
	const root = workspace("cross-owner-");
	let pressure = false;
	let freed = () => false;
	// Stopping the large run frees the memory, which ends the pressure.
	const guard = new MachineProtection(HARNESS_CONFIG.supervision, () => reading(pressure && !freed() ? 0 : 64e9));
	const quick = supervisor(join(root, "quick"), { protection: guard, limits: { sampleIntervalMs: 10 } });
	const slow = supervisor(join(root, "slow"), { protection: guard, limits: { sampleIntervalMs: 5_000 } });
	const small = quick.supervisor.start({ cwd: root, argv: holding(2), scope: "fixture", hypothesis: "small" });
	const large = slow.supervisor.start({ cwd: root, argv: holding(96), scope: "fixture", hypothesis: "large" });
	freed = () => slow.supervisor.status(large.id).status !== "running";
	await until(() => quick.supervisor.output(small.id).text.includes("holding"));
	await Bun.sleep(300);
	pressure = true; // the quick owner's tick triggers the check; the slow owner has not ticked since
	await until(() => slow.supervisor.status(large.id).status === "stopped");
	const kinds = slow.updates.map((update) => update.kind);
	expect(kinds.slice(0, 2)).toEqual(["memory", "machine-at-risk"]);
	expect(quick.supervisor.status(small.id).status).toBe("running");
}, 20_000);

test.skipIf(!linux)("after a restart, a reported stall is not reported again and the learned rhythm is kept", async () => {
	const root = workspace("reattach-");
	const directory = join(root, "fixture");
	mkdirSync(directory);
	const logPath = join(directory, "output.log");
	const log = openSync(logPath, "a");
	const child = spawn("bash", ["-c", "for i in 1 2 3 4; do echo step $i; sleep 0.1; done; sleep 60"],
		{ cwd: root, detached: true, stdio: ["ignore", log, log] });
	closeSync(log);
	const pid = child.pid!;
	strays.push(pid);
	await until(() => processIdentity(pid) !== undefined);
	const identity = processIdentity(pid)!;
	const record: ExperimentRecord = { id: "fixture", argv: [], cwd: root, hypothesis: "h", scope: "s", pid, pgid: pid,
		startedAt: new Date().toISOString(), directory, logPath };
	writeFileSync(join(directory, "experiment.json"), JSON.stringify(record));
	const limits = { minStallMs: 250, importPreludeMs: 250 };
	const first = supervisor(root, { limits });
	first.supervisor.attach(record, { identity, status: "running" });
	await until(() => first.updates.some((update) => update.kind === "stalled"));
	const threshold = first.supervisor.status("fixture");
	// The harness dies: its supervisor stops ticking without stopping anything.
	const live = (first.supervisor as unknown as { live: Map<string, { timer?: ReturnType<typeof setInterval>; unregister?: () => void }> }).live;
	clearInterval(live.get("fixture")!.timer); live.get("fixture")!.unregister?.(); live.clear();
	const persisted = JSON.parse(readFileSync(join(directory, "supervisor-state.json"), "utf8"));
	expect(persisted.gate.reported).toContain("stalled");
	expect(persisted.gate.gaps).toBeGreaterThanOrEqual(3);
	const second = supervisor(root, { limits });
	second.supervisor.attach(record, { identity, status: "running", cursor: persisted.cursor, lines: persisted.lines });
	await Bun.sleep(600);
	expect(second.updates.filter((update) => update.kind === "stalled")).toEqual([]);
	expect(second.supervisor.status("fixture").secondsSinceOutput).toBeGreaterThanOrEqual(threshold.secondsSinceOutput!);
	expect((await second.supervisor.stop("fixture", "test over")).status).toBe("stopped");
}, 20_000);

test("capped reads never return part of a character or more than the cap", () => {
	const root = workspace("small-cap-");
	const directory = join(root, "fixture");
	mkdirSync(directory);
	const logPath = join(directory, "output.log");
	writeFileSync(logPath, "😀");
	const { supervisor: owner } = supervisor(root);
	const record: ExperimentRecord = { id: "fixture", argv: ["true"], cwd: root, hypothesis: "h", scope: "s", pid: 0, pgid: 4_194_001,
		startedAt: new Date().toISOString(), directory, logPath };
	owner.attach(record, { status: "exited" });
	for (const cap of [1, 2, 3]) expect(() => owner.output("fixture", 0, cap)).toThrow(RangeError);
	expect(owner.output("fixture", 0, 4)).toEqual({ text: "😀", cursor: 4, remaining: 0 });
	// A character the finished log cut off reads as one replacement character, within the cap.
	writeFileSync(logPath, Buffer.from([0x61, 0xf0, 0x9f]));
	const first = owner.output("fixture", 0, 4);
	expect(first.text).toBe("a");
	const rest = owner.output("fixture", first.cursor, 4);
	expect(rest).toEqual({ text: "�", cursor: 3, remaining: 0 });
	expect(Buffer.byteLength(rest.text)).toBeLessThanOrEqual(4);
	// The configuration and the supervisor refuse a cap that could not hold one character.
	const config = structuredClone(HARNESS_CONFIG) as { supervision: { outputCapBytes: number } };
	config.supervision.outputCapBytes = 3;
	expect(() => parseHarnessConfig(config)).toThrow("supervision.outputCapBytes must be at least 4");
	expect(() => new ExperimentSupervisor({ root, env: {}, deliver: () => undefined, limits: { outputCapBytes: 3 } })).toThrow(RangeError);
});

test.each([
	["far beyond the ceiling is reported once, with CPU, memory and elapsed time", 600, 1],
	["a healthy silent fold within the ceiling causes no wake", 60_000, 0],
] as const)("a run that prints once and then computes silently: %s", async (_name, ceiling, reports) => {
	const root = workspace("busy-silence-");
	const { supervisor: owner, updates } = supervisor(root, { limits: { busySilenceCeilingMs: ceiling, minStallMs: 250, importPreludeMs: 250 } });
	const view = owner.start({ cwd: root, argv: [process.execPath, "-e", "console.log('fold_started'); while (true) Math.sqrt(Math.random());"],
		scope: "fixture", hypothesis: "busy silence" });
	if (reports) await until(() => updates.length > 0);
	await Bun.sleep(1_500);
	expect(updates).toHaveLength(reports);
	expect(owner.status(view.id).status).toBe("running");
	if (!reports) return;
	const [update] = updates;
	expect(update.kind).toBe("busy-silence");
	// Information only, worded neutrally: a silent busy run may be healthy.
	expect(update.note).toMatch(/^For information only: no output for \d+ min at high CPU \(\d+%, \d+ MB resident\)\. If this is expected, ignore this note\.$/);
	expect(Number(update.facts!.cpuPercent)).toBeGreaterThanOrEqual(HARNESS_CONFIG.supervision.idleCpuPercent);
	expect(Number(update.facts!.rssMb)).toBeGreaterThan(0);
}, 20_000);
