import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { PromptSnapshot } from "../prompts/loader.js";

/** Counts attempted, admitted tool calls, including errors. Blocks all excess calls. */
export class ScoutBudget {
 used = 0;
 blocked = 0;
 constructor(readonly limit: number, private prompts: PromptSnapshot) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid scout budget");
 }
 admit(): { block: true; reason: string; terminate: boolean } | undefined {
  if (this.used < this.limit) { this.used++; return; }
  this.blocked++;
  return { block: true, reason: this.prompts.render("team.finish", {}).text, terminate: this.blocked > 1 };
 }
 counter(): string {
  return this.prompts.render("team.counter", { used: String(this.used), budget: String(this.limit) }).text.trim()
   + (this.used >= this.limit ? ` ${this.prompts.render("team.finish", {}).text.trim()}` : "");
 }
 extension(): InlineExtension {
  return { name: "scout-budget", factory: pi => {
   pi.on("tool_call", () => this.admit());
   pi.on("tool_result", event => ({ content: [...event.content, { type: "text", text: this.counter() }] }));
  } };
 }
}
