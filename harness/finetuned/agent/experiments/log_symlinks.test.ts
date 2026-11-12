/**
 * A supervised command that can write where the supervisor keeps a run's files
 * replaces them with symlinks to a host file it cannot read (withheld labels).
 * The supervisor reads its log only through the descriptor it opened, never a
 * status or state file through a symlink, and writes the agent's copy as a
 * fresh file: the host file's content reaches no output, report or copy, and
 * the file itself is never written.
 */
import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExperimentSupervisor } from "./supervisor.js";
import { COMMAND_STATUS_FILE, readCommandStatus } from "./launcher.js";
import { openLog, readRecord, safeDirectory, writeCopy } from "./safe_files.js";
import type { ExperimentRecord } from "./types.js";

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
const until = async (predicate: () => boolean, timeoutMs = 10_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) { if (predicate()) return; await Bun.sleep(10); }
	throw new Error("condition did not become true");
};
/** A host-only file with a unique marker, as withheld labels would be. */
function withheld(): { secret: string; marker: string; content: string } {
	const marker = `WITHHELD_LABELS_${Date.now()}_${Math.random().toString(36).slice(2)}`;
	const secret = join(workspace("withheld-"), "labels.csv");
	const content = `id,label\n1,${marker}\n`;
	writeFileSync(secret, content);
	return { secret, marker, content };
}
/** Every byte the supervisor will hand out for a run, read forward from the start. */
function everything(owner: ExperimentSupervisor, id: string): string {
	let text = "", cursor = 0;
	for (let round = 0; round < 1000; round++) {
		const chunk = owner.output(id, cursor, 4096);
		text += chunk.text;
		if (chunk.cursor === cursor) break;
		cursor = chunk.cursor;
	}
	return text;
}

test("a run that replaces its log, launcher status and state with symlinks to a host file never shows that file", async () => {
	const { secret, marker, content } = withheld();
	const root = workspace("swap-logs-"), copies = workspace("swap-copies-");
	const updates: string[] = [];
	const owner = new ExperimentSupervisor({ root, env: { PATH: process.env.PATH! }, deliver: (text) => { updates.push(text); },
		limits: { sampleIntervalMs: 25, stopGraceMs: 100 }, spill: { base: copies, directory: copies } });
	supervisors.push(owner);
	const directory = join(root, "swap");
	// The command knows exactly where its files are and replaces each of them.
	const swap = ["output.log", COMMAND_STATUS_FILE, "supervisor-state.json", "experiment.json"]
		.map((name) => `rm -f '${join(directory, name)}'; ln -s '${secret}' '${join(directory, name)}'`).join("; ");
	owner.start({ argv: ["bash", "-c", `echo before-swap; ${swap}; echo swapped; sleep 0.3; echo after-swap`],
		cwd: root, hypothesis: "swap its logs", scope: "fixture" }, undefined, "swap");
	await until(() => owner.status("swap").status !== "running");
	await Bun.sleep(100); // final updates
	// The attack ran: the log path now names the host file.
	expect(lstatSync(join(directory, "output.log")).isSymbolicLink()).toBe(true);
	const output = everything(owner, "swap");
	expect(output).toBe("before-swap\nswapped\nafter-swap\n");
	expect(owner.tail("swap", 4096).text).toBe(output);
	const view = owner.status("swap");
	expect(view.lastLine).toBe("after-swap");
	expect(view.exitCode).toBe(0);
	owner.release("swap");
	const copy = readFileSync(join(copies, "swap.log"), "utf8");
	expect(copy).toBe(output);
	for (const text of [output, copy, JSON.stringify(view), ...updates]) expect(text).not.toContain(marker);
	expect(updates.some((text) => text.includes("after-swap"))).toBe(true);
	// The host file was never written through a symlink.
	expect(readFileSync(secret, "utf8")).toBe(content);
});

