import { expect, test } from "bun:test";

import { loadPromptSnapshot } from "../prompts/loader.js";
import { ResearchBudget } from "./budget.js";

const prompts = loadPromptSnapshot();
const limits = { maxToolCalls: 10, finalizeToolCalls: 2, focusAtRemainingPercent: 50, wrapUpAtRemainingPercent: 20, bashTimeoutSeconds: 600 };

test("the agent sees its remaining budget with tiered guidance", () => {
	const events: string[] = [];
	const budget = new ResearchBudget(prompts, limits, (type, payload) => events.push(`${type}:${payload.to ?? payload.tool}`));
	expect(budget.statusLine()).toContain("used: 0 of 10; remaining: 10. Explore broadly");
	for (let i = 0; i < 5; i++) expect(budget.beforeToolCall("bash", {})).toBeUndefined();
	expect(budget.phase).toBe("focus");
	expect(budget.statusLine()).toContain("Stop broad exploration");
	for (let i = 0; i < 3; i++) budget.beforeToolCall("bash", {});
	expect(budget.phase).toBe("wrap_up");
	expect(budget.statusLine()).toContain("Write research.md now");
	expect(events).toEqual(["research_budget_phase:focus", "research_budget_phase:wrap_up"]);
});

test("after the budget only finishing the brief is allowed, then every tool is blocked", () => {
	const budget = new ResearchBudget(prompts, limits);
	for (let i = 0; i < 10; i++) budget.beforeToolCall("bash", {});
	expect(budget.phase).toBe("finalize");
	expect(budget.beforeToolCall("bash", {})).toMatchObject({ block: true });
	expect(budget.beforeToolCall("web_search", {})).toMatchObject({ block: true });
	expect(budget.beforeToolCall("write", { path: "analysis/x.py" })).toMatchObject({ block: true });
	expect(budget.statusLine()).toContain("Only these remain for 2 more calls");
	expect(budget.beforeToolCall("write", { path: "/w/research.md", content: "x" })).toBeUndefined();
	expect(budget.beforeToolCall("check_brief", {})).toBeUndefined();
	expect(budget.phase).toBe("exhausted");
	expect(budget.beforeToolCall("check_brief", {})).toMatchObject({ block: true, terminate: true });
});

test("a repair attempt gets a fresh allowance to finish the brief, not more exploration", () => {
	const budget = new ResearchBudget(prompts, limits);
	for (let i = 0; i < 12; i++) budget.beforeToolCall(i < 10 ? "bash" : "check_brief", {});
	expect(budget.phase).toBe("exhausted");
	budget.startRepair();
	expect(budget.phase).toBe("finalize");
	expect(budget.beforeToolCall("bash", {})).toMatchObject({ block: true });
	expect(budget.beforeToolCall("edit", { path: "research.md" })).toBeUndefined();
});

test("an unused budget carries into the repair attempt unchanged", () => {
	const budget = new ResearchBudget(prompts, limits);
	for (let i = 0; i < 3; i++) budget.beforeToolCall("bash", {});
	budget.startRepair();
	expect(budget.used).toBe(3);
	expect(budget.phase).toBe("explore");
});

test("the extension blocks over-budget calls and appends the budget line to tool results", () => {
	const budget = new ResearchBudget(prompts, { ...limits, maxToolCalls: 1, finalizeToolCalls: 1 });
	const handlers: Record<string, (event: any) => any> = {};
	budget.extension().factory({ on: (name: string, handler: any) => { handlers[name] = handler; } } as any);
	expect(handlers.tool_call({ toolName: "bash", input: {} })).toBeUndefined();
	const result = handlers.tool_result({ content: [{ type: "text", text: "output" }] });
	expect(result.content[0].text).toBe("output");
	expect(result.content[1].text).toContain("<budget>Research tool calls used: 1 of 1; remaining: 0.");
	expect(handlers.tool_call({ toolName: "bash", input: {} })).toMatchObject({ block: true });
});

test("every research bash call is bounded by the configured timeout", () => {
	const budget = new ResearchBudget(prompts, limits);
	const unbounded: Record<string, unknown> = { command: "python analysis/heavy.py" };
	budget.beforeToolCall("bash", unbounded);
	expect(unbounded.timeout).toBe(600);
	const longer: Record<string, unknown> = { command: "x", timeout: 3600 };
	budget.beforeToolCall("bash", longer);
	expect(longer.timeout).toBe(600);
	const shorter: Record<string, unknown> = { command: "x", timeout: 30 };
	budget.beforeToolCall("bash", shorter);
	expect(shorter.timeout).toBe(30);
});
