import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBoard, postTrialResult, type BoardActor } from "./board.js";
import { appendFindings, readFindings, resolveFinding } from "./journal.js";
import { createBoardTools } from "./board_tools.js";
import { importBoard, checkBoardHistory } from "./board_migration.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
const root = () => mkdtempSync(join(tmpdir(), "shared-board-"));
const actor = (taskId = "taskA", role: BoardActor["author"]["role"] = "lead", runId = "run1"): BoardActor => ({taskId, datasetSha256: `data-${taskId}`, author: {role, runId, invocationId: "invoke"}, producerModel: "fixture/model"});
const idea = (text = "sparse document vectors") => ({kind: "idea" as const, title: text, text, refs: []});

test("two tasks and reruns share attributed contributions; filtered cursors neither skip nor repeat", async () => {
 const board = createBoard(root());
 const expected: string[] = [];
 for (let i=0; i<25; i++) {
  const a = actor(i%2 ? "taskB" : "taskA", "data", `run${i%3}`);
  const entry = await board.write(a, idea(`sparse ${i}`), `request-${i}`);
  if (a.taskId === "taskA") expected.push(entry.id);
 }
 const found: string[] = []; let since = 0;
 for (;;) {
  const page = await board.read("taskB", {taskId: "taskA", limit: 3, since, text: "sparse"});
  found.push(...page.entries.map(row => row.id));
  if (page.cursor === since) break; since = page.cursor;
 }
 expect(found).toEqual(expected);
 const recalled = await board.recall("taskC", "sparse document vectors");
 expect(recalled.entries.length).toBe(4); expect(recalled.omitted).toBe(21);
 expect(recalled.entries[0].taskId).toBeDefined(); expect(recalled.entries[0].producerModel).toBe("fixture/model");
 expect((await board.read("taskC")).entries).toHaveLength(0);
 expect((await board.read("taskC", {includeOtherTasks: true, ids: [expected[0]]})).entries).toHaveLength(1);
 const again = createBoard(board.path.replace(/\/findings\/journal.jsonl$/, ""));
 expect((await again.recall("taskA", "sparse")).entries.filter(row => row.taskId === "taskA")).toHaveLength(8);
});

test("writes serialize and retry once, reject changed content and forged identities; resolutions keep history", async () => {
 const base = root(), board = createBoard(base), a = actor();
 const entries = await Promise.all(Array.from({length: 12}, () => board.write(a, idea(), "same")));
 expect(new Set(entries.map(row => row.id)).size).toBe(1);
 expect((await readFindings(board.path)).entries).toHaveLength(1);
 await expect(board.write(a, idea("different"), "same")).rejects.toThrow("different content");
 await expect(board.write(a, {...idea(), author: actor("forged").author} as any, "forged")).rejects.toThrow("Unexpected");
 await expect(board.write(a, {...idea(), kind: "result"} as any, "fake-result")).rejects.toThrow("harness");
 await expect(board.write(actor("taskB", "data"), {...idea(), kind: "defect"}, "fake-defect")).rejects.toThrow("validation");
 await expect(board.resolve(actor("taskB", "lead", "other-run"), entries[0].id)).rejects.toThrow("original author");
 await board.resolve(a, entries[0].id); await board.resolve(a, entries[0].id);
 const view = await readFindings(board.path); expect(view.resolutions).toHaveLength(1); expect(view.entries).toHaveLength(1);
 expect((await board.recall("taskA", "sparse")).entries).toHaveLength(0);
 appendFileSync(board.path, '{"torn":');
 expect((await board.read("taskA")).incompleteTail).toBe(true);
 await board.write(a, idea("recovery"), "recover"); expect((await readFindings(board.path)).incompleteTail).toBe(false);
 const aborted = new AbortController(); aborted.abort();
 await expect(board.write(a, idea(), "cancelled", aborted.signal)).rejects.toThrow();
 writeFileSync(board.path, '{}\n'); await expect(board.read("taskA")).rejects.toThrow();
});

