/**
 * Review round 3: a detached worker whose parent exits before the first sample
 * is still found and stopped (the child subreaper launcher), the launcher's
 * preflight blocks execution when it cannot work, malformed persisted state
 * never crashes a reattach, and commands keep default signal dispositions.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExperimentSupervisor } from "./supervisor.js";
import { COMMAND_STATUS_FILE, checkReaper, readCommandStatus, usesReaper } from "./launcher.js";
import { processIdentity } from "./ownership.js";
import { linuxProcesses } from "./sampler.js";
import { SetupSession, setupChecks } from "../pipeline/setup.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import type { ExperimentRecord, Update } from "./types.js";

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
	while (Date.now() < deadline) { if (predicate()) return; await Bun.sleep(10); }
	throw new Error("condition did not become true");
};
const alive = (pid: number) => { const identity = processIdentity(pid); return !!identity && !["Z", "X"].includes(identity.state); };

test.skipIf(!linux)("a detached worker whose parent exits before the first sample is still tracked, and a stop leaves no process alive", async () => {
	expect(usesReaper()).toBe(true);
	const root = workspace("detached-race-");
	const events: { type: string; payload: Record<string, unknown> }[] = [];
	const updates: Update[] = [];
	// No sample is taken for a minute: discovery cannot depend on sampling timing.
	const owner = new ExperimentSupervisor({ root, env: { PATH: process.env.PATH! },
		deliver: (_, update) => { updates.push(update); }, record: (type, payload) => { events.push({ type, payload }); },
		limits: { sampleIntervalMs: 60_000, stopGraceMs: 200 } });
	supervisors.push(owner);
	const view = owner.start({ argv: ["bash", "-c", "setsid sleep 30 >/dev/null 2>&1 < /dev/null & echo $!"],
		cwd: root, hypothesis: "detached worker", scope: "fixture" });
	const record = JSON.parse(readFileSync(join(root, view.id, "experiment.json"), "utf8")) as ExperimentRecord;
	// The parent (bash) has exited, and no tick has sampled the run yet.
	await until(() => readCommandStatus(join(root, view.id, COMMAND_STATUS_FILE))?.exitCode === 0);
	await until(() => owner.output(view.id).text.trim().length > 0);
	const worker = Number(owner.output(view.id).text.trim());
	strays.push(worker, record.pgid);
	expect(alive(worker)).toBe(true);
	await Bun.sleep(300); // past the launcher-exit check that used to declare the run over
	expect(owner.commandExit(view.id)).toMatchObject({ ended: true, exitCode: 0 });
	// Not `exited`: the worker re-parented to the launcher (a child subreaper), not to init.
	expect(owner.status(view.id).status).toBe("running");
	expect(linuxProcesses().find((p) => p.pid === worker)?.ppid).toBe(record.pgid);
	expect(owner.remaining(view.id)).toEqual([worker]);
	// Nothing told the owner the run was over while its worker lived.
	expect(updates.filter((update) => update.kind === "exited")).toEqual([]);
	const stopped = await owner.stop(view.id, "clean up");
	expect(stopped.status).toBe("stopped");
	expect(alive(worker)).toBe(false);
	expect(alive(record.pgid)).toBe(false);
	expect(events.some((event) => event.type === "experiment_stop_incomplete")).toBe(false);
}, 20_000);

test.skipIf(!linux)("a stop kills a process forked during the stop: it re-parents to the launcher and the next round finds it", async () => {
	const root = workspace("fork-during-stop-");
	const owner = new ExperimentSupervisor({ root, env: { PATH: process.env.PATH! }, deliver: () => undefined,
		limits: { sampleIntervalMs: 25, stopGraceMs: 300 } });
	supervisors.push(owner);
	// Ignores SIGTERM and keeps forking detached sleepers until it is killed.
	const view = owner.start({ argv: ["bash", "-c", "trap '' TERM; echo ready; while true; do setsid sleep 30 >/dev/null 2>&1 < /dev/null & sleep 0.01; done"],
		cwd: root, hypothesis: "forks while stopping", scope: "fixture" });
	await until(() => owner.output(view.id).text.includes("ready"));
	await Bun.sleep(100);
	const pgid = (JSON.parse(readFileSync(join(root, view.id, "experiment.json"), "utf8")) as ExperimentRecord).pgid;
	const stopped = await owner.stop(view.id, "clean up");
	expect(stopped.status).toBe("stopped");
	const left = linuxProcesses().filter((p) => p.ppid === pgid || p.pid === pgid);
	expect(left).toEqual([]);
}, 20_000);

test.skipIf(!linux)("commands run with default SIGPIPE: a closed pipe ends the writer instead of erroring", async () => {
	const root = workspace("sigpipe-");
	const owner = new ExperimentSupervisor({ root, env: { PATH: process.env.PATH! }, deliver: () => undefined,
		limits: { sampleIntervalMs: 25 } });
	supervisors.push(owner);
	const view = owner.start({ argv: ["bash", "-c", "yes | head -n 1; echo \"pipe ${PIPESTATUS[0]}\""], cwd: root, hypothesis: "pipe", scope: "fixture" });
	await until(() => owner.status(view.id).status !== "running");
	const text = owner.output(view.id).text;
	expect(text).toBe("y\npipe 141\n");
	expect(owner.status(view.id).exitCode).toBe(0);
}, 20_000);

test.skipIf(!linux)("the launcher preflight passes here and blocks every agent or trial requirement when it cannot run", async () => {
	checkReaper();
	const prompts = loadPromptSnapshot();
	for (const requirement of ["supervision", "model", "training", "refit"] as const) {
		expect(setupChecks([requirement], { taskId: "fixture", prompts }).map((check) => check.id)).toContain("supervision-launcher");
	}
	const [healthy] = setupChecks(["supervision"], { taskId: "fixture", prompts }).filter((check) => check.id === "supervision-launcher");
	await new SetupSession().check([healthy], new AbortController().signal, () => {});
	const missing = join(workspace("no-python-"), "python");
	expect(() => checkReaper(missing)).toThrow(/project Python .*\.\/dev setup/);
	const checks = setupChecks(["model"], { taskId: "fixture", prompts, executables: { python: missing } })
		.filter((check) => check.id === "supervision-launcher");
	const results: Record<string, unknown>[] = [];
	let executed = false;
	await expect((async () => {
		await new SetupSession().check(checks, new AbortController().signal, (event, payload) => { if (event === "setup_check") results.push(payload); });
		executed = true;
	})()).rejects.toThrow(/supervision-launcher/);
	expect(executed).toBe(false);
	expect(results).toEqual([expect.objectContaining({ id: "supervision-launcher", status: "failed" })]);
	// A python that runs but is not a working launcher is refused too.
	const fake = join(workspace("fake-python-"), "python");
	writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	expect(() => checkReaper(fake)).toThrow(/supervision launcher/);
});

test.each([
	["members is an object", { schemaVersion: 1, members: {}, gate: { reported: ["stalled"] } }, ["supervisor-state.json:members"]],
	["gate is an array", { schemaVersion: 1, gate: [], members: [] }, ["supervisor-state.json:gate"]],
	["the state is an array", [], ["supervisor-state.json:state"]],
	["a member is malformed", { members: [{ pid: "1" }, null, 7] }, ["supervisor-state.json:members[]"]],
	["the file is not JSON", "{ members: ", ["supervisor-state.json"]],
] as const)("malformed persisted state (%s) is treated as absent, recorded, and never crashes a reattach", (_name, state, fields) => {
	const root = workspace("malformed-state-");
	const directory = join(root, "fixture");
	mkdirSync(directory);
	writeFileSync(join(directory, "supervisor-state.json"), typeof state === "string" ? state : JSON.stringify(state));
	writeFileSync(join(directory, "output.log"), "");
	const events: { type: string; payload: Record<string, unknown> }[] = [];
	const owner = new ExperimentSupervisor({ root, env: {}, deliver: () => undefined,
		record: (type, payload) => { events.push({ type, payload }); }, limits: { sampleIntervalMs: 60_000 } });
	supervisors.push(owner);
	const record: ExperimentRecord = { id: "fixture", argv: ["true"], cwd: root, hypothesis: "h", scope: "s",
		pid: 2 ** 22 + 7, pgid: 2 ** 22 + 7, startedAt: new Date().toISOString(), directory, logPath: join(directory, "output.log") };
	const view = owner.attach(record, { status: "exited" });
	expect(view.status).toBe("exited");
	expect(events.find((event) => event.type === "experiment_state_malformed")?.payload).toEqual({ experiment_id: "fixture", fields: [...fields] });
	// A malformed caller-supplied list is refused the same way.
	const again = new ExperimentSupervisor({ root, env: {}, deliver: () => undefined,
		record: (type, payload) => { events.push({ type, payload }); }, limits: { sampleIntervalMs: 60_000 } });
	supervisors.push(again);
	expect(() => again.attach(record, { status: "exited", members: {} as never })).not.toThrow();
	expect(events.filter((event) => event.type === "experiment_state_malformed").at(-1)?.payload.fields).toContain("caller:members");
});
