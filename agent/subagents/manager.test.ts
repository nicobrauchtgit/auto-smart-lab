import assert from "node:assert/strict";
import { test } from "node:test";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { SubagentManager } from "./manager.js";
import { boundedText, type ChildSession, type ChildSessionFactory } from "./types.js";

const prompts = loadPromptSnapshot();
function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function fixture(limits: ConstructorParameters<typeof SubagentManager>[0]["limits"] = {}) {
	const calls: string[] = [];
	const turns: ReturnType<typeof deferred<string>>[] = [];
	let created = 0;
	let closed = 0;
	let current: ReturnType<typeof deferred<string>> | undefined;
	const createSession: ChildSessionFactory = async (_identity, signal) => {
		created++;
		let disposed = false;
		return {
			agentRunId: `run-${created}`, piSessionId: `session-${created}`,
			async prompt(message) {
				calls.push(message.text);
				current = deferred<string>();
				turns.push(current);
				const abort = () => current?.reject(new Error("aborted"));
				signal.addEventListener("abort", abort, { once: true });
				try { return await current.promise; }
				finally { signal.removeEventListener("abort", abort); }
			},
			async abort() { current?.reject(new Error("aborted")); },
			async close() { if (!disposed) { disposed = true; closed++; } },
		} satisfies ChildSession;
	};
	const events: { type: string; data: Record<string, unknown> }[] = [];
	const manager = new SubagentManager({ parentAgentRunId: "parent", prompts, createSession, limits,
		record: (type, data) => events.push({ type, data }) });
	return { manager, calls, turns, events, created: () => created, closed: () => closed };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test("spawn reserves capacity before startup and rejects invalid input", async () => {
	const f = fixture({ maxConcurrent: 1, maxMessageBytes: 20 });
	try {
		assert.throws(() => f.manager.spawn(" ", "tool"), /message/);
		assert.throws(() => f.manager.spawn("é".repeat(11), "tool"), /message/);
		const child = f.manager.spawn("Implement A", "tool-a");
		assert.equal(child.parentAgentRunId, "parent");
		assert.equal(child.spawnToolCallId, "tool-a");
		assert.throws(() => f.manager.spawn("Implement B", "tool-b"), /concurrency/);
		assert.throws(() => f.manager.check("foreign-child"), /Unknown child/);
		assert.equal(f.manager.list().length, 1);
	} finally { await f.manager.close(); }
});

test("queued and idle follow-ups preserve the child context and clear stale replies", async () => {
	const f = fixture();
	try {
		const { logicalAgentId: id } = f.manager.spawn("Implement A", "spawn");
		await tick();
		f.manager.followup(id, "Also test B", "followup-1");
		assert.equal(f.manager.check(id).queued, 1);
		assert.equal((await f.manager.wait(id, 0)).status, "running");
		f.turns[0].resolve("First result must not be returned as final");
		await tick();
		assert.match(f.calls[1], /Also test B/);
		assert.equal((await f.manager.wait(id, 0)).output, undefined);
		f.turns[1].resolve("Done A and B");
		const result = await f.manager.wait(id);
		assert.equal(result.output, "Done A and B");
		assert.equal(result.status, "idle");
		assert.equal(result.logicalAgentId, id);
		assert.equal("output" in f.manager.check(id), false);
		f.manager.followup(id, "Review C", "followup-2");
		assert.equal((await f.manager.wait(id, 0)).output, undefined);
		f.turns[2].resolve("Reviewed C");
		assert.equal((await f.manager.wait(id)).output, "Reviewed C");
		assert.equal(f.created(), 1);
	} finally { await f.manager.close(); }
	assert.equal(f.closed(), 1);
});

test("results truncate UTF-8 safely and include trace identity", async () => {
	const f = fixture({ maxResultBytes: 5 });
	try {
		const { logicalAgentId: id } = f.manager.spawn("Write file", "spawn");
		await tick();
		f.turns[0].resolve("éééé LARGE BASH TRANSCRIPT");
		const result = await f.manager.wait(id);
		assert.equal(result.output, "éé");
		assert.equal(result.truncated, true);
		assert.equal(result.agentRunId, "run-1");
		assert.equal(result.piSessionId, "session-1");
		assert.deepEqual(boundedText("abc", 3), { text: "abc", truncated: false });
	} finally { await f.manager.close(); }
});

test("wait timeout and wait cancellation leave child work running", async () => {
	const f = fixture();
	try {
		const { logicalAgentId: id } = f.manager.spawn("Work", "spawn");
		assert.equal((await f.manager.wait(id, 1)).status, "running");
		const abort = new AbortController();
		const wait = f.manager.wait(id, 60_000, abort.signal);
		abort.abort(new Error("Parent stopped waiting"));
		await assert.rejects(wait, /Parent stopped waiting/);
		assert.equal(f.manager.check(id).status, "running");
		f.turns[0].resolve("Done");
		assert.equal((await f.manager.wait(id)).status, "idle");
	} finally { await f.manager.close(); }
});

test("cancellation discards follow-ups, stops work, and is idempotent", async () => {
	const f = fixture();
	const { logicalAgentId: id } = f.manager.spawn("Work", "spawn");
	await tick();
	f.manager.followup(id, "More work", "followup");
	const waiting = f.manager.wait(id);
	await Promise.all([f.manager.cancel(id), f.manager.cancel(id)]);
	assert.equal((await waiting).status, "cancelled");
	assert.equal(f.manager.check(id).queued, 0);
	assert.equal(f.calls.length, 1);
	assert.throws(() => f.manager.followup(id, "Restart", "followup"), /cannot be continued/);
	await f.manager.close();
	assert.equal(f.closed(), 1);
});

test("factory and request failures settle waiters and never count as successful output", async () => {
	const failed = new SubagentManager({ parentAgentRunId: "parent", prompts,
		createSession: async () => { throw new Error("setup failed"); }, record: () => {} });
	const child = failed.spawn("Work", "spawn");
	const result = await failed.wait(child.logicalAgentId);
	assert.equal(result.status, "failed");
	assert.match(result.error!, /setup failed/);
	assert.equal(result.output, undefined);
	await failed.close();
	const f = fixture();
	try {
		const child = f.manager.spawn("Work", "spawn");
		await tick();
		f.turns[0].reject(new Error("provider failed"));
		assert.equal((await f.manager.wait(child.logicalAgentId)).status, "failed");
		assert.equal(f.closed(), 1);
	} finally { await f.manager.close(); }
});

test("closing during startup closes the late session without starting work", async () => {
	const ready = deferred<ChildSession>();
	let disposed = 0;
	const manager = new SubagentManager({ parentAgentRunId: "parent", prompts,
		createSession: () => ready.promise, record: () => {} });
	const child = manager.spawn("Work", "spawn");
	const closing = manager.close();
	let closed = false;
	ready.resolve({ agentRunId: "run", piSessionId: "session",
		async prompt() { throw new Error("must not prompt after cancellation"); },
		async abort() {}, async close() { if (!closed) { disposed++; closed = true; } } });
	await closing;
	assert.equal(manager.check(child.logicalAgentId).status, "cancelled");
	assert.equal(disposed, 1);
	assert.throws(() => manager.spawn("More", "spawn"), /closed/);
});

test("queue and total handle limits bound retained state", async () => {
	const f = fixture({ maxQueuedMessages: 1, maxChildren: 1 });
	try {
		const { logicalAgentId: id } = f.manager.spawn("Work", "spawn");
		await tick();
		f.manager.followup(id, "More", "followup");
		assert.throws(() => f.manager.followup(id, "Too much", "followup"), /queue is full/);
		assert.throws(() => f.manager.spawn("Another", "spawn"), /handle limit/);
	} finally { await f.manager.close(); }
});