test("cross-task evidence resolves from the origin; stale checks and missing trials remain visible", async () => {
 const base = root(), board = createBoard(base);
 mkdirSync(join(base, "taskA"), {recursive: true}); writeFileSync(join(base, "taskA", "source.txt"), "source");
 const entry = await board.write(actor(), {...idea(), refs: [{file: "source.txt", line: 1}, {experiment: "missing"}, {check: "checks/missing.py", sha256: "old"}]}, "origin");
 const page = await board.read("taskB", {includeOtherTasks: true, ids: [entry.id]});
 expect(page.entries[0].evidence.staleRefs.length).toBe(1);
 expect(page.entries[0].evidence.unresolvedRefs).toContain("experiment:missing");
});

test("tool identity comes from harness and all roles can read/write ideas with existing budgets", async () => {
 const base = root(), prompts = loadPromptSnapshot(), board = createBoard(base);
 const lead = createBoardTools(board, actor(), prompts), scout = createBoardTools(board, actor("taskB", "ideas"), prompts);
 expect(lead.map(tool => tool.name)).toEqual(["findings_read", "finding_write", "finding_resolve"]);
 const call = async (tool: any, args: object) => JSON.parse((await tool.execute("tool-call", args, new AbortController().signal)).content[0].text);
 const entry = await call(lead[1], {...idea(), requestId: "post"});
 expect((await call(scout[0], {includeOtherTasks: true, ids: [entry.id]})).entries[0].author.role).toBe("lead");
 await call(scout[1], {...idea("reply"), refs: [{entry: entry.id}], requestId: "reply"});
 await expect(call(scout[1], {...idea(), requestId: "forged", taskId: "taskA"})).rejects.toThrow();
 await expect(call(scout[2], {id: entry.id})).rejects.toThrow("original author");
});

test("harness completion replay records visible measures once and excludes sealed fields", async () => {
 const base = root(), a = actor();
 const trial = {experimentId: "trial", source: "taskA/solve/training/run/trial", status: "failed", metric: "balanced_accuracy", foldScores: [0.6,0.8], elapsedSeconds: 12,
  holdout: {sealedScore: 0.123456, labels: [1,0]}, rawError: "PRIVATE_MARKER"};
 await postTrialResult(base, a, trial); await postTrialResult(base, a, trial);
 const view = await readFindings(createBoard(base).path);
 expect(view.entries).toHaveLength(1); expect(view.entries[0].measurement?.status).toBe("failed");
 expect(view.entries[0].measurement?.mean).toBeCloseTo(0.7);
 expect(JSON.stringify(view)).not.toContain("PRIVATE_MARKER"); expect(JSON.stringify(view)).not.toContain("sealedScore");
 const result = await createBoard(base).read("taskB", {includeOtherTasks: true});
 expect(result.entries[0].datasetSha256).toBe("data-taskA");
});

test("legacy dry run/import preserve originals, remap links and resolutions, and deduplicate replay", async () => {
 const base = root(), legacy = join(base, "taskA/findings/journal.jsonl");
 const input = {...idea(), author: actor().author, datasetSha256: "data-taskA"};
 const [first] = await appendFindings(legacy, [input]);
 const [second] = await appendFindings(legacy, [{...input, refs: [{entry: first.id}]}]);
 await resolveFinding(legacy, {id: first.id, status: "superseded", supersededBy: second.id}, "lead");
 const bytes = readFileSync(legacy);
 await expect(checkBoardHistory(base)).rejects.toThrow();
 const dry = await importBoard(base); expect(dry.imported).toBe(3); expect(existsSync(createBoard(base).path)).toBe(false);
 await expect(importBoard(base, true, async () => {throw new Error("active writer");})).rejects.toThrow("active writer");
 const imported = await importBoard(base, true, async () => {}); expect(imported.imported).toBe(3);
 const repeated = await importBoard(base, true, async () => {}); expect(repeated.imported).toBe(0); expect(repeated.skipped).toBe(3);
 expect(readFileSync(legacy)).toEqual(bytes); await checkBoardHistory(base);
 const view = await readFindings(createBoard(base).path);
 expect(view.entries[1].refs).toEqual([{entry: view.entries[0].id}]);
 expect(view.resolutions[0].supersededBy).toBe(view.entries[1].id);
 expect(view.entries[0].producerModel).toBeUndefined();
 await appendFindings(legacy, [input]); await expect(checkBoardHistory(base)).rejects.toThrow();
});

