/** Review regressions: process tree stop, CPU of reaped children, swap, byte-exact output, robustness. */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExperimentSupervisor } from "./supervisor.js";
import { MachineProtection, swapFull } from "./protection.js";
import { HARNESS_CONFIG } from "../harness/config.js";
import { linuxProcesses, processScans, processSnapshot, sampleLinuxGroup, groupRunning } from "./sampler.js";
import { ownedProcessAlive, processIdentity, type ProcessIdentity } from "./ownership.js";
import { decodePrefix, decodeSuffix } from "./text.js";
import type { ExperimentRecord, Update } from "./types.js";

const roots: string[] = [];
const supervisors: ExperimentSupervisor[] = [];
afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function workspace(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	roots.push(root);
	return root;
}
function supervisor(root: string, updates: Update[] = []) {
	const created = new ExperimentSupervisor({ root, env: { PATH: process.env.PATH! },
		deliver: (_, update) => { updates.push(update); }, limits: { sampleIntervalMs: 25, stopGraceMs: 200 } });
	supervisors.push(created);
	return created;
}
const until = async (predicate: () => boolean, timeoutMs = 10_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) { if (predicate()) return; await Bun.sleep(25); }
	throw new Error("condition did not become true");
};

test.skipIf(process.platform !== "linux")("a stop reaches a descendant that left the process group", async () => {
	const root = workspace("tree-stop-");
	const owner = supervisor(root);
	// The background child calls setsid() in place: its own session and group, parent still bash.
	const view = owner.start({ argv: ["bash", "-c", "setsid sleep 60 & wait"], cwd: root, hypothesis: "tree", scope: "fixture" });
	// The group is led by the launcher; the command (bash) is its child.
	const pgid = JSON.parse(readFileSync(join(root, view.id, "experiment.json"), "utf8")).pgid as number;
	let escaped: ProcessIdentity | undefined;
	await until(() => {
		const bash = linuxProcesses().find((p) => p.ppid === pgid && p.pgid === pgid);
		const child = bash && linuxProcesses().find((p) => p.ppid === bash.pid && p.pgid !== pgid);
		escaped = child ? processIdentity(child.pid) : undefined;
		return escaped !== undefined;
	});
	// Machine protection measures it as part of this owner's work...
	expect(sampleLinuxGroup(pgid, undefined, "/proc", 0)?.pids).toContain(escaped!.pid);
	// ...so a stop must end it too, not only the group.
	await owner.stop(view.id, "too big");
	await until(() => !ownedProcessAlive(escaped));
}, 20_000);

test("Linux CPU includes reaped children, so a loop of short subprocesses is not idle", () => {
	const root = workspace("fake-proc-");
	const stat = (pid: number, cutime: number) => {
		mkdirSync(join(root, String(pid)), { recursive: true });
		// pid (comm) state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime ...
		const fields = ["S", "1", "4242", "4242", "0", "0", "0", "0", "0", "0", "0", "1", "1", String(cutime), String(cutime),
			"20", "0", "1", "0", "5000", "1000", "10"];
		writeFileSync(join(root, String(pid), "stat"), `${pid} (bash) ${fields.join(" ")}\n`);
	};
	stat(4242, 0);
	const before = sampleLinuxGroup(4242, undefined, root, 0)!;
	// One second later the shell has reaped 90 ticks of children in each of user and system time.
	stat(4242, 90);
	const after = sampleLinuxGroup(4242, { ...before, at: before.at - 1_000 }, root, 0)!;
	expect(after.cpuSeconds - before.cpuSeconds).toBeGreaterThan(1.5);
	expect(after.cpuPercent).toBeGreaterThan(100);
});

