import { expect, test } from "bun:test";

import { promptWithStallRetries, StallWatch } from "./stall.js";

function clock(start = 0) {
	let now = start;
	return { now: () => now, advance: (ms: number) => { now += ms; } };
}

test("a slow request that keeps streaming is never a stall", () => {
	const time = clock();
	const stalls: number[] = [];
	const watch = new StallWatch(60_000, silent => stalls.push(silent), time.now);
	watch.requestStarted();
	for (let i = 0; i < 30; i++) { time.advance(50_000); watch.observe({ type: "message_update" }); expect(watch.check()).toBe(false); }
	expect(stalls).toEqual([]);
});

test("silence while a request is in flight is a stall, raised once", () => {
	const time = clock();
	const stalls: number[] = [];
	const watch = new StallWatch(60_000, silent => stalls.push(silent), time.now);
	watch.requestStarted();
	time.advance(61_000);
	expect(watch.check()).toBe(true);
	expect(watch.check()).toBe(false);
	expect(stalls).toEqual([61_000]);
	expect(watch.consumeStall()).toBe(true);
	expect(watch.consumeStall()).toBe(false);
});

test("tool execution and finished requests never count as stalls", () => {
	const time = clock();
	const watch = new StallWatch(60_000, () => { throw new Error("no stall expected"); }, time.now);
	watch.requestStarted();
	watch.observe({ type: "message_end", message: { role: "assistant" } });
	time.advance(3_600_000); // a long bash or training call
	expect(watch.check()).toBe(false);
});

test("a stalled request is resumed in the same conversation, a bounded number of times", async () => {
	const requests: string[] = [];
	const events: string[] = [];
	let stalled = false;
	const watch = { consumeStall: () => { const value = stalled; stalled = false; return value; } };
	let calls = 0;
	const output = await promptWithStallRetries({
		prompt: async request => { requests.push(request); if (calls++ < 2) { stalled = true; throw new Error("Model session failed: aborted"); } return "done"; },
		first: "task", resume: () => "resume", watch, retries: 2, stallMs: 600_000, record: type => events.push(type),
	});
	expect(output).toBe("done");
	expect(requests).toEqual(["task", "resume", "resume"]);
	expect(events).toEqual(["model_stall_retry", "model_stall_retry"]);
	stalled = false; calls = 0;
	await expect(promptWithStallRetries({
		prompt: async () => { stalled = true; throw new Error("Model session failed: aborted"); },
		first: "task", resume: () => "resume", watch, retries: 1, stallMs: 600_000,
	})).rejects.toThrow("Model requests stalled 2 times (no output for 10 minutes each)");
});

test("errors that are not stalls propagate unchanged", async () => {
	await expect(promptWithStallRetries({
		prompt: async () => { throw new Error("provider rejected the request"); },
		first: "task", resume: () => "resume", watch: { consumeStall: () => false }, retries: 3, stallMs: 1,
	})).rejects.toThrow("provider rejected the request");
});