test("the agent's copy replaces a symlink planted at its path and refuses a symlinked folder", async () => {
	const { secret, marker, content } = withheld();
	const root = workspace("planted-"), base = workspace("planted-base-");
	const records: { type: string; payload: Record<string, unknown> }[] = [];
	const owner = new ExperimentSupervisor({ root, env: { PATH: process.env.PATH! }, deliver: () => undefined,
		record: (type, payload) => { records.push({ type, payload }); },
		limits: { sampleIntervalMs: 25, stopGraceMs: 100 }, spill: { base, directory: join(base, "calls") } });
	supervisors.push(owner);
	mkdirSync(join(base, "calls"));
	symlinkSync(secret, join(base, "calls", "planted.log"));
	owner.start({ argv: ["bash", "-c", "echo real-output"], cwd: root, hypothesis: "h", scope: "s" }, undefined, "planted");
	await until(() => owner.status("planted").status !== "running");
	owner.release("planted");
	expect(lstatSync(join(base, "calls", "planted.log")).isFile()).toBe(true);
	expect(readFileSync(join(base, "calls", "planted.log"), "utf8")).toBe("real-output\n");
	expect(readFileSync(secret, "utf8")).toBe(content);

	// The copy folder replaced by a symlink to the host folder: nothing is written there.
	rmSync(join(base, "calls"), { recursive: true });
	symlinkSync(join(secret, ".."), join(base, "calls"));
	owner.start({ argv: ["bash", "-c", "echo second"], cwd: root, hypothesis: "h", scope: "s" }, undefined, "folder");
	await until(() => owner.status("folder").status !== "running");
	owner.release("folder");
	expect(readdirSync(join(secret, ".."))).toEqual(["labels.csv"]);
	expect(records.some((record) => record.type === "experiment_spill_failed" && record.payload.experiment_id === "folder")).toBe(true);
	expect(everything(owner, "folder")).not.toContain(marker);
});

test("a reattached run whose log and state are symlinks reads neither", () => {
	const { secret, marker } = withheld();
	const root = workspace("reattach-symlink-");
	const directory = join(root, "fixture");
	mkdirSync(directory);
	symlinkSync(secret, join(directory, "output.log"));
	symlinkSync(secret, join(directory, "supervisor-state.json"));
	const events: { type: string; payload: Record<string, unknown> }[] = [];
	const owner = new ExperimentSupervisor({ root, env: {}, deliver: () => undefined,
		record: (type, payload) => { events.push({ type, payload }); }, limits: { sampleIntervalMs: 60_000 } });
	supervisors.push(owner);
	const record: ExperimentRecord = { id: "fixture", argv: ["true"], cwd: root, hypothesis: "h", scope: "s",
		pid: 2 ** 22 + 7, pgid: 2 ** 22 + 7, startedAt: new Date().toISOString(), directory, logPath: join(directory, "output.log") };
	const view = owner.attach(record, { status: "exited" });
	expect(events.find((event) => event.type === "experiment_state_malformed")?.payload.fields).toEqual(["supervisor-state.json", "output.log"]);
	expect(owner.output("fixture").text).toBe("");
	expect(owner.tail("fixture", 4096).text).toBe("");
	expect(JSON.stringify(view)).not.toContain(marker);
});

test("status files, records and logs are never opened through a symlink", () => {
	const root = workspace("nofollow-");
	const target = join(root, "status-target.json");
	writeFileSync(target, JSON.stringify({ pid: 4242, exitCode: 0 }));
	symlinkSync(target, join(root, COMMAND_STATUS_FILE));
	expect(readCommandStatus(target)).toEqual({ pid: 4242, exitCode: 0 });
	expect(readCommandStatus(join(root, COMMAND_STATUS_FILE))).toBeUndefined();
	expect(readRecord(join(root, COMMAND_STATUS_FILE))).toBeUndefined();
	symlinkSync(target, join(root, "output.log"));
	expect(() => openLog(join(root, "output.log"))).toThrow();
	// A folder below the base that is a symlink is refused, and so is a path outside the base.
	mkdirSync(join(root, "real"));
	symlinkSync(join(root, "real"), join(root, "link"));
	expect(() => safeDirectory(root, join(root, "link", "calls"))).toThrow("not a directory");
	expect(() => safeDirectory(join(root, "real"), root)).toThrow("not inside");
	expect(safeDirectory(root, join(root, "real", "calls"))).toEndWith(join("real", "calls"));
	expect(() => writeCopy(root, join(root, "real"), "../escape.log", 0)).toThrow("unsafe copy name");
});
