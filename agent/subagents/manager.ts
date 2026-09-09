import { randomUUID } from "node:crypto";
import type { PromptSnapshot, RenderedPrompt } from "../prompts/loader.js";
import { boundedText, DEFAULT_LIMITS, type ChildIdentity, type ChildResult, type ChildSession,
	type ChildSessionFactory, type ChildView, type SubagentLimits } from "./types.js";

interface Entry {
	view: ChildView;
	queue: RenderedPrompt[];
	abort: AbortController;
	session?: ChildSession;
	work?: Promise<void>;
	cancel?: Promise<ChildView>;
	output?: string;
	truncated?: boolean;
	listeners: Set<() => void>;
}

export interface ManagerOptions {
	parentAgentRunId: string;
	prompts: PromptSnapshot;
	createSession: ChildSessionFactory;
	limits?: Partial<SubagentLimits>;
	/** Must record to the enclosing invocation's sink; prompt bodies are recorded by the session. */
	record(event: string, data: Record<string, unknown>): void;
}

/** Parent-owned child registry. Follow-ups are serialized within each child. */
export class SubagentManager {
	readonly limits: Readonly<SubagentLimits>;
	private entries = new Map<string, Entry>();
	private closed = false;
	private closing?: Promise<void>;

	constructor(private options: ManagerOptions) {
		this.limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
		for (const [key, value] of Object.entries(this.limits)) {
			if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid subagent limit: ${key}`);
		}
	}

	private entry(id: string): Entry {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown child: ${id}`);
		return entry;
	}

	private message(text: string): void {
		if (!text.trim() || Buffer.byteLength(text) > this.limits.maxMessageBytes) {
			throw new Error(`Child message must contain 1..${this.limits.maxMessageBytes} bytes`);
		}
	}

	private admit(): void {
		if (this.closed) throw new Error("Subagent manager is closed");
		if ([...this.entries.values()].filter(entry => entry.view.status === "running").length >= this.limits.maxConcurrent) {
			throw new Error("Subagent concurrency limit reached");
		}
	}

	spawn(task: string, toolCallId: string): ChildView {
		this.message(task);
		this.admit();
		if (this.entries.size >= this.limits.maxChildren) throw new Error("Subagent handle limit reached");
		const identity: ChildIdentity = { logicalAgentId: randomUUID(),
			parentAgentRunId: this.options.parentAgentRunId, spawnToolCallId: toolCallId };
		const entry: Entry = { view: { ...identity, status: "running", queued: 0 },
			queue: [this.options.prompts.render("subagents.start", { task })],
			abort: new AbortController(), listeners: new Set() };
		this.entries.set(identity.logicalAgentId, entry);
		this.options.record("subagent_spawn", { ...identity, limits: this.limits,
			input: { kind: "subagent_task", version: 1, delivery: "initial_prompt", status: "available",
				text: entry.queue[0].text, prompt: entry.queue[0].reference } });
		entry.work = this.run(entry);
		return this.check(identity.logicalAgentId);
	}

	check(id: string): ChildView {
		const entry = this.entry(id);
		return { ...entry.view, queued: entry.queue.length };
	}

	list(): ChildView[] { return [...this.entries.keys()].map(id => this.check(id)); }

	followup(id: string, message: string, toolCallId: string): ChildView {
		if (this.closed) throw new Error("Subagent manager is closed");
		this.message(message);
		const entry = this.entry(id);
		if (entry.abort.signal.aborted || entry.view.status === "failed") throw new Error("Child cannot be continued");
		if (entry.queue.length >= this.limits.maxQueuedMessages) throw new Error("Child follow-up queue is full");
		if (entry.view.status !== "running") this.admit();
		const prompt = this.options.prompts.render("subagents.followup", { message });
		entry.queue.push(prompt);
		this.options.record("subagent_followup", { ...entry.view, toolCallId,
			input: { kind: "subagent_followup", version: 1, delivery: "initial_prompt", status: "available",
				text: prompt.text, prompt: prompt.reference } });
		// Stale replies must not look like the response to the new request.
		entry.output = undefined;
		entry.truncated = undefined;
		if (entry.view.status !== "running") {
			entry.view.status = "running";
			entry.work = this.run(entry);
		}
		return this.check(id);
	}

	private async run(entry: Entry): Promise<void> {
		try {
			entry.session ??= await this.options.createSession(entry.view, entry.abort.signal);
			entry.view.agentRunId = entry.session.agentRunId;
			entry.view.piSessionId = entry.session.piSessionId;
			while (entry.queue.length && !entry.abort.signal.aborted) {
				const output = await entry.session.prompt(entry.queue.shift()!);
				const bounded = boundedText(output, this.limits.maxResultBytes);
				entry.output = bounded.text;
				entry.truncated = bounded.truncated;
			}
			if (!entry.abort.signal.aborted) entry.view.status = "idle";
		} catch (error) {
			if (!entry.abort.signal.aborted) {
				entry.view.status = "failed";
				entry.view.error = boundedText(error instanceof Error ? error.message : String(error), 2048).text;
			}
		} finally {
			if (entry.abort.signal.aborted) entry.view.status = "cancelled";
			if (entry.view.status === "failed" || entry.view.status === "cancelled") {
				entry.queue = [];
				try { await entry.session?.close(); }
				catch (error) { entry.view.error = boundedText(String(error), 2048).text; }
			}
			this.options.record("subagent_settled", { ...entry.view, truncated: entry.truncated });
			for (const listener of entry.listeners) listener();
		}
	}

	private result(id: string): ChildResult {
		const entry = this.entry(id);
		const view = this.check(id);
		return view.status === "idle" ? { ...view, output: entry.output, truncated: entry.truncated } : view;
	}

	async wait(id: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<ChildResult> {
		if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw new Error("Invalid wait timeout");
		signal?.throwIfAborted();
		const entry = this.entry(id);
		if (entry.view.status !== "running" || timeoutMs === 0) return this.result(id);
		await new Promise<void>((resolve, reject) => {
			const done = () => { cleanup(); resolve(); };
			const aborted = () => { cleanup(); reject(signal!.reason ?? new Error("Wait aborted")); };
			const timer = setTimeout(done, timeoutMs);
			const cleanup = () => {
				clearTimeout(timer);
				entry.listeners.delete(done);
				signal?.removeEventListener("abort", aborted);
			};
			entry.listeners.add(done);
			signal?.addEventListener("abort", aborted, { once: true });
		});
		return this.result(id);
	}

	cancel(id: string): Promise<ChildView> {
		const entry = this.entry(id);
		return entry.cancel ??= (async () => {
			entry.abort.abort();
			entry.queue = [];
			await entry.session?.abort();
			await entry.work;
			await entry.session?.close();
			entry.view.status = "cancelled";
			this.options.record("subagent_cancelled", { ...entry.view });
			return this.check(id);
		})();
	}

	close(): Promise<void> {
		this.closed = true;
		return this.closing ??= (async () => {
			const results = await Promise.allSettled([...this.entries.values()].map(async entry => {
				if (entry.view.status === "running") await this.cancel(entry.view.logicalAgentId);
				else await entry.session?.close();
			}));
			const errors = results.filter(result => result.status === "rejected");
			if (errors.length) throw new AggregateError(errors.map(result => result.reason), "Child cleanup failed");
		})();
	}
}
