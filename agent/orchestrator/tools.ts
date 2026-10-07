import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { PromptSnapshot } from "../prompts/loader.js";
import type { Coordinator } from "./coordinator.js";
export function controllerTools(controller: Coordinator, prompts: PromptSnapshot) {
 const id = Type.String({ minLength: 1, maxLength: 256 });
 const ids = Type.Array(id, { maxItems: 32 });
 const mutation = { actionId: id, expectedRevision: Type.Integer({ minimum: 0 }), rationale: Type.String({ minLength: 1, maxLength: 2048 }) };
 const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
 const description = prompts.render("orchestrator.tool", {}).text;
 const tool = (name: string, parameters: any, execute: (args: any, signal?: AbortSignal) => unknown) => defineTool({ name, label: name, description, parameters,
  async execute(_id: string, args: any, signal?: AbortSignal) {
   try { signal?.throwIfAborted(); const value = await execute(args, signal); return result(value); }
   catch (error) { return result({ rejected: true, reason: error instanceof Error ? error.message : "Controller action failed", revision: controller.state.revision }); }
  } });
 return [
  tool("pipeline_status", Type.Object({ cursor: Type.Optional(Type.Integer({ minimum: 0 })) }), args => controller.status(args.cursor)),
  tool("stage_start", Type.Object({ ...mutation, stage: Type.Union(["research", "solve", "evaluate", "refit", "submit"].map(x => Type.Literal(x))), objective: Type.String({ minLength: 1, maxLength: 2048 }), artifactIds: ids, guidance: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })), evidenceIds: Type.Optional(ids) }), args => controller.start(args)),
  tool("stage_status", Type.Object({ invocationId: id }), args => controller.stageStatus(args.invocationId)),
  tool("stage_feedback", Type.Object({ ...mutation, invocationId: id, message: Type.String({ minLength: 1, maxLength: 8192 }), evidenceIds: ids }), args => controller.feedback(args)),
  tool("stage_cancel", Type.Object({ ...mutation, invocationId: id }), args => controller.cancel(args)),
  tool("artifact_inspect", Type.Object({ artifactId: id, offset: Type.Optional(Type.Integer({ minimum: 0 })) }), args => controller.inspect(args.artifactId, args.offset)),
  tool("pipeline_wait", Type.Object({ cursor: Type.Integer({ minimum: 0 }), timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 60000 })) }), (args, signal) => controller.wait(args.cursor, args.timeoutMs, signal)),
  tool("pipeline_finish", Type.Object({ ...mutation, outcome: Type.Union([Type.Literal("finished"), Type.Literal("blocked")]) }), args => controller.finish(args)),
 ];
}
