import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import type { ExperimentSupervisor } from "../experiments/supervisor.js";
import type { PromptSnapshot } from "../prompts/loader.js";
import type { TrainingService } from "./service.js";

const json = Type.Any();
const moduleReference = () => Type.Object({
	module: Type.String({ minLength: 1, maxLength: 500 }),
	factory: Type.String({ minLength: 1, maxLength: 200 }),
});

/** Agent-facing framework tools. No process, path, output, or seed knobs leak through. */
export function createHarnessTrainingTools(
	service: TrainingService,
	supervisor: ExperimentSupervisor,
	prompts: PromptSnapshot,
) {
	const id = Type.String({ minLength: 1, maxLength: 64 });
	const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
	return [
		defineTool({
			name: "experiment_start", label: "Start training experiment",
			description: prompts.render("training.start-tool", {}).text,
			parameters: Type.Object({
				schemaVersion: Type.Literal(1),
				hypothesis: Type.String({ minLength: 1, maxLength: 2_000 }),
				pipeline: Type.Intersect([moduleReference(), Type.Object({ parameters: Type.Optional(json) })]),
				cv: Type.Union([
					Type.Object({ kind: Type.Literal("builtin"), scheme: Type.Literal("stratified_kfold"),
						folds: Type.Integer({ minimum: 2 }), repeats: Type.Integer({ minimum: 1 }) }),
					Type.Intersect([moduleReference(), Type.Object({ kind: Type.Literal("factory"),
						repeats: Type.Integer({ minimum: 1 }), options: Type.Optional(json) })]),
				]),
				scope: Type.Union([
					Type.Object({ kind: Type.Literal("pilot"), maxRows: Type.Optional(Type.Integer({ minimum: 2 })),
						maxFolds: Type.Optional(Type.Integer({ minimum: 1 })) }),
					Type.Object({ kind: Type.Literal("promotion") }),
				]),
			}),
			async execute(toolCallId, args, signal) {
				signal?.throwIfAborted();
				return result(await service.start(args, toolCallId));
			},
		}),
		defineTool({
			name: "experiment_status", label: "Training experiment status",
			description: prompts.render("training.status-tool", {}).text,
			parameters: Type.Object({ id: Type.Optional(id) }),
			async execute(_toolCallId, args) { return result(args.id ? supervisor.status(args.id) : supervisor.list()); },
		}),
		defineTool({
			name: "experiment_output", label: "Read training output",
			description: prompts.render("training.output-tool", {}).text,
			parameters: Type.Object({ id, cursor: Type.Optional(Type.Integer({ minimum: 0 })),
				maxBytes: Type.Optional(Type.Integer({ minimum: 256, maximum: 65_536 })) }),
			async execute(_toolCallId, args) { return result(supervisor.output(args.id, args.cursor, args.maxBytes)); },
		}),
		defineTool({
			name: "experiment_stop", label: "Stop training experiment",
			description: prompts.render("training.stop-tool", {}).text,
			parameters: Type.Object({ id, reason: Type.String({ minLength: 1, maxLength: 2_000 }),
				observations: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 })) }),
			async execute(_toolCallId, args, signal) {
				signal?.throwIfAborted();
				return result(await supervisor.stop(args.id, args.reason, args.observations ?? []));
			},
		}),
	];
}
