/**
 * Optional experiment supervision.
 *
 * Nothing in the registered pipeline receives these tools yet. A stage opts in
 * by creating a scope, binding the observed session, and attaching the tools.
 * Closing the scope is what stops a detached fit outliving the run.
 */

import type { PromptSnapshot } from "../prompts/loader.js";
import { ExperimentSupervisor, type SupervisorOptions } from "./supervisor.js";
import { createExperimentTools } from "./tools.js";
import type { Update } from "./types.js";

export { ExperimentSupervisor } from "./supervisor.js";
export { createExperimentTools } from "./tools.js";
export { UpdateGate, renderUpdate } from "./updates.js";
export { cpuPercent, cpuSecondsFromTicks, sampleAvailable, sampleGroup } from "./sampler.js";
export type {
	ExperimentRecord, ExperimentSpec, ExperimentStatus, ExperimentView,
	ResourceSample, SupervisorLimits, Update, UpdateKind,
} from "./types.js";
export { DEFAULT_LIMITS } from "./types.js";

/** The part of `AgentSession` a wake needs. Narrow on purpose, so tests can supply it. */
export interface Wakeable {
	readonly isStreaming: boolean;
	steer(text: string): Promise<void>;
	sendCustomMessage(
		message: { customType: string; content: string; display: boolean; details?: unknown },
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void>;
}

export function createExperiments(options: Omit<SupervisorOptions, "deliver"> & {
	prompts: PromptSnapshot;
	session?: Wakeable;
	signal?: AbortSignal;
}) {
	options.signal?.throwIfAborted();
	let session = options.session;
	const supervisor = new ExperimentSupervisor({
		...options,
		deliver: (text, update) => deliver(text, update),
	});

	/**
	 * One channel, never both.
	 *
	 * `steer()` delivers after the current turn's tool calls finish and before
	 * the next model call, so it reaches a running agent. An idle agent has no
	 * turn to attach to, and only `triggerTurn` starts one. Sending through both
	 * would deliver the same measurement twice.
	 */
	async function deliver(text: string, update: Update): Promise<void> {
		if (!session) {
			options.record?.("experiment_update_undelivered", { experiment_id: update.id, kind: update.kind });
			return;
		}
		if (session.isStreaming) {
			await session.steer(text);
			return;
		}
		await session.sendCustomMessage(
			{ customType: "experiment_update", content: text, display: true, details: { id: update.id, kind: update.kind } },
			{ triggerTurn: true },
		);
	}

	const tools = createExperimentTools(supervisor, options.prompts);
	const toolPrompts = (["experiments.start-tool", "experiments.status-tool",
		"experiments.output-tool", "experiments.stop-tool"] as const)
		.map((id) => options.prompts.render(id, {}).reference);

	let closing: Promise<void> | undefined;
	const close = () => closing ??= supervisor.close();
	const onAbort = () => { void close().catch(() => undefined); };
	options.signal?.addEventListener("abort", onAbort, { once: true });

	return {
		supervisor,
		tools,
		toolPrompts,
		/** Attach after the session is observed, before its first prompt. */
		bindSession(target: Wakeable) { session = target; },
		close: async () => {
			options.signal?.removeEventListener("abort", onAbort);
			await close();
		},
	};
}
