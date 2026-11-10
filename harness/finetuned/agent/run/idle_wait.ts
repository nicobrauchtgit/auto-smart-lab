/**
 * Keep a solve session open while the agent's own experiments run.
 *
 * When the agent ends its turn, the session would otherwise end and close
 * training, discarding running trials. Instead the harness waits until an
 * experiment reaches a terminal state, or `wakeMs` passes while one is still
 * running, and resumes the same conversation. It ends only when nothing is
 * running and every terminal experiment has been shown to the agent.
 */
import type { PromptSnapshot, RenderedPrompt } from "../prompts/loader.js";

export interface WatchedExperiment { id: string; status: string; scope?: string; hypothesis?: string; elapsedSeconds?: number }

export function createIdleWaiter(options: {
	list: () => WatchedExperiment[];
	prompts: PromptSnapshot;
	wakeMs: number;
	pollMs?: number;
	record?: (type: string, payload: Record<string, unknown>) => void;
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}) {
	const reported = new Set<string>();
	const now = options.now ?? Date.now;
	const pollMs = options.pollMs ?? 2_000;
	const sleep = options.sleep ?? ((ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
	}));
	const unreported = () => options.list().filter(view => view.status !== "running" && !reported.has(view.id));
	const running = () => options.list().filter(view => view.status === "running");
	const render = (views: WatchedExperiment[]): RenderedPrompt => {
		for (const view of views) if (view.status !== "running") reported.add(view.id);
		const lines = views.map(view => `- ${view.id}: ${view.status}${view.scope ? ` (${view.scope})` : ""}${view.elapsedSeconds !== undefined ? `, ${Math.round(view.elapsedSeconds)} s` : ""}${view.hypothesis ? ` — ${view.hypothesis.slice(0, 120)}` : ""}`);
		return options.prompts.render("solve.idle-resume", { experiments: lines.join("\n"), wakeMinutes: String(Math.round(options.wakeMs / 60_000)) });
	};
	return async (signal?: AbortSignal): Promise<RenderedPrompt | undefined> => {
		if (signal?.aborted) return undefined;
		const finished = unreported();
		if (finished.length) return render([...finished, ...running()]);
		if (!running().length) return undefined;
		const started = now();
		options.record?.("solve_waiting_for_experiments", { running: running().map(view => view.id), wake_ms: options.wakeMs });
		while (!signal?.aborted) {
			await sleep(pollMs, signal);
			const done = unreported();
			if (done.length || !running().length || now() - started >= options.wakeMs) {
				options.record?.("solve_resumed_after_wait", { waited_ms: now() - started, finished: done.map(view => view.id), running: running().map(view => view.id) });
				return render([...done, ...running()]);
			}
		}
		return undefined;
	};
}
