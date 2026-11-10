/**
 * Stall detection for model requests.
 *
 * Wall time is not a budget: a slow but progressing request is never stopped.
 * A request counts as stalled only when no streamed event arrived for
 * `stallMs` while it was in flight. Tool execution never counts as a stall.
 */
export class StallWatch {
	private last = 0;
	private inFlight = false;
	private stalled = false;
	private timer?: ReturnType<typeof setInterval>;

	constructor(
		private readonly stallMs: number,
		private readonly onStall: (silentMs: number) => void,
		private readonly now: () => number = Date.now,
	) {}

	/** A model request was sent. */
	requestStarted(): void { this.inFlight = true; this.last = this.now(); }

	/** Any streamed session event; the assistant message end closes the request. */
	observe(event: { type: string; message?: { role?: string } }): void {
		this.last = this.now();
		if ((event.type === "message_end" && event.message?.role === "assistant") || event.type === "agent_end") this.inFlight = false;
	}

	/** Checks once; exposed for tests. Returns true when a stall was raised. */
	check(): boolean {
		if (!this.inFlight) return false;
		const silent = this.now() - this.last;
		if (silent < this.stallMs) return false;
		this.inFlight = false;
		this.stalled = true;
		this.onStall(silent);
		return true;
	}

	start(intervalMs = Math.max(1_000, Math.min(30_000, Math.floor(this.stallMs / 10)))): void {
		this.stop();
		this.timer = setInterval(() => this.check(), intervalMs);
		this.timer.unref?.();
	}

	stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

	/** True once after a stall was raised, so the caller can tell a stall abort from other errors. */
	consumeStall(): boolean { const value = this.stalled; this.stalled = false; return value; }
}

/**
 * Prompt, and when a request stalls, resume the same conversation with
 * `resume()`, at most `retries` times. Other errors propagate unchanged.
 */
export async function promptWithStallRetries<T>(options: {
	prompt: (request: T) => Promise<string>;
	first: T;
	resume: () => T;
	watch: Pick<StallWatch, "consumeStall">;
	retries: number;
	stallMs: number;
	signal?: AbortSignal;
	record?: (type: string, payload: Record<string, unknown>) => void;
}): Promise<string> {
	let request = options.first;
	for (let retry = 0; ; retry++) {
		try { return await options.prompt(request); }
		catch (error) {
			if (!options.watch.consumeStall() || options.signal?.aborted) throw error;
			if (retry >= options.retries) {
				throw new Error(`Model requests stalled ${retry + 1} times (no output for ${Math.round(options.stallMs / 60000)} minutes each)`);
			}
			options.record?.("model_stall_retry", { retry: retry + 1, max_retries: options.retries });
			request = options.resume();
		}
	}
}
