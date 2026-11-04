/**
 * Research action budget.
 *
 * The budget counts tool calls, not wall time or tokens: API speed varies and
 * output size depends on the task. The agent sees the remaining budget after
 * every tool result, with tiered guidance (explore, focus, wrap up). When the
 * budget is used, only finishing the brief stays allowed for a small number of
 * calls; then every tool is blocked and the session ends. Running out is a
 * normal end, never an error: the stage then reports a partial result.
 */
import { basename } from "node:path";

import type { InlineExtension } from "@earendil-works/pi-coding-agent";

import { HARNESS_CONFIG } from "../harness/config.js";
import type { PromptSnapshot } from "../prompts/loader.js";

export interface ResearchBudgetLimits {
	maxToolCalls: number;
	finalizeToolCalls: number;
	focusAtRemainingPercent: number;
	wrapUpAtRemainingPercent: number;
	/** Upper bound for one research bash call; a call may ask for less, never more. */
	bashTimeoutSeconds: number;
}

export type BudgetPhase = "explore" | "focus" | "wrap_up" | "finalize" | "exhausted";

const FINALIZE_TOOLS = new Set(["read", "check_brief"]);

export class ResearchBudget {
	used = 0;
	private finalizeUsed = 0;
	private lastPhase: BudgetPhase = "explore";

	constructor(
		private readonly prompts: PromptSnapshot,
		readonly limits: ResearchBudgetLimits = HARNESS_CONFIG.research,
		private readonly record?: (type: string, payload: Record<string, unknown>) => void,
	) {}

	get phase(): BudgetPhase {
		if (this.used < this.limits.maxToolCalls) {
			const remainingPercent = 100 * (this.limits.maxToolCalls - this.used) / this.limits.maxToolCalls;
			return remainingPercent <= this.limits.wrapUpAtRemainingPercent ? "wrap_up"
				: remainingPercent <= this.limits.focusAtRemainingPercent ? "focus" : "explore";
		}
		return this.finalizeUsed < this.limits.finalizeToolCalls ? "finalize" : "exhausted";
	}

	get exhausted(): boolean { return this.used >= this.limits.maxToolCalls; }

	/** A repair attempt after failed validation gets a fresh allowance to finish the brief. */
	startRepair(): void {
		if (this.exhausted) this.finalizeUsed = 0;
	}

	private static finishesBrief(toolName: string, input: Record<string, unknown>): boolean {
		if (FINALIZE_TOOLS.has(toolName)) return true;
		return (toolName === "write" || toolName === "edit") && typeof input.path === "string" && basename(input.path) === "research.md";
	}

	/** Called before each tool executes; returns a block decision when the budget forbids it. */
	beforeToolCall(toolName: string, input: Record<string, unknown>): { block: true; reason: string; terminate?: boolean } | undefined {
		// The budget counts calls, so one call must not run unbounded (e.g. a heavy local fit).
		if (toolName === "bash") {
			const requested = typeof input.timeout === "number" && input.timeout > 0 ? input.timeout : Infinity;
			input.timeout = Math.min(requested, this.limits.bashTimeoutSeconds);
		}
		const phase = this.phase;
		if (phase === "exhausted") {
			this.record?.("research_budget_blocked", { tool: toolName, phase });
			return { block: true, terminate: true, reason: this.prompts.render("research.budget-blocked", { detail: "Stop now; the controller validates research.md as it is." }).text };
		}
		if (phase === "finalize") {
			if (!ResearchBudget.finishesBrief(toolName, input)) {
				this.record?.("research_budget_blocked", { tool: toolName, phase });
				return { block: true, reason: this.prompts.render("research.budget-blocked", { detail: "Only read, writing or editing research.md, and check_brief remain." }).text };
			}
			this.finalizeUsed++;
		} else {
			this.used++;
		}
		this.notePhase();
		return undefined;
	}

	private notePhase(): void {
		const phase = this.phase;
		if (phase !== this.lastPhase) {
			this.record?.("research_budget_phase", { from: this.lastPhase, to: phase, used: this.used, limit: this.limits.maxToolCalls });
			this.lastPhase = phase;
		}
	}

	/** The budget line appended to every tool result. */
	statusLine(): string {
		const phase = this.phase;
		const guidance = phase === "explore" ? this.prompts.render("research.budget-explore", {}).text
			: phase === "focus" ? this.prompts.render("research.budget-focus", {}).text
				: phase === "wrap_up" ? this.prompts.render("research.budget-wrap-up", {}).text
					: this.prompts.render("research.budget-finalize", { remaining: String(Math.max(0, this.limits.finalizeToolCalls - this.finalizeUsed)) }).text;
		return this.prompts.render("research.budget-status", {
			used: String(Math.min(this.used, this.limits.maxToolCalls)), limit: String(this.limits.maxToolCalls),
			remaining: String(Math.max(0, this.limits.maxToolCalls - this.used)), guidance: guidance.trim(),
		}).text.trim();
	}

	/** Pi extension: enforce the budget on tool calls and show it after every tool result. */
	extension(): Extract<InlineExtension, { factory: unknown }> & { name: string; factory: (pi: any) => void } {
		return {
			name: "research-budget",
			factory: (pi: any) => {
				pi.on("tool_call", (event: { toolName: string; input: Record<string, unknown> }) => this.beforeToolCall(event.toolName, event.input ?? {}));
				pi.on("tool_result", (event: { content: { type: string; text?: string }[] }) => ({
					content: [...(event.content ?? []), { type: "text", text: this.statusLine() }],
				}));
			},
		};
	}
}
