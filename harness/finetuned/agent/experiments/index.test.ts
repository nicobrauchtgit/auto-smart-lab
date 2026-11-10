import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createExperiments, type Wakeable } from "./index.js";
import { loadPromptSnapshot } from "../prompts/loader.js";

const prompts = loadPromptSnapshot();
const scopes: Array<{ close: () => Promise<void> }> = [];
const roots: string[] = [];

function recorder() {
	const steered: string[] = [];
	const custom: string[] = [];
	let streaming = false;
	const session: Wakeable = {
		get isStreaming() { return streaming; },
		async steer(text) { steered.push(text); },
		async sendCustomMessage(message) { custom.push(String(message.content)); },
	};
	return { session, steered, custom, run: (value: boolean) => { streaming = value; } };
}

function scope(session?: Wakeable) {
	const root = mkdtempSync(join(tmpdir(), "experiments-scope-"));
	roots.push(root);
	writeFileSync(join(root, "trial.ts"), `console.log("seen=1000 val_bacc=0.98"); await Bun.sleep(400);`);
	const events: string[] = [];
	const created = createExperiments({
		root: join(root, "experiments"), env: { PATH: process.env.PATH ?? "" },
		prompts, session, record: (type) => { events.push(type); },
		limits: { sampleIntervalMs: 40, updateIntervalMs: 50 },
	});
	scopes.push(created);
	return { ...created, root, events, spec: {
		argv: [process.execPath, join(root, "trial.ts")], cwd: root,
		hypothesis: "batching exposes a curve", scope: "2,000-row pilot",
	} };
}

const until = async (predicate: () => boolean, timeoutMs = 10_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await Bun.sleep(20);
	}
	return false;
};

afterEach(async () => {
	await Promise.all(scopes.splice(0).map((entry) => entry.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("waking the agent", () => {
	test("a running agent is steered and never also sent a custom message", async () => {
		const agent = recorder();
		agent.run(true);
		const created = scope(agent.session);
		created.supervisor.start(created.spec);
		expect(await until(() => agent.steered.length > 0)).toBe(true);
		expect(agent.custom).toHaveLength(0);
		expect(agent.steered[0]).toContain("[experiment ");
	}, 20_000);

	test("an idle agent gets a turn started for it, and is never also steered", async () => {
		// steer() delivers after the current turn's tool calls finish. An idle
		// agent has no turn to attach to, so only triggerTurn reaches it.
		const agent = recorder();
		const created = scope(agent.session);
		created.supervisor.start(created.spec);
		expect(await until(() => agent.custom.length > 0)).toBe(true);
		expect(agent.steered).toHaveLength(0);
	}, 20_000);

	test("an unbound scope records the undelivered update instead of losing it silently", async () => {
		const created = scope();
		created.supervisor.start(created.spec);
		expect(await until(() => created.events.includes("experiment_update_undelivered"))).toBe(true);
	}, 20_000);
});

test("the scope exposes four tools and their prompt identities", () => {
	const created = scope();
	expect(created.tools.map((tool) => tool.name).sort())
		.toEqual(["experiment_output", "experiment_start", "experiment_status", "experiment_stop"]);
	// No experiment_watch: push through the session covers the same need.
	expect(created.toolPrompts.map((reference) => reference.id))
		.toEqual(["experiments.start-tool", "experiments.status-tool", "experiments.output-tool", "experiments.stop-tool"]);
});
