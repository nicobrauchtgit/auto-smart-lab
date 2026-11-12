import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { PromptSnapshot } from "../prompts/loader.js";

type Content = { type: string; id?: string };
type AnyMessage = { role: string; content?: unknown; stopReason?: string };
const toolCalls = (message: AnyMessage) => Array.isArray(message.content)
 ? (message.content as Content[]).filter(part => part.type === "toolCall") : [];

/**
 * Counts every tool call the model emits, at the assistant message, before Pi
 * resolves the tool or validates its arguments. Unknown tools and invalid
 * arguments therefore use budget like any other call.
 *
 * Calls within the budget are admitted; later calls are blocked with
 * finish-up feedback. Every call occurrence counts: calls that share an ID,
 * within a message or across turns, are separate calls. Each admission is
 * consumed by exactly one execution and expires at the next assistant
 * message, so executions never exceed `used`. The model gets one more tool-call turn after the budget
 * is spent; tool calls in any later turn are removed from that message, which
 * ends the agent loop with whatever text it wrote. Model turns are bounded by
 * `maxTurns` (default budget + 2, the most a compliant scout can need) the
 * same way.
 */
export class ScoutBudget {
 /** Admitted calls, at most `limit`. */
 used = 0;
 /** Every tool call the model emitted, including ones Pi rejected. */
 attempted = 0;
 /** Calls beyond the budget, blocked or removed. */
 blocked = 0;
 turns = 0;
 stopped?: "budget" | "turns" | "ended";
 /** Epoch milliseconds of the last session event; read by the stall guard. */
 lastActivity = Date.now();
 readonly maxTurns: number;
 /** Admit/block decision per call of the latest assistant message, queued by ID in call order. */
 private decisions = new Map<string, boolean[]>();
 private overBudgetTurns = 0;
 private ended = false;
 /** What a blocked call and the spent counter tell the agent: write its final answer now. */
 private readonly onCharge?: (used: number) => void;
 private readonly finish: "team.finish" | "team.lead-finish";
 /**
  * `used` continues a resumed run from the calls it already used; `finishPrompt`
  * is the finish-up instruction (the lead's differs from the scouts').
  */
 constructor(readonly limit: number, private prompts: PromptSnapshot, options: { maxTurns?: number; finishPrompt?: "team.finish" | "team.lead-finish"; used?: number; onCharge?: (used: number) => void } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid scout budget");
  this.onCharge = options.onCharge;
  this.finish = options.finishPrompt ?? "team.finish";
  this.used = Math.min(limit, Math.max(0, Math.floor(options.used ?? 0)));
  this.maxTurns = options.maxTurns ?? limit + 2;
  if (!Number.isSafeInteger(this.maxTurns) || this.maxTurns < 1) throw new Error("Invalid scout turn limit");
 }
 /** Accounts one finished assistant message; returns a replacement when its tool calls must not run. */
 assistant<T extends AnyMessage>(message: T): T | undefined {
  this.turns++;
  // Admissions the previous message left unused (Pi rejected those calls) expire.
  this.decisions.clear();
  const calls = toolCalls(message);
  if (!calls.length) return;
  this.attempted += calls.length;
  const overBudget = this.used >= this.limit;
  if (this.ended || this.turns >= this.maxTurns || (overBudget && this.overBudgetTurns >= 1)) {
   this.blocked += calls.length;
   this.stopped = this.ended ? "ended" : overBudget ? "budget" : "turns";
   return { ...message, content: (message.content as Content[]).filter(part => part.type !== "toolCall"), stopReason: "stop" };
  }
  if (overBudget) this.overBudgetTurns++;
  for (const call of calls) {
   const admitted = this.used < this.limit && typeof call.id === "string";
   if (admitted) { this.used++; this.onCharge?.(this.used); } else this.blocked++;
   if (typeof call.id === "string") this.decisions.set(call.id, [...this.decisions.get(call.id) ?? [], admitted]);
  }
 }
 /**
  * Pi's pre-execution hook, called once per call in message order on both its
  * sequential and parallel paths. Consumes one decision of that ID: a repeated
  * ID gets its next occurrence's decision, and an ID with none left is blocked.
  */
 admit(toolCallId: string): { block: true; reason: string } | undefined {
  if (this.decisions.get(toolCallId)?.shift()) return;
  return { block: true, reason: this.prompts.render(this.finish, {}).text };
 }
 /** No further tool calls (the work was handed over): later ones are removed and the agent loop ends with its text. */
 end(): void { this.ended = true; this.decisions.clear(); }
 get exhausted(): boolean { return this.used >= this.limit; }
 counter(): string {
  return this.prompts.render("team.counter", { used: String(this.used), budget: String(this.limit) }).text.trim()
   + (this.used >= this.limit && !this.ended ? ` ${this.prompts.render(this.finish, {}).text.trim()}` : "");
 }
 extension(): InlineExtension {
  return { name: "scout-budget", factory: pi => {
   const touch = () => { this.lastActivity = Date.now(); };
   for (const event of ["turn_start", "message_start", "message_update", "tool_execution_start", "tool_execution_update", "tool_execution_end"] as const) pi.on(event as "turn_start", touch);
   pi.on("tool_call", event => this.admit(event.toolCallId));
   // Every tool result, including Pi's own rejections, carries the counter.
   pi.on("message_end", event => {
    touch();
    const message = event.message as AnyMessage;
    if (message.role === "assistant") {
     const replacement = this.assistant(message);
     return replacement ? { message: replacement as typeof event.message } : undefined;
    }
    if (message.role === "toolResult" && Array.isArray(message.content)) {
     return { message: { ...message, content: [...message.content, { type: "text", text: this.counter() }] } as typeof event.message };
    }
   });
  } };
 }
}

/**
 * Detects stuck sessions; not a work budget. Aborts the session when no
 * session event arrives for `stallMs`, or when it runs longer than `wallMs`.
 * Returns after abort even if the session never settles.
 */
export async function guardScoutSession<T>(run: Promise<T>, options: {
 abort(): unknown; lastActivity(): number; stallMs: number; wallMs: number;
 now?: () => number; pollMs?: number; settleMs?: number;
}): Promise<{ value: T; stopped?: undefined } | { stopped: "stall" | "wall" }> {
 const now = options.now ?? Date.now;
 const started = now();
 let timer: ReturnType<typeof setInterval> | undefined;
 const stall = new Promise<"stall" | "wall">(accept => {
  timer = setInterval(() => {
   if (now() - started >= options.wallMs) accept("wall");
   else if (now() - options.lastActivity() >= options.stallMs) accept("stall");
  }, options.pollMs ?? Math.min(30_000, Math.max(10, Math.floor(options.stallMs / 4))));
 });
 run.catch(() => undefined);
 try {
  const first = await Promise.race([run.then(value => ({ value })), stall.then(reason => ({ reason }))]);
  if ("value" in first) return { value: first.value };
  // Do not await abort: a stuck session may never become idle.
  void Promise.resolve().then(() => options.abort()).catch(() => undefined);
  let settle: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([run.catch(() => undefined), new Promise(accept => { settle = setTimeout(accept, options.settleMs ?? 30_000); })]);
  clearTimeout(settle);
  return { stopped: first.reason };
 } finally { clearInterval(timer); }
}
