import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { ScoutBudget, guardScoutSession } from "./budget.js";
import { createScouts } from "./scouts.js";
import { readFindings } from "./journal.js";
const prompts = loadPromptSnapshot();
const call = (id: string, name = "read") => ({type: "toolCall", id, name, arguments: {}});

test("every emitted call counts at its message; one finish turn, then calls are removed", () => {
 const budget = new ScoutBudget(2, prompts);
 expect(budget.assistant({role: "assistant", content: [call("a"), call("b", "no_such_tool")]})).toBeUndefined();
 expect(budget.used).toBe(2); expect(budget.attempted).toBe(2); expect(budget.counter()).toContain("final sourced bullets");
 expect(budget.admit("a", "read")).toBeUndefined(); expect(budget.admit("b", "no_such_tool")).toBeUndefined();
 // Finish turn: calls are blocked with finish feedback, not executed.
 expect(budget.assistant({role: "assistant", content: [call("c"), call("d")]})).toBeUndefined();
 expect(budget.admit("c", "read")?.block).toBe(true); expect(budget.blocked).toBe(2);
 // Any later tool call ends the loop; text survives.
 const stripped = budget.assistant({role: "assistant", stopReason: "toolUse", content: [{type: "text", text: "- fact: kept"}, call("e")]});
 expect(stripped?.content).toEqual([{type: "text", text: "- fact: kept"}]); expect(stripped?.stopReason).toBe("stop");
 expect(budget.stopped).toBe("budget"); expect(budget.used).toBe(2); expect(budget.attempted).toBe(5);
});

test("a reused ID is a separate call; each admission allows one execution and expires with its message", () => {
 const budget = new ScoutBudget(2, prompts);
 budget.assistant({role: "assistant", content: [call("a"), call("a"), call("a")]});
 expect(budget.used).toBe(2); expect(budget.blocked).toBe(1); expect(budget.attempted).toBe(3);
 expect(budget.admit("a", "read")).toBeUndefined(); expect(budget.admit("a", "read")).toBeUndefined(); expect(budget.admit("a", "read")?.block).toBe(true);
 expect(budget.admit("a", "read")?.block).toBe(true);
 // An admission Pi never used (it rejected the call) does not carry into the finish turn.
 const unused = new ScoutBudget(1, prompts);
 unused.assistant({role: "assistant", content: [call("x", "no_such_tool")]});
 unused.assistant({role: "assistant", content: [call("x")]});
 expect(unused.admit("x", "read")?.block).toBe(true);
});

test("model turns are bounded even within the call budget", () => {
 const budget = new ScoutBudget(10, prompts, {maxTurns: 3});
 for (const id of ["a", "b"]) expect(budget.assistant({role: "assistant", content: [call(id)]})).toBeUndefined();
 expect(budget.assistant({role: "assistant", content: [call("c")]})?.content).toEqual([]);
 expect(budget.stopped).toBe("turns"); expect(budget.used).toBe(2);
});

async function scriptedChild(responses: Parameters<Awaited<ReturnType<typeof import("@earendil-works/pi-ai")["fauxProvider"]>>["setResponses"]>[0], budget: ScoutBudget,
 options: {executionMode?: "parallel" | "sequential"; freeCheckpoint?: boolean} = {}) {
 const { fauxProvider, InMemoryCredentialStore, Type } = await import("@earendil-works/pi-ai");
 const { ModelRuntime, defineTool } = await import("@earendil-works/pi-coding-agent");
 const { createPiChildFactory } = await import("../subagents/pi.js");
 const root = mkdtempSync(join(tmpdir(), "scout-malformed-"));
 const faux = fauxProvider({provider: `scout-malformed-${Math.random()}`, tokensPerSecond: 1_000_000});
 const runtime = await ModelRuntime.create({credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false});
 runtime.registerNativeProvider(faux.provider);
 const executions = {count: 0, checkpoints: 0};
 const fixture = defineTool({name: "fixture", label: "Fixture", description: "Fixture", parameters: Type.Object({count: Type.Integer()}), executionMode: options.executionMode,
  async execute() {executions.count++; return {content: [{type: "text" as const, text: "ran"}], details: {}};}});
 const checkpoint = defineTool({name: "hand_over", label: "Checkpoint", description: "Fixture checkpoint", executionMode: options.executionMode,
  parameters: Type.Object({reason: Type.String()}), async execute() {executions.checkpoints++; return {content: [{type: "text" as const, text: "checked"}], details: {}};}});
 const tools = options.freeCheckpoint ? [fixture, checkpoint] : [fixture];
 faux.setResponses(responses);
 const factory = createPiChildFactory({cwd: root, agentDir: root, model: faux.getModel(), modelRuntime: runtime, prompts,
  sharedInstructions: [], childInstructions: prompts.render("team.data", {taskId: "fixture", budget: String(budget.limit), dataPaths: "none", resources: "- none"}),
  tools: tools.map(tool => tool.name), customTools: tools, extensionFactories: [budget.extension()], env: {}, inputs: [],
  observe: {identity: {}, telemetry: {failures: [], record() {}, async close() {}}}, turnTimeoutMs: null});
 const child = await factory({logicalAgentId: "child", parentAgentRunId: "parent", spawnToolCallId: "call"}, new AbortController().signal);
 return {child, executions, faux};
}