test("end to end: task A post, B recall/read and correction, later run, truthful result and stale evidence", async () => {
 const base = root(), events: string[] = [], board = createBoard(base, event => events.push(event));
 const posted = await board.write(actor("taskA", "data"), {...idea(), refs: [{file: "missing.txt", line: 1}]}, "post");
 const recall = await board.recall("taskB", "sparse document vectors"); expect(recall.entries[0].id).toBe(posted.id);
 expect(recall.entries[0].evidence.staleRefs.length).toBe(1);
 const page = await board.read("taskB", {includeOtherTasks: true, ids: [posted.id]}); expect(page.entries[0].text).toBe(posted.text);
 await board.write(actor("taskB", "ideas"), {...idea("sparse vectors need scaling"), refs: [{entry: posted.id}]}, "reply");
 await postTrialResult(base, actor("taskA"), {experimentId: "exp", source: "taskA/training/exp", status: "completed", foldScores: [.7,.8], elapsedSeconds: 4});
 const later = await createBoard(base).recall("taskB", "sparse vectors"); expect(later.entries.some(row => row.taskId === "taskA")).toBe(true);
 expect(events).toContain("board_recall"); expect(events).toContain("board_read"); expect(events).toContain("board_write");
});

test("scout startup sees another task and previous runs; explicit final citations are captured once", async () => {
 const {createScouts} = await import("./scouts.js");
 const base = root(), board = createBoard(base), prompts = loadPromptSnapshot();
 await board.write(actor("taskA", "lead", "previous-run"), idea(), "earlier");
 let openings: string[] = [];
 const scouts = createScouts({prompts, taskId: "taskB", task: "sparse document vectors", dataPaths: "dev", resources: "none",
  boardRoot: base, journalPath: board.path, datasetSha256: "data-taskB", runId: "scout-run", invocationId: "parent", prepare: async () => {},
  async run(input) {
   openings.push(input.opening.text); expect(input.board?.actor.author.role).toBe("ideas");
   const entry = await board.write(input.board!.actor, idea("explicit scout contribution"), "explicit");
   return `- shared contribution [${entry.id}]`;
  }});
 await scouts.scout({role: "ideas", question: "sparse vectors"}, undefined, "call1");
 await scouts.scout({role: "ideas", question: "continue"}, undefined, "call2");
 expect(openings[0]).toContain("taskA"); expect(openings[0]).toContain("previous-run");
 expect(openings[1]).toContain("explicit scout contribution"); expect(openings[0].length).toBeLessThan(16000);
 expect((await readFindings(board.path)).entries).toHaveLength(3);
});

test("preflight rejects a corrupt board before sessions and checks selected prompts", async () => {
 const {setupChecks, SetupSession} = await import("../pipeline/setup.js");
 const base = root(), board = createBoard(base); mkdirSync(join(base, "findings")); writeFileSync(board.path, '{}\n');
 const prompts = loadPromptSnapshot(); let started = false;
 const checks = setupChecks(["findings-board"], {taskId: "fixture", prompts, scoutPaths: {journal: board.path, unitIntro: "unused", task: "unused", profile: "unused"}});
 await expect((async () => {await new SetupSession().check(checks, new AbortController().signal, () => {}); started = true;})()).rejects.toThrow("findings-board");
 expect(started).toBe(false);
 writeFileSync(board.path, ""); await new SetupSession().check(checks, new AbortController().signal, () => {});
});