test("swap below 1% (at most 64 MiB) free counts as full; a machine without swap never does", async () => {
	expect(swapFull({ availableBytes: 4e9, totalBytes: 16e9, swapTotalBytes: 8 * 1024 ** 3, swapFreeBytes: 3 * 1024 ** 2 })).toBe(true);
	expect(swapFull({ availableBytes: 4e9, totalBytes: 16e9, swapTotalBytes: 512 * 1024 ** 2, swapFreeBytes: 4 * 1024 ** 2 })).toBe(true);
	expect(swapFull({ availableBytes: 4e9, totalBytes: 16e9, swapTotalBytes: 8 * 1024 ** 3, swapFreeBytes: 512 * 1024 ** 2 })).toBe(false);
	expect(swapFull({ availableBytes: 4e9, totalBytes: 16e9, swapTotalBytes: 0, swapFreeBytes: 0 })).toBe(false);
	let stops = 0;
	const guard = new MachineProtection(HARNESS_CONFIG.supervision, () => ({ availableBytes: 4e9, totalBytes: 16e9, swapTotalBytes: 8 * 1024 ** 3, swapFreeBytes: 2 * 1024 ** 2 }));
	guard.register({ rssBytes: 1, largestProcessBytes: 1, peakBytes: 1, async stop() { stops++; } });
	await guard.check(0); await guard.check(15_000);
	expect(stops).toBe(1);
});

function attached(root: string, content: Buffer | string, status: "running" | "exited" = "exited") {
	const directory = join(root, "fixture");
	mkdirSync(directory, { recursive: true });
	const logPath = join(directory, "output.log");
	writeFileSync(logPath, content);
	const owner = supervisor(root);
	const record: ExperimentRecord = { id: "fixture", argv: ["true"], cwd: root, hypothesis: "h", scope: "s", pid: 0, pgid: 4_194_000,
		startedAt: new Date().toISOString(), directory, logPath };
	owner.attach(record, { status });
	return { owner, logPath };
}

test("reading forward in small chunks never loses a byte of multi-byte text", () => {
	const text = "ascii é → 漢字 😀 ".repeat(40);
	const { owner } = attached(workspace("utf8-"), text);
	for (const size of [5, 7, 24, 256]) {
		let cursor = 0, joined = "";
		for (let reads = 0; reads < 10_000; reads++) {
			const chunk = owner.output("fixture", cursor, size);
			expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(size);
			joined += chunk.text;
			cursor = chunk.cursor;
			if (chunk.remaining === 0) break;
		}
		expect(joined).toBe(text);
	}
});

test("binary output still advances and fits the cap; boundaries hold at both ends", () => {
	const binary = Buffer.from(Array.from({ length: 300 }, (_, i) => 0x80 + (i % 64)));
	const prefix = decodePrefix(binary, 100);
	expect(Buffer.byteLength(prefix.text)).toBeLessThanOrEqual(100);
	expect(prefix.bytes).toBeGreaterThan(0);
	expect(decodeSuffix(Buffer.from("€uro"), 6).text).toBe("€uro");
	expect(decodeSuffix(Buffer.from("€uro"), 5).text).toBe("uro");
	expect(decodeSuffix(Buffer.from("x€uro").subarray(2), 10).text).toBe("uro");
	const { owner } = attached(workspace("binary-"), binary);
	let cursor = 0;
	for (let reads = 0; reads < 1_000; reads++) {
		const chunk = owner.output("fixture", cursor, 64);
		expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(64);
		expect(chunk.cursor).toBeGreaterThan(cursor);
		cursor = chunk.cursor;
		if (chunk.remaining === 0) break;
	}
	expect(cursor).toBe(binary.length);
});

test("a re-attached run whose log path is removed keeps its output and is polled without throwing", async () => {
	const root = workspace("gone-");
	const { owner, logPath } = attached(root, "line\n", "running");
	rmSync(logPath);
	await Bun.sleep(150); // several ticks with the path missing
	// The log is the descriptor the supervisor opened at attach, not the path.
	expect(owner.output("fixture").text).toBe("line\n");
	expect(owner.status("fixture").status).toBe("exited");
});

test.skipIf(process.platform !== "linux")("one /proc scan serves the sample, the protection refresh and the liveness check of a tick", () => {
	processSnapshot("/proc", 0);
	const before = processScans();
	const pgid = linuxProcesses().find((p) => p.pid === process.pid)!.pgid;
	sampleLinuxGroup(pgid);
	sampleLinuxGroup(pgid);
	groupRunning(pgid);
	expect(processScans() - before).toBeLessThanOrEqual(1);
});
