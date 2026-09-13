import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import type { PromptSnapshot } from "../prompts/loader.js";
import type { ExperimentSupervisor } from "./supervisor.js";

/**
 * The four tools, and only four.
 *
 * There is no `experiment_watch`: pushing updates through the session covers the
 * same need without a tool the agent has to sit in a loop calling. Add one only
 * if push delivery proves insufficient.
 *
 * Each tool validates its own inputs. A `tool_call` hook can reject a call too,
 * but a tool that trusts the hook behaves differently for every other caller.
 */
export function createExperimentTools(source: ExperimentSupervisor | (() => ExperimentSupervisor), prompts: PromptSnapshot) {
	const supervisor = () => typeof source === "function" ? source() : source;
	const id = Type.String({ minLength: 1, maxLength: 64 });
	const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
	return [
		defineTool({
			name: "experiment_start", label: "Start experiment",
			description: prompts.render("experiments.start-tool", {}).text,
			parameters: Type.Object({
				argv: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 64 }),
				cwd: Type.String({ minLength: 1 }),
				hypothesis: Type.String({ minLength: 1, maxLength: 2_000 }),
				scope: Type.String({ minLength: 1, maxLength: 2_000 }),
				expectedGapMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 3_600_000 })),
			}),
			async execute(toolCallId, args, signal) {
				signal?.throwIfAborted();
				return result(supervisor().start(args, toolCallId));
			},
		}),
		defineTool({
			name: "experiment_status", label: "Experiment status",
			description: prompts.render("experiments.status-tool", {}).text,
			parameters: Type.Object({ id: Type.Optional(id) }),
			async execute(_toolCallId, args) {
				return result(args.id ? supervisor().status(args.id) : supervisor().list());
			},
		}),
		defineTool({
			name: "experiment_output", label: "Read experiment output",
			description: prompts.render("experiments.output-tool", {}).text,
			parameters: Type.Object({
				id,
				cursor: Type.Optional(Type.Integer({ minimum: 0 })),
				maxBytes: Type.Optional(Type.Integer({ minimum: 256, maximum: 65_536 })),
			}),
			async execute(_toolCallId, args) {
				return result(supervisor().output(args.id, args.cursor, args.maxBytes));
			},
		}),
		defineTool({
			name: "experiment_stop", label: "Stop experiment",
			description: prompts.render("experiments.stop-tool", {}).text,
			parameters: Type.Object({
				id,
				reason: Type.String({ minLength: 1, maxLength: 2_000 }),
				observations: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 })),
			}),
			async execute(_toolCallId, args, signal) {
				signal?.throwIfAborted();
				return result(await supervisor().stop(args.id, args.reason, args.observations ?? []));
			},
		}),
	];
}