test("board and importer stay in finetuned; symlinked paths cannot expose minimal findings", async () => {
 const base = root(), finetuned = join(base, "runs/finetuned"), minimal = join(base, "runs/minimal");
 await createBoard(minimal).write(actor("private"), idea("MINIMAL_PRIVATE_MARKER"), "private");
 const board = createBoard(finetuned); await board.write(actor(), idea(), "finetuned");
 expect(JSON.stringify(await board.read("taskA", {includeOtherTasks: true}))).not.toContain("MINIMAL_PRIVATE_MARKER");
 expect((await importBoard(finetuned)).sources).toHaveLength(0);
 mkdirSync(join(finetuned, "legacy")); symlinkSync(join(minimal, "findings"), join(finetuned, "legacy/findings"));
 await expect(importBoard(finetuned)).rejects.toThrow("regular file");
 const redirect = root(); symlinkSync(join(minimal, "findings"), join(redirect, "findings"));
 await expect(createBoard(redirect).read("private", {includeOtherTasks: true})).rejects.toThrow("symbolic links");
});

test("real Pi board calls consume scout budget and fixture AGENTS instructions stay excluded", async () => {
 const {fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore} = await import("@earendil-works/pi-ai");
 const {ModelRuntime, createAgentSession, SessionManager, SettingsManager} = await import("@earendil-works/pi-coding-agent");
 const {createPipelineResourceLoader} = await import("../run/session_resources.js");
 const {ScoutBudget} = await import("./budget.js");
 const base = root(), prompts = loadPromptSnapshot(), events: string[] = [];
 writeFileSync(join(base, "AGENTS.md"), "NEVER_LOAD_BOARD_DEVELOPMENT_MARKER");
 const board = createBoard(base, event => events.push(event));
 const tools = createBoardTools(board, actor("taskA", "data"), prompts);
 const budget = new ScoutBudget(1, prompts);
 const faux = fauxProvider({provider: "board-budget-fixture", tokensPerSecond: 1_000_000});
 const runtime = await ModelRuntime.create({credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false});
 runtime.registerNativeProvider(faux.provider);
 faux.setResponses([
  () => fauxAssistantMessage(fauxToolCall("finding_write", {...idea(), requestId: "first"}), {stopReason: "toolUse"}),
  () => fauxAssistantMessage(fauxToolCall("findings_read", {}), {stopReason: "toolUse"}),
  () => fauxAssistantMessage("- finished"),
 ]);
 const instructions = prompts.render("team.board-context", {recall: "SELECTED_BOARD_INPUT"});
 const settingsManager = SettingsManager.inMemory();
 const resourceLoader = createPipelineResourceLoader({cwd: base, agentDir: base, settingsManager, systemPrompt: instructions.text, extensionFactories: [budget.extension()]});
 await resourceLoader.reload();
 const {session} = await createAgentSession({cwd: base, agentDir: base, model: faux.getModel(), modelRuntime: runtime, settingsManager,
  resourceLoader, sessionManager: SessionManager.inMemory(base), tools: tools.map(tool => tool.name), customTools: tools});
 try {
  expect(session.systemPrompt).not.toContain("NEVER_LOAD_BOARD_DEVELOPMENT_MARKER"); expect(session.systemPrompt).toContain("SELECTED_BOARD_INPUT");
  await session.prompt("Inspect and contribute");
  expect(budget.used).toBe(1); expect(budget.blocked).toBe(1);
  expect(events.filter(event => event === "board_write")).toHaveLength(1);
  expect(events.filter(event => event === "board_read")).toHaveLength(0);
 } finally {session.dispose();}
});

test("filtered pagination retains superseding events and recall has a total serialized bound", async () => {
 const board = createBoard(root()), a = actor();
 const first = await board.write(a, idea("sparse original"), "one");
 const second = await board.write(actor("taskB"), idea("unrelated"), "two");
 await board.resolve(a, first.id);
 let page = await board.read("taskA", {limit: 1, kinds: ["idea"]});
 expect(page.entries[0].id).toBe(first.id);
 page = await board.read("taskA", {limit: 1, kinds: ["idea"], since: page.cursor});
 expect(page.entries).toHaveLength(0); expect(page.resolutions[0].id).toBe(first.id);
 expect((await board.read("taskA", {includeOtherTasks: true, ids: [second.id]})).entries).toHaveLength(1);
 for (let index=0; index<16; index++) {
  const owner = {...actor(index<8 ? "taskA" : "taskC"), producerModel: "model".repeat(100)};
  await board.write(owner, {...idea("sparse"), text: "sparse ".repeat(100), refs: Array.from({length: 20}, (_, i) => ({url: `unresolved-${i}-${"x".repeat(1000)}`}))}, `bounded-${index}`);
 }
 const recalled = await board.recall("taskA", "sparse");
 expect(JSON.stringify(recalled).length).toBeLessThanOrEqual(12000);
 expect(recalled.entries.every(row => row.evidence.staleRefs.length <= 2)).toBe(true);
 expect(recalled.entries.some(row => row.evidence.omitted > 0)).toBe(true);
});

