import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";

import type { ExperimentSupervisor } from "../experiments/supervisor.js";
import type { PromptSnapshot } from "../prompts/loader.js";
import { ExperimentRequestError } from "./contract.js";
import type { TrainingService } from "./service.js";

const json = Type.Any();
const moduleReference = () => Type.Object({
	module: Type.String({ minLength: 1, maxLength: 500 }),
	factory: Type.String({ minLength: 1, maxLength: 200 }),
});

/** Render all structural and pipeline problems through the shared rejection prompt. */
export function renderRejection(prompts: PromptSnapshot, error: ExperimentRequestError): string {
	return prompts.render("training.request-rejected", {
		count: String(error.issues.length),
		errors: JSON.stringify(error.issues, null, 2),
	}).text;
}

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
            name: "experiment_resume", label: "Resume interrupted training",
            description: prompts.render("training.resume-tool", {}).text,
            parameters: Type.Object({ id, acceptEstimatedSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })) }),
            async execute(_toolCallId, args, signal) {
                signal?.throwIfAborted();
                return result(await service.resume(args.id, args.acceptEstimatedSeconds));
            },
        }),
		defineTool({
			name: "experiment_start", label: "Start training experiment",
			description: prompts.render("training.start-tool", {}).text,
			// Deliberately loose: the harness validates every field itself so all
			// problems come back together in one documented shape.
			parameters: Type.Object({
				schemaVersion: Type.Union([Type.Literal(1), Type.Literal(2)]),
				hypothesis: Type.String({ minLength: 1, maxLength: 2_000 }),
				commit: Type.Optional(Type.String({ maxLength: 200 })),
				pipeline: Type.Intersect([moduleReference(), Type.Object({
					parameters: Type.Optional(json),
					estimatorParams: Type.Optional(json),
				})]),
				search: Type.Optional(Type.Object({
					space: json,
					sampler: Type.Optional(Type.String()),
					maxConfigs: Type.Optional(Type.Integer()),
					pruning: Type.Optional(Type.Boolean()),
					acceptEstimatedSeconds: Type.Optional(Type.Number()),
				})),
				cv: json,
				scope: json,
			}),
			async execute(toolCallId, args, signal) {
				signal?.throwIfAborted();
				try {
					const started = await service.start(args, toolCallId);
					return result({ ...started, budgetConsumed: true });
				} catch (error) {
					if (error instanceof ExperimentRequestError) throw new Error(renderRejection(prompts, error));
					throw error;
				}
			},
		}),
		defineTool({
			name: "experiment_status", label: "Training experiment status",
			description: prompts.render("training.status-tool", {}).text,
			parameters: Type.Object({ id: Type.Optional(id) }),
			async execute(_toolCallId, args) {
				if (args.id) return result({ ...supervisor.status(args.id), trial: service.describe(args.id) });
				return result({ experiments: supervisor.list(), leaderboard: service.leaderboard() });
			},
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
