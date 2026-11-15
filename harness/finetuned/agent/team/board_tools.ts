import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { PromptSnapshot } from "../prompts/loader.js";
import { createBoard, type BoardActor, type Contribution, type BoardQuery } from "./board.js";
import { validRef } from "./journal.js";
export const BOARD_TOOLS = ["findings_read", "finding_write", "finding_resolve"] as const;
const exact = (input: object, keys: string[]) => { if (Object.keys(input).some(key => !keys.includes(key))) throw new Error("Unexpected board argument"); };
export function createBoardTools(board: ReturnType<typeof createBoard>, actor: BoardActor, prompts: PromptSnapshot,
 onRead?: (cursor: number, ids: string[]) => void) {
 const reply = (data: unknown) => ({content: [{type: "text" as const, text: JSON.stringify(data)}], details: {}});
 return [defineTool({name: "findings_read", label: "Read findings", description: prompts.render("team.board-read", {}).text,
  parameters: Type.Object({since: Type.Optional(Type.Integer({minimum: 0})), limit: Type.Optional(Type.Integer({minimum: 1, maximum: 100})),
   taskId: Type.Optional(Type.String()), includeOtherTasks: Type.Optional(Type.Boolean()), kinds: Type.Optional(Type.Array(Type.Union([Type.Literal("fact"),Type.Literal("idea"),Type.Literal("decision"),Type.Literal("defect"),Type.Literal("result")]))),
   runId: Type.Optional(Type.String()), datasetSha256: Type.Optional(Type.String()), text: Type.Optional(Type.String({maxLength: 500})), ids: Type.Optional(Type.Array(Type.String(), {maxItems: 100}))}, {additionalProperties: false}),
  async execute(_id, args) {
   exact(args, ["since", "limit", "taskId", "includeOtherTasks", "kinds", "runId", "datasetSha256", "text", "ids"]);
   const page = await board.read(actor.taskId, args as BoardQuery); onRead?.(page.cursor, page.entries.map(row => row.id)); return reply(page);
  }}),
 defineTool({name: "finding_write", label: "Write finding", description: prompts.render("team.board-write", {}).text,
  parameters: Type.Object({requestId: Type.String({minLength: 1, maxLength: 200}), kind: Type.Union([Type.Literal("fact"),Type.Literal("idea"),Type.Literal("decision"),Type.Literal("defect")]),
   title: Type.String({minLength: 1, maxLength: 100}), text: Type.String({minLength: 1, maxLength: 800}), refs: Type.Optional(Type.Array(Type.Any(), {maxItems: 20}))}, {additionalProperties: false}),
  async execute(_id, args, signal) {
   exact(args, ["requestId", "kind", "title", "text", "refs"]);
   if (args.refs?.some(ref => !validRef(ref))) throw new Error("Invalid finding reference");
   const {requestId, ...entry} = args;
   const saved = await board.write(actor, entry as Contribution, requestId, signal);
   onRead?.(saved.cursor, [saved.id]); return reply(saved);
  }}),
 defineTool({name: "finding_resolve", label: "Supersede finding", description: prompts.render("team.board-resolve", {}).text,
  parameters: Type.Object({id: Type.String({minLength: 1}), supersededBy: Type.Optional(Type.String({minLength: 1}))}, {additionalProperties: false}),
  async execute(_id, args, signal) {exact(args, ["id", "supersededBy"]); return reply(await board.resolve(actor, args.id, args.supersededBy, signal));}
 })];
}