test("a scripted Pi child that only emits malformed calls stops and still returns bullets", async () => {
 const { fauxAssistantMessage, fauxToolCall, fauxText } = await import("@earendil-works/pi-ai");
 const budget = new ScoutBudget(3, prompts);
 let requests = 0;
 // Unknown tool and invalid arguments: both fail inside Pi before its tool_call hook.
 const malformed = () => {requests++; return fauxAssistantMessage([fauxText(`- fact: partial observation ${requests} (\`research/notes.txt:2\`)`),
  fauxToolCall("no_such_tool", {}), fauxToolCall("fixture", {count: "not a number"})], {stopReason: "toolUse"});};
 const {child, executions} = await scriptedChild(Array.from({length: 50}, () => malformed), budget);
 const journal = join(mkdtempSync(join(tmpdir(), "scout-malformed-journal-")), "journal.jsonl");
 const scope = createScouts({prompts, taskId: "fixture", task: "task", dataPaths: "dev", resources: "- none", journalPath: journal, datasetSha256: "data",
  runId: "run", invocationId: "invoke", prepare: async () => {}, run: async input => child.prompt(input.opening)});
 try {
  const output = await scope.scout({role: "data", question: "inspect"});
  // Two calls per turn: 2 admitted, then 1 admitted + 1 blocked, one finish turn, then removal.
  expect(requests).toBe(4); expect(budget.turns).toBe(4);
  expect(budget.used).toBe(3); expect(budget.attempted).toBe(8); expect(budget.stopped).toBe("budget");
  expect(executions.count).toBe(0);
  expect(output).toBe("- fact: partial observation 4 (`research/notes.txt:2`)");
  expect((await readFindings(journal)).entries.length).toBe(1);
 } finally {await child.close();}
});

for (const executionMode of ["parallel", "sequential"] as const) test(`a rejected free checkpoint cannot donate admission to a different tool reusing its ID (${executionMode})`, async () => {
 const { fauxAssistantMessage, fauxToolCall, fauxText } = await import("@earendil-works/pi-ai");
 const budget = new ScoutBudget(80, prompts, {used: 80, freeTools: ["hand_over"], maxTurns: 100});
 const {child, executions} = await scriptedChild([
  () => fauxAssistantMessage([
   fauxToolCall("hand_over", {}, {id: "same"}),
   fauxToolCall("fixture", {count: 1}, {id: "same"}),
   fauxToolCall("hand_over", {reason: "check"}, {id: "same"}),
  ], {stopReason: "toolUse"}),
  () => fauxAssistantMessage([fauxText("- fact: done")]),
 ], budget, {executionMode, freeCheckpoint: true});
 try {
  await child.prompt(prompts.render("team.probe-question", {}));
  expect(executions.count).toBe(0);
  expect(executions.checkpoints).toBe(1);
  expect(budget.used).toBe(80);
  expect(budget.attempted).toBe(3);
 } finally {await child.close();}
});

for (const executionMode of ["parallel", "sequential"] as const) test(`a scripted Pi child reusing one tool-call ID never executes past the budget (${executionMode})`, async () => {
 const { fauxAssistantMessage, fauxToolCall, fauxText } = await import("@earendil-works/pi-ai");
 const budget = new ScoutBudget(3, prompts);
 const same = (count: number) => Array.from({length: count}, () => fauxToolCall("fixture", {count: 1}, {id: "a"}));
 const {child, executions} = await scriptedChild([
  () => fauxAssistantMessage(same(2), {stopReason: "toolUse"}),
  // Within one message: one more is admitted, two are blocked.
  () => fauxAssistantMessage(same(3), {stopReason: "toolUse"}),
  // The finish-up turn reuses the admitted ID.
  () => fauxAssistantMessage(same(2), {stopReason: "toolUse"}),
  () => fauxAssistantMessage([fauxText("- fact: done"), ...same(1)], {stopReason: "toolUse"}),
 ], budget, {executionMode});
 const scope = createScouts({prompts, taskId: "fixture", task: "task", dataPaths: "dev", resources: "- none", journalPath: join(mkdtempSync(join(tmpdir(), "scout-dup-")), "j.jsonl"),
  datasetSha256: "data", runId: "run", invocationId: "invoke", prepare: async () => {}, run: async input => child.prompt(input.opening)});
 try {
  expect(await scope.scout({role: "data", question: "inspect"})).toBe("- fact: done");
  expect(executions.count).toBe(3); expect(executions.count).toBeLessThanOrEqual(budget.limit);
  expect(budget.used).toBe(3); expect(budget.attempted).toBe(8); expect(budget.blocked).toBe(5); expect(budget.stopped).toBe("budget");
 } finally {await child.close();}
});