test("an import receipt records rejected corrupt sources while retaining healthy history and originals", async () => {
 const base = root(), healthy = join(base, "taskA/findings/journal.jsonl"), corrupt = join(base, "taskB/findings/journal.jsonl");
 await appendFindings(healthy, [{...idea(), author: actor().author, datasetSha256: "original-data"}]);
 mkdirSync(join(base, "taskB/findings"), {recursive: true}); writeFileSync(corrupt, '{}\n');
 const original = readFileSync(healthy);
 const result = await importBoard(base, true, async () => {});
 expect(result.imported).toBe(1); expect(result.rejected).toEqual([{taskId: "taskB", reason: "malformed complete journal; original retained"}]);
 const receipt = JSON.parse(readFileSync(join(base, "findings/import-receipt.json"), "utf8"));
 expect(receipt.rejected).toEqual(result.rejected);
 expect(readFileSync(healthy)).toEqual(original); expect(readFileSync(corrupt, "utf8")).toBe('{}\n');
 await expect(checkBoardHistory(base)).rejects.toThrow();
});

test("migration imports the complete prefix of a torn source, preserves the tail and reports missing originals", async () => {
 const {renameSync} = await import("node:fs");
 const base = root(), source = join(base, "taskA/findings/journal.jsonl");
 await appendFindings(source, [{...idea(), author: actor().author, datasetSha256: "data"}]);
 appendFileSync(source, '{"unfinished":'); const bytes = readFileSync(source);
 const result = await importBoard(base, true, async () => {});
 expect(result.imported).toBe(1); expect(result.rejected).toHaveLength(0); expect(result.warnings).toHaveLength(1);
 expect(readFileSync(source)).toEqual(bytes); await checkBoardHistory(base);
 expect((await importBoard(base, true, async () => {})).imported).toBe(0);
 renameSync(source, `${source}.preserved`);
 await expect(checkBoardHistory(base)).rejects.toThrow("Missing legacy");
 const missing = await importBoard(base, true, async () => {});
 expect(missing.rejected[0].taskId).toBe("taskA");
 expect(readFileSync(`${source}.preserved`)).toEqual(bytes);
 expect((await readFindings(createBoard(base).path)).entries).toHaveLength(1);
});

test("the shared prompt example searches another task and posts a cited idea with valid, retryable arguments", async () => {
 const prompts = loadPromptSnapshot(), board = createBoard(root());
 const earlier = await board.write(actor("taskA", "data"), {kind: "fact", title: "Input decoding", text: "Several inputs failed strict decoding.", refs: []}, "earlier-decoding");
 const introduction = prompts.render("team.board-context", {recall: "none"}).text;
 const examples = [...introduction.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
 expect(examples).toHaveLength(2);
 const tools = createBoardTools(board, actor("taskB", "ideas"), prompts);
 const invoke = async (name: string, args: any) => {
  const reply = await tools.find(tool => tool.name === name)!.execute("example-call", args, undefined, undefined, undefined as never);
  return JSON.parse((reply.content[0] as {text: string}).text);
 };
 const page = await invoke("findings_read", examples[0]);
 expect(page.entries[0].id).toBe(earlier.id);
 examples[1].refs[0].entry = page.entries[0].id;
 examples[1].requestId = "decoding-reuse-example";
 const written = await invoke("finding_write", examples[1]);
 expect(written.kind).toBe("idea"); expect(written.taskId).toBe("taskB");
 expect(written.refs).toEqual([{entry: earlier.id}]);
 expect((await invoke("finding_write", examples[1])).id).toBe(written.id);
 expect((await readFindings(board.path)).entries).toHaveLength(2);
});
