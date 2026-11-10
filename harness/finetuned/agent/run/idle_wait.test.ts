import { expect, test } from "bun:test";

import { loadPromptSnapshot } from "../prompts/loader.js";
import { createIdleWaiter, type WatchedExperiment } from "./idle_wait.js";

const prompts = loadPromptSnapshot();

function fixture(views: WatchedExperiment[]) {
	let time = 0;
	const events: string[] = [];
	const waiter = createIdleWaiter({
		list: () => views, prompts, wakeMs: 600_000, pollMs: 1_000, now: () => time,
		sleep: async ms => { time += ms; tick?.(time); }, record: type => events.push(type),
	});
	let tick: ((time: number) => void) | undefined;
	return { waiter, events, onTick: (fn: (time: number) => void) => { tick = fn; } };
}

test("with nothing running and nothing new, the session ends", async () => {
	expect(await fixture([]).waiter()).toBeUndefined();
});

test("a running experiment keeps the session open until it finishes, then the agent is resumed once", async () => {
	const view = { id: "trial-1", status: "running", scope: "pilot" };
	const f = fixture([view]);
	f.onTick(time => { if (time >= 5_000) view.status = "exited"; });
	const resumed = await f.waiter();
	expect(resumed?.text).toContain("- trial-1: exited (pilot)");
	expect(resumed?.text).toContain("You never need to sleep or poll.");
	expect(f.events).toEqual(["solve_waiting_for_experiments", "solve_resumed_after_wait"]);
	expect(await f.waiter()).toBeUndefined();
});

test("a long run wakes the agent periodically while still running", async () => {
	const f = fixture([{ id: "search-1", status: "running" }]);
	const resumed = await f.waiter();
	expect(resumed?.text).toContain("- search-1: running");
	expect(resumed?.text).toContain("after\n10 minutes");
});

test("a run that finished just after the turn ended is still shown before the session ends", async () => {
	const f = fixture([{ id: "trial-2", status: "failed" }]);
	expect((await f.waiter())?.text).toContain("trial-2: failed");
	expect(await f.waiter()).toBeUndefined();
});

test("cancellation ends the wait without resuming", async () => {
	const controller = new AbortController();
	controller.abort();
	expect(await fixture([{ id: "x", status: "running" }]).waiter(controller.signal)).toBeUndefined();
});