test("a scripted Pi child without any text still yields an explicit bullet", async () => {
 const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
 const budget = new ScoutBudget(1, prompts);
 const {child} = await scriptedChild(Array.from({length: 20}, () => () => fauxAssistantMessage(fauxToolCall("no_such_tool", {}), {stopReason: "toolUse"})), budget);
 const scope = createScouts({prompts, taskId: "fixture", task: "task", dataPaths: "dev", resources: "- none", journalPath: join(mkdtempSync(join(tmpdir(), "scout-empty-")), "j.jsonl"),
  datasetSha256: "data", runId: "run", invocationId: "invoke", prepare: async () => {}, run: async input => child.prompt(input.opening)});
 try {
  expect(await scope.scout({role: "data", question: "inspect"})).toStartWith("- advice:");
  expect(budget.turns).toBe(3); expect(budget.attempted).toBe(3);
 } finally {await child.close();}
});

test("stall guard aborts a session without progress and returns even if it never settles", async () => {
 let aborted = 0;
 const result = await guardScoutSession(new Promise<string>(() => {}), {abort: () => {aborted++;}, lastActivity: () => Date.now() - 1_000,
  stallMs: 50, wallMs: 10_000, pollMs: 5, settleMs: 20});
 expect(result.stopped).toBe("stall"); expect(aborted).toBe(1);
 // Activity forever still hits the wall-time ceiling.
 const wall = await guardScoutSession(new Promise<string>(() => {}), {abort() {}, lastActivity: () => Date.now(), stallMs: 1_000, wallMs: 40, pollMs: 5, settleMs: 5});
 expect(wall.stopped).toBe("wall");
 expect(await guardScoutSession(Promise.resolve("- done"), {abort() {}, lastActivity: Date.now, stallMs: 50, wallMs: 100})).toEqual({value: "- done"});
 await expect(guardScoutSession(Promise.reject(new Error("model failed")), {abort() {}, lastActivity: Date.now, stallMs: 50, wallMs: 100})).rejects.toThrow("model failed");
});

test("a hung scripted Pi child is stopped by the guard and the lead gets a stop bullet", async () => {
 const budget = new ScoutBudget(2, prompts);
 const {child} = await scriptedChild([() => new Promise(() => {})], budget);
 const scope = createScouts({prompts, taskId: "fixture", task: "task", dataPaths: "dev", resources: "- none", journalPath: join(mkdtempSync(join(tmpdir(), "scout-hung-")), "j.jsonl"),
  datasetSha256: "data", runId: "run", invocationId: "invoke", prepare: async () => {},
  async run(input) {
   const guarded = await guardScoutSession(child.prompt(input.opening), {abort: () => child.abort(), lastActivity: () => input.budget.lastActivity,
    stallMs: 60, wallMs: 5_000, pollMs: 10, settleMs: 50});
   return guarded.stopped ? {text: "", stopped: "no progress for 0 min"} : guarded.value;
  }});
 const output = await scope.scout({role: "data", question: "inspect"});
 expect(output).toContain("The harness stopped this scout (no progress for 0 min)");
 await child.terminate();
});

test('handover revokes calls already admitted later in the same message', () => {
 const budget = new ScoutBudget(80, prompts);
 budget.assistant({role:'assistant',content:[call('handover'),call('late-trial')]});
 expect(budget.admit('handover', "read")).toBeUndefined();
 budget.end();
 expect(budget.admit('late-trial', "read")?.block).toBe(true);
 expect(budget.used).toBe(2);
});

test('lead control calls stay free at exhaustion, mixed messages and reused IDs preserve paid admissions',()=>{
 const budget=new ScoutBudget(1,prompts,{freeTools:['hand_over'],maxTurns:100});
 const emit=(names:string[])=>budget.assistant({role:'assistant',content:names.map(name=>({type:'toolCall',id:'same',name}))});
 emit(['hand_over','unknown','hand_over','malformed']);
 expect(budget.used).toBe(1);
 expect(budget.admit('same', 'hand_over')).toBeUndefined();expect(budget.admit('same', 'unknown')).toBeUndefined();expect(budget.admit('same', 'hand_over')).toBeUndefined();expect(budget.admit('same', 'malformed')?.block).toBe(true);
 for(let i=0;i<3;i++){expect(emit(['unknown','hand_over'])).toBeUndefined();expect(budget.admit('same', 'unknown')?.block).toBe(true);expect(budget.admit('same', 'hand_over')).toBeUndefined();}
 budget.end();expect(emit(['hand_over'])).toBeDefined();expect(budget.admit('same', "read")?.block).toBe(true);
});
