/**
 * The supervisor against real detached processes.
 *
 * These fixtures stand in for a trial fit: they emit lines over time, go silent
 * at idle or at full CPU, and spawn workers of their own the way `n_jobs > 1`
 * does. Nothing here calls a model.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ExperimentSupervisor } from "./supervisor.js";
import type { Update } from "./types.js";

const BUN = process.execPath;

const FIXTURES: Record<string, string> = {
	// Lines spread over time, the shape a batch loop produces.
	progress: `
		const total = Number(process.argv[2] ?? 8), gap = Number(process.argv[3] ?? 120);
		for (let step = 1; step <= total; step++) {
			await Bun.sleep(gap);
			console.log(\`seen=\${step * 1000}/\${total * 1000} val_bacc=0.98\${step}\`);
		}
	`,
	// 52 lines a second, matching SGDClassifier(verbose=1) on the smaller corpus.
	noisy: `
		for (let line = 0; line < 152; line++) {
			console.log(\`-- Epoch \${line}, Avg. loss: 0.10\${line % 10}\`);
			await Bun.sleep(19);
		}
	`,
	// Alive, doing nothing. The failure the heartbeat exists for.
	idle: `
		console.log("about to deadlock");
		await Bun.sleep(60_000);
	`,
	// A parent plus workers, all in one process group.
	workers: `
		for (let worker = 0; worker < 3; worker++) {
			Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000)"], { stdio: ["ignore", "ignore", "ignore"] });
		}
		console.log("workers up");
		await Bun.sleep(60_000);
	`,
	failing: `
		console.log("loading corpus");
		console.error("Traceback (most recent call last):");
		process.exit(3);
	`,
};

const workspaces: string[] = [];
const supervisors: ExperimentSupervisor[] = [];

function harness(limits: Parameters<typeof makeSupervisor>[1] = {}) {
	return makeSupervisor(mkdtempSync(join(tmpdir(), "experiments-")), limits);
}

function makeSupervisor(root: string, limits: Record<string, unknown>) {
	workspaces.push(root);
	const updates: Update[] = [];
	const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
	const supervisor = new ExperimentSupervisor({
		root: join(root, "experiments"),
		env: { PATH: process.env.PATH ?? "" },
		deliver: (_text, update) => { updates.push(update); },
		record: (type, payload) => { events.push({ type, payload }); },
		limits: { sampleIntervalMs: 50, updateIntervalMs: 200, stopGraceMs: 200, ...limits },
	});
	supervisors.push(supervisor);
	return { supervisor, updates, events, root };
}

function fixture(root: string, name: keyof typeof FIXTURES): string {
	const path = join(root, `${name}.ts`);
	writeFileSync(path, FIXTURES[name]);
	return path;
}

const spec = (root: string, name: keyof typeof FIXTURES, args: string[] = []) => ({
	argv: [BUN, fixture(root, name), ...args],
	cwd: root,
	hypothesis: "batching the fit exposes a learning curve",
	scope: "one fold on a 2,000-row development subset",
});

async function until(predicate: () => boolean, timeoutMs = 15_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await Bun.sleep(25);
	}
	return false;
}

afterEach(async () => {
	await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.close()));
	for (const path of workspaces.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("starting without blocking", () => {
	test("start returns while the fit is still running, and progress arrives before it exits", async () => {
		const { supervisor, updates, root } = harness();
		const started = supervisor.start(spec(root, "progress", ["10", "150"]));
		// The whole point: the call returned with the process still alive.
		expect(started.status).toBe("running");
		expect(started.elapsedSeconds).toBeLessThan(1);

		expect(await until(() => updates.some((update) => update.kind === "progress"))).toBe(true);
		const duringFit = updates.filter((update) => update.kind === "progress");
		expect(duringFit[0].view.status).toBe("running");
		// Receiving everything at exit is the failure this asserts against.
		expect(await until(() => updates.some((update) => update.kind === "exited"))).toBe(true);
		expect(updates.findIndex((update) => update.kind === "progress"))
			.toBeLessThan(updates.findIndex((update) => update.kind === "exited"));
	}, 30_000);

	test("the same fit inside a blocking call delivers nothing until it returns", async () => {
		// The negative case, asserted so the non-blocking start cannot silently
		// regress: a fit run inside a tool call reaches no model-call boundary.
		const { supervisor, updates, root } = harness();
		const path = fixture(root, "progress");
		const finished = spawnSync(BUN, [path, "4", "100"], { encoding: "utf8" });
		expect(finished.stdout.trim().split("\n")).toHaveLength(4);
		expect(updates).toHaveLength(0);
		expect(supervisor.list()).toHaveLength(0);
	}, 30_000);

	test("everything needed to attribute a stray process is written before the spawn", async () => {
		const { supervisor, events, root } = harness();
		const view = supervisor.start(spec(root, "progress", ["2", "50"]), "toolu_01");
		const record = JSON.parse(readFileSync(join(supervisor.status(view.id).logPath, "..", "experiment.json"), "utf8"));
		expect(record.pgid).toBeGreaterThan(0);
		expect(record.argv[0]).toBe(BUN);
		expect(record.scope).toContain("2,000-row");
		expect(record.requestedByToolCallId).toBe("toolu_01");
		expect(events[0].type).toBe("experiment_started");
	}, 30_000);

	test("a trial must say what work it actually does", () => {
		const { supervisor, root } = harness();
		expect(() => supervisor.start({ ...spec(root, "progress"), scope: "  " })).toThrow(/scope/);
	}, 30_000);
});

describe("stopping the group", () => {
	test("the whole process group goes, leaving no owned workers behind", async () => {
		const { supervisor, root } = harness();
		const view = supervisor.start(spec(root, "workers"));
		expect(await until(() => supervisor.status(view.id).linesEmitted > 0)).toBe(true);
		// `n_jobs=-1` means joblib worker processes: killing only the parent
		// orphans them to keep burning CPU into the next iteration.
		const pgid = supervisorPgid(supervisor, view.id);
		const members = () => {
			// `ps` exits nonzero on an empty group, which is the state being waited for.
			const listed = spawnSync("ps", ["-o", "pid=", "-g", String(pgid)], { encoding: "utf8" });
			return listed.stdout.trim().split("\n").filter(Boolean).length;
		};
		expect(members()).toBeGreaterThan(1);

		const stopped = await supervisor.stop(view.id, "the validation curve turned over at epoch 2", ["val_bacc fell 0.9841 -> 0.9838"]);
		expect(stopped.status).toBe("stopped");
		expect(await until(() => members() === 0, 5_000)).toBe(true);
	}, 30_000);

	test("stopping twice says the same thing rather than failing", async () => {
		const { supervisor, root } = harness();
		const view = supervisor.start(spec(root, "idle"));
		const first = await supervisor.stop(view.id, "superseded");
		const second = await supervisor.stop(view.id, "superseded");
		expect(first.status).toBe("stopped");
		expect(second.status).toBe("stopped");
		expect(second.stopReason).toBe("superseded");
	}, 30_000);

	test("the agent's reason and cited observations are recorded with the stop", async () => {
		const { supervisor, events, root } = harness();
		const view = supervisor.start(spec(root, "idle"));
		await supervisor.stop(view.id, "diverging", ["train_loss rose for 3 steps"]);
		const requested = events.find((event) => event.type === "experiment_stop_requested")!;
		expect(requested.payload.reason).toBe("diverging");
		expect(requested.payload.observations).toEqual(["train_loss rose for 3 steps"]);
	}, 30_000);

	test("closing the supervisor leaves nothing detached behind it", async () => {
		const { supervisor, root } = harness();
		const view = supervisor.start(spec(root, "idle"));
		const pgid = supervisorPgid(supervisor, view.id);
		await supervisor.close();
		expect(await until(() => !alive(pgid), 5_000)).toBe(true);
	}, 30_000);
});

describe("carrying the output out", () => {
	test("the log is the record, and a cursor resumes without replaying it", async () => {
		const { supervisor, root } = harness();
		const view = supervisor.start(spec(root, "progress", ["6", "60"]));
		expect(await until(() => supervisor.status(view.id).status === "exited")).toBe(true);

		const head = supervisor.output(view.id, 0, 24);
		expect(head.text.length).toBeGreaterThan(0);
		expect(head.remaining).toBeGreaterThan(0);
		const rest = supervisor.output(view.id, head.cursor);
		expect(rest.remaining).toBe(0);
		// Resumption, not replay: the two halves reconstruct the log exactly once.
		expect(head.text + rest.text).toBe(readFileSync(supervisor.status(view.id).logPath, "utf8"));
		expect(supervisor.status(view.id).linesEmitted).toBe(6);
	}, 30_000);

	test("stderr lands in the same record as stdout, and a traceback jumps the queue", async () => {
		const { supervisor, updates, root } = harness({ updateIntervalMs: 60_000 });
		const view = supervisor.start(spec(root, "failing"));
		expect(await until(() => supervisor.status(view.id).status === "exited")).toBe(true);
		// A trial that dies immediately delivers its diagnostic with the exit
		// rather than as a second wake: one event, one model call.
		expect(await until(() => updates.some((update) => update.lines.some((line) => line.includes("Traceback"))))).toBe(true);
		expect(supervisor.status(view.id).exitCode).toBe(3);
		expect(readFileSync(view.logPath, "utf8")).toContain("Traceback");
	}, 30_000);

	test("noisy output cannot flood the agent", async () => {
		// 152 lines in about 2.9 s. One wake a line is unaffordable in both
		// context and money; the log keeps the full sequence either way.
		const { supervisor, updates, root } = harness({ updateIntervalMs: 1_000 });
		const view = supervisor.start(spec(root, "noisy"));
		expect(await until(() => supervisor.status(view.id).status === "exited", 20_000)).toBe(true);
		const lines = supervisor.status(view.id).linesEmitted;
		expect(lines).toBe(152);
		expect(updates.filter((update) => update.kind === "progress").length).toBeLessThan(lines / 10);
	}, 30_000);
});

describe("watching the process", () => {
	test("CPU, memory, and group size reach the agent", async () => {
		const { supervisor, root } = harness();
		const view = supervisor.start(spec(root, "noisy"));
		// A rate needs two readings, so CPU appears one sample after memory does.
		expect(await until(() => supervisor.status(view.id).cpuPercent !== undefined)).toBe(true);
		const status = supervisor.status(view.id);
		expect(status.rssMb).toBeGreaterThan(1);
		expect(status.processes).toBeGreaterThanOrEqual(1);
		expect(status.cpuPercent).toBeGreaterThanOrEqual(0);
	}, 30_000);

	test("a fit alive at idle CPU is reported stuck once its derived threshold passes", async () => {
		const { supervisor, updates, root } = harness({ importPreludeMs: 200, minStallMs: 500, stallGapMultiple: 2 });
		const view = supervisor.start({ ...spec(root, "idle"), expectedGapMs: 250 });
		expect(await until(() => updates.some((update) => update.kind === "stalled"))).toBe(true);
		expect(updates.find((update) => update.kind === "stalled")?.note).toContain("derived for this trial");
		await supervisor.stop(view.id, "hung");
	}, 30_000);

	test("only one experiment at a time beyond the configured limit", () => {
		const { supervisor, root } = harness({ maxConcurrent: 1 });
		supervisor.start(spec(root, "idle"));
		expect(() => supervisor.start(spec(root, "idle"))).toThrow(/already running/);
	}, 30_000);
});

function supervisorPgid(supervisor: ExperimentSupervisor, id: string): number {
	const directory = join(supervisor.status(id).logPath, "..");
	return JSON.parse(readFileSync(join(directory, "experiment.json"), "utf8")).pgid;
}

function alive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch {
		return false;
	}
}
