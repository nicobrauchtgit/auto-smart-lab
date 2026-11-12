import { trialSupervisionDirectory } from "../training/results.js";
/** Stream C on stream B's services: contracts, trial snapshots, validation checks, references and scout inputs. */
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { readPythonEnvironment } from "../run/python_environment.js";
import { expertSandbox, scoutWorkspace } from "../run/sandbox.js";
import { ensureSolutionsRepository, git, resolveCommit } from "../training/git.js";
import { ScoutBudget } from "./budget.js";
import { createFindings } from "./findings.js";
import { readFindings } from "./journal.js";
import { createScoutRunner, scoutToolset, validationCheckTool } from "./runner.js";
import { createScouts, type ScoutSessionInput } from "./scouts.js";
import { createTrialResolver, describeRefs } from "./trials.js";
import { stageScoutInputs } from "./workspace.js";
import type { TaskData, TrialSnapshot } from "./contracts.js";
const prompts = loadPromptSnapshot();
const AGENT = dirname(import.meta.dir);

function commit(repository: string, message: string) {
 git(repository, ["add", "-A"]); git(repository, ["commit", "-qm", message]);
 return resolveCommit(repository, "HEAD")!;
}
/**
 * A state root with a shared solutions tree, one measured trial whose source
 * has a defect, a later live fix, and prepared task data for task "fixture".
 */
function stateFixture(base = tmpdir()) {
 const state = realpathSync(mkdtempSync(join(base, "scout-state-")));
 const live = join(state, "solutions");
 ensureSolutionsRepository(live);
 mkdirSync(join(live, "tasks"), {recursive: true}); mkdirSync(join(live, "checks/fixture"), {recursive: true});
 writeFileSync(join(live, "tasks/model.py"), "LEAK = True\nOTHER = 1\n");
 const measured = commit(live, "measured");
 const trials = join(state, "fixture/solve/training/run-1");
 const record = (id: string, source = measured) => {
  mkdirSync(join(trials, id), {recursive: true});
  mkdirSync(trialSupervisionDirectory(join(trials, id)), {recursive: true});
  writeFileSync(join(trialSupervisionDirectory(join(trials, id)), "recovery.json"), JSON.stringify({trial: {id, source: {commit: source.commit, tree: source.tree}, worktrees: [join(trials, id, "solutions")]}, solutionsRoot: live}));
 };
 record("exp-1");
 writeFileSync(join(live, "tasks/model.py"), "LEAK = False\nOTHER = 1\n");
 const fixed = commit(live, "live fix");
 record("exp-2", fixed);
 const solve = join(state, "fixture/solve"), dataRoot = join(state, "fixture/data");
 mkdirSync(join(solve, "agent"), {recursive: true}); mkdirSync(dataRoot, {recursive: true});
 for (const [path, text] of [[join(solve, "task.md"), "UNIT INTRO\n\nTASK TEXT\n"], [join(dataRoot, "profile.json"), '{"rowCount": 2}\n'],
  [join(dataRoot, "development.zip"), "zip"], [join(dataRoot, "development-samples.json"), "{}"], [join(state, "test.zip"), "zip"]]) writeFileSync(path, text);
 const data = {taskId: "fixture", root: solve, solutionsRoot: live, taskPath: join(solve, "task.md"), profilePath: join(dataRoot, "profile.json"),
  devZip: join(dataRoot, "development.zip"), developmentArchive: join(dataRoot, "development.zip"), sampleManifestPath: join(dataRoot, "development-samples.json"),
  developmentManifest: join(dataRoot, "development-samples.json"), testZip: join(state, "test.zip"), testArchive: join(state, "test.zip"), datasetSha256: "dataset"} as unknown as TaskData;
 const resolver = createTrialResolver({roots: () => [trials], solutionsRoot: live});
 return {state, live, trials, measured, fixed, data, resolver};
}

test("shared contract types have one definition, in team/contracts.ts, and B's entry points re-export it", async () => {
 const names = ["TaskData", "TreeState", "WorkspaceCheck", "TrialSnapshot", "TrainingLabelRow", "TeamRole", "ScoutRole",
  "FindingKind", "FindingRef", "FindingEntry", "FindingResolution", "FindingsStatus", "FindingsReader"];
 const definition = new RegExp(`(?:interface|type)\\s+(${names.join("|")})\\b\\s*(?:=|\\{|extends|<)`);
 const offenders: string[] = [];
 const walk = (directory: string) => { for (const name of readdirSync(directory)) {
  const path = join(directory, name);
  if (statSync(path).isDirectory()) { if (!["node_modules", "fixtures"].includes(name)) walk(path); continue; }
  if (!path.endsWith(".ts") || path.endsWith(".test.ts") || path === join(AGENT, "team/contracts.ts")) continue;
  for (const line of readFileSync(path, "utf8").split("\n")) if (definition.test(line) && !line.trimStart().startsWith("//")) offenders.push(`${relative(AGENT, path)}: ${line.trim()}`);
 }};
 walk(AGENT);
 expect(offenders).toEqual([]);
 for (const file of ["workspace/task_data.ts", "workspace/tree.ts", "workspace/check.ts", "workspace/trial_source.ts", "workspace/findings_reader.ts"])
  expect(readFileSync(join(AGENT, file), "utf8")).toContain('from "../team/contracts.js"');
 const reader = await import("../workspace/findings_reader.js");
 expect(reader.createFindingsReader).toBe((await import("./findings.js")).createFindingsReader);
});

test("validation sees only the measured snapshot: live code hidden, snapshot read-only, checks/<task> the only writable folder", async () => {
 const f = stateFixture();
 const trial = await f.resolver.snapshot("exp-1");
 expect(trial).toMatchObject({experimentId: "exp-1", commit: f.measured.commit, tree: f.measured.tree});
 const sandbox = expertSandbox(f.data, "validation", readPythonEnvironment(false), trial);
 expect(sandbox.env.VALIDATION_SOURCE_ROOT).toBe(trial.sourceRoot); expect(sandbox.env.VALIDATION_EXPERIMENT_ID).toBe("exp-1");
 const view = scoutToolset("validation", {sandbox, solutionsRoot: f.live, taskId: "fixture", trial});
 expect(view.sandbox.cwd).toBe(join(trial.sourceRoot, "solutions"));
 expect(view.sandbox.mounts.filter(mount => mount.writable).map(mount => mount.source)).toEqual([join(f.live, "checks/fixture")]);
 const script = [
  `test ! -e ${f.live}/tasks/model.py`, "grep -q 'LEAK = True' tasks/model.py", "! echo x > tasks/model.py",
  `! echo x > ${f.live}/checks/elsewhere.py`, `echo ok > ${f.live}/checks/fixture/written.py`].join(" && ");
 const result = spawnSync(view.sandbox.executable, view.sandbox.args(["bash", "-c", script]), {encoding: "utf8", timeout: 20_000});
 expect({status: result.status, stderr: result.stderr}).toEqual({status: 0, stderr: expect.any(String)});
 expect(readFileSync(join(f.live, "checks/fixture/written.py"), "utf8")).toBe("ok\n");
 expect(readFileSync(join(trial.sourceRoot, "solutions/tasks/model.py"), "utf8")).toContain("LEAK = True");
}, 30_000);

test("symlinked task state mounts the canonical snapshot cwd without exposing live state or labels", async () => {
 const f = stateFixture("/dev/shm");
 const backing = mkdtempSync("/dev/shm/scout-symlink-");
 renameSync(f.state, join(backing, "state")); symlinkSync(join(backing, "state"), f.state);
 const sealed = join(f.state, "fixture/sealed-labels.json"); writeFileSync(sealed, "SECRET");
 const trial = await f.resolver.snapshot("exp-1");
 expect(trial).toMatchObject({experimentId: "exp-1", commit: f.measured.commit, tree: f.measured.tree});
 const sandbox = expertSandbox(f.data, "validation", readPythonEnvironment(false), trial);
 expect(sandbox.env.VALIDATION_SOURCE_ROOT).toBe(realpathSync(trial.sourceRoot)); expect(sandbox.env.VALIDATION_EXPERIMENT_ID).toBe("exp-1");
 const view = scoutToolset("validation", {sandbox, solutionsRoot: f.live, taskId: "fixture", trial});
 expect(view.sandbox.cwd).toBe(join(realpathSync(trial.sourceRoot), "solutions"));
 expect(view.sandbox.mounts.filter(mount => mount.writable).map(mount => mount.source)).toEqual([join(realpathSync(f.live), "checks/fixture")]);
 const script = [
  `test ! -e ${realpathSync(f.live)}/tasks/model.py`, `test ! -e ${realpathSync(sealed)}`, "grep -q 'LEAK = True' tasks/model.py", "! echo x > tasks/model.py",
  `! echo x > ${realpathSync(f.live)}/checks/elsewhere.py`, `echo ok > ${realpathSync(f.live)}/checks/fixture/written.py`].join(" && ");
 const result = spawnSync(view.sandbox.executable, view.sandbox.args(["bash", "-c", script]), {encoding: "utf8", timeout: 20_000});
 expect({status: result.status, stderr: result.stderr}).toEqual({status: 0, stderr: expect.any(String)});
 expect(readFileSync(join(f.live, "checks/fixture/written.py"), "utf8")).toBe("ok\n");
 expect(readFileSync(join(trial.sourceRoot, "solutions/tasks/model.py"), "utf8")).toContain("LEAK = True");
}, 30_000);

test("run_checks runs B's check runner on the snapshot: a live fix cannot make the measured defect pass", async () => {
 const f = stateFixture();
 const trial = await f.resolver.snapshot("exp-1");
 const view = scoutToolset("validation", {sandbox: expertSandbox(f.data, "validation", readPythonEnvironment(false), trial), solutionsRoot: f.live, taskId: "fixture", trial});
 const check = join(f.live, "checks/fixture/test_leak.py");
 writeFileSync(check, "from solutions.tasks.model import LEAK\nassert not LEAK, 'measured pipeline leaks'\n");
 const events: Record<string, unknown>[] = [];
 const checks = validationCheckTool({trial, sandbox: view.checkSandbox!, solutionsRoot: f.live, taskId: "fixture", prompts, record: (_event, payload) => events.push(payload)});
 const run = async (paths: string[]) => JSON.parse(((await checks.tool.execute("id", {paths}, undefined, undefined, undefined as never)).content[0] as {text: string}).text);
 const result = await run(["test_leak.py"]);
 expect(result.passed).toBe(false); expect(result.checks[0].exitCode).not.toBe(0);
 expect(result.checks[0].output).toContain("measured pipeline leaks");
 expect(checks.ran).toEqual([{path: "checks/fixture/test_leak.py", sha256: createHash("sha256").update(readFileSync(check)).digest("hex")}]);
 expect(events[0]).toMatchObject({experiment_id: "exp-1", passed: false});
 // The same check passes on the fixed trial: it measures the snapshot, not the live tree.
 const fixed = await f.resolver.snapshot("exp-2");
 const fixedChecks = validationCheckTool({trial: fixed, solutionsRoot: f.live, taskId: "fixture", prompts,
  sandbox: scoutToolset("validation", {sandbox: expertSandbox(f.data, "validation", readPythonEnvironment(false), fixed), solutionsRoot: f.live, taskId: "fixture", trial: fixed}).checkSandbox!});
 expect(JSON.parse(((await fixedChecks.tool.execute("id", {paths: ["test_leak.py"]}, undefined, undefined, undefined as never)).content[0] as {text: string}).text).passed).toBe(true);
 expect((await run(["../../tasks/model.py"])).error).toContain("not a .py file in");
}, 60_000);

test("each validation call resolves its own experiment; fix bullets journal as defects with the trial and snapshot lines", async () => {
 const f = stateFixture();
 const journal = join(f.state, "fixture/findings/journal.jsonl");
 const seen: (TrialSnapshot | undefined)[] = [];
 const scope = createScouts({prompts, taskId: "fixture", task: "UNIT INTRO\n\nTASK TEXT", dataPaths: "dev", resources: "- none", journalPath: journal, datasetSha256: "dataset",
  runId: "run", invocationId: "invoke", trials: f.resolver, solutionsRoot: f.live, citationBase: f.state, prepare: async () => {},
  async run(input) {
   seen.push(input.trial);
   expect(input.system.text).toContain(`experiment \`${input.trial!.experimentId}\``);
   expect(input.opening.text).toContain(`{"experiment":"${input.trial!.experimentId}"}: resolved`);
   return {text: [
    "- fix: the pipeline reads a leak flag (`tasks/model.py:1`), confirmed by `checks/fixture/test_leak.py`",
    "- `ok:` output domain checked (`tasks/model.py:1-2`)", "- advice: pin the seed", "- an unlabelled remark"].join("\n"),
    root: join(input.trial!.sourceRoot, "solutions"), checks: [{path: "checks/fixture/test_leak.py", sha256: "a".repeat(64)}]};
  }});
 const first = await scope.scout({role: "validation", question: "check", refs: [{experiment: "exp-1"}]});
 await scope.scout({role: "validation", question: "check", refs: [{experiment: "exp-2"}]});
 expect(seen.map(trial => trial?.commit)).toEqual([f.measured.commit, f.fixed.commit]);
 expect(first).toContain("validation bullets start with ok, fix or advice");
 const entries = (await readFindings(journal)).entries.filter(entry => entry.author.invocationId === "invoke").slice(0, 3);
 expect(entries.map(entry => entry.kind)).toEqual(["defect", "fact", "idea"]);
 expect(entries[0].refs).toEqual([{experiment: "exp-1"}, {file: "tasks/model.py", line: 1, commit: f.measured.commit},
  {check: "checks/fixture/test_leak.py", experiment: "exp-1", sha256: "a".repeat(64)}]);
 // A quoted prefix still labels the bullet; a line range links its first line.
 expect(entries[1].refs).toEqual([{experiment: "exp-1"}, {file: "tasks/model.py", line: 1, commit: f.measured.commit}]);
 // Unknown experiments fail the role; the scout never starts on live code.
 expect(await scope.scout({role: "validation", question: "check", refs: [{experiment: "exp-9"}]})).toContain("snapshot unavailable: No trial record for experiment exp-9");
 expect(seen.length).toBe(2);
}, 30_000);

test("a validation reply of labelled paragraphs completes and journals its findings", async () => {
 const f = stateFixture();
 const journal = join(f.state, "fixture/findings/journal.jsonl");
 const scope = createScouts({prompts, taskId: "fixture", task: "UNIT INTRO\n\nTASK TEXT", dataPaths: "dev", resources: "- none", journalPath: journal, datasetSha256: "dataset",
  runId: "run", invocationId: "paragraphs", trials: f.resolver, solutionsRoot: f.live, citationBase: f.state, prepare: async () => {},
  run: async input => ({text: "\n\n`ok:` output domain checked (`tasks/model.py:1`).\n\n**advice:** pin the seed.", root: join(input.trial!.sourceRoot, "solutions")})});
 const report = await scope.report({role: "validation", question: "check", refs: [{experiment: "exp-1"}]});
 expect(report.roles).toEqual([{role: "validation", status: "completed", bullets: 2}]);
 expect(report.text).toBe("- `ok:` output domain checked (`tasks/model.py:1`).\n- **advice:** pin the seed.");
 const entries = (await readFindings(journal)).entries.filter(entry => entry.author.invocationId === "paragraphs");
 expect(entries.map(entry => entry.kind)).toEqual(["fact", "idea"]);
 expect(entries[0].refs).toEqual([{experiment: "exp-1"}, {file: "tasks/model.py", line: 1, commit: f.measured.commit}]);
}, 30_000);

test("the runner builds a fresh sandbox for every call from that call's trial", async () => {
 const f = stateFixture();
 const calls: [string, string | undefined][] = [];
 const runner = createScoutRunner({prompts, taskId: "fixture", taskConfiguration: {samples: {source: "zip_members"}} as never, telemetry: {} as never, record() {},
  observe: {identity: {}, telemetry: {failures: [], record() {}, async close() {}}}, solutionsRoot: f.live,
  scoutPaths: {journal: "fixture", unitIntro: "fixture", task: "fixture", profile: "fixture"},
  setup: {check: async () => {}} as never,
  sandbox(role, trial) { calls.push([role, trial?.experimentId]); throw new Error("stop before any model call"); }});
 const input = (trial: TrialSnapshot): ScoutSessionInput => ({role: "validation", toolCallId: "call", trial, budget: new ScoutBudget(1, prompts),
  shared: prompts.render("team.shared", {}), system: prompts.render("team.finish", {}), opening: prompts.render("team.finish", {})});
 for (const id of ["exp-1", "exp-2", "exp-1"]) await expect(runner(input(await f.resolver.snapshot(id)))).rejects.toThrow("stop before any model call");
 expect(calls).toEqual([["validation", "exp-1"], ["validation", "exp-2"], ["validation", "exp-1"]]);
}, 30_000);

test("experiment and commit-bound refs resolve through B's snapshot resolver: resolved, stale or unresolved", async () => {
 const f = stateFixture();
 const api = createFindings(f.state);
 const entry = (refs: object[]) => api.add("fixture", {kind: "decision", author: {role: "lead", runId: "r", invocationId: "i"}, title: "t", text: "t", refs: refs as never, datasetSha256: "d"});
 await entry([{experiment: "exp-1"}, {experiment: "exp-404"}, {file: "tasks/model.py", line: 2, commit: f.measured.commit},
  {file: "solutions/tasks/model.py", line: 9, commit: f.measured.commit}, {file: "tasks/missing.py", line: 1, commit: f.measured.commit}]);
 let status = await api.status("fixture");
 expect(status.staleRefs.sort()).toEqual([`file:solutions/tasks/model.py@${f.measured.commit}`, `file:tasks/missing.py@${f.measured.commit}`]);
 expect(status.unresolvedRefs).toEqual(["experiment:exp-404"]);
 // B's resolver restored the snapshot; a tampered snapshot no longer matches its record and is stale.
 const snapshot = join(f.trials, "exp-1/solutions");
 expect(existsSync(snapshot)).toBe(true);
 writeFileSync(join(snapshot, "tasks/model.py"), "tampered\n");
 status = await createFindings(f.state).status("fixture");
 expect(status.staleRefs).toContain("experiment:exp-1");
 expect(await describeRefs([{experiment: "exp-2"}, {url: "https://example.org"}], f.resolver)).toBe(
  `- {"experiment":"exp-2"}: resolved (commit ${f.fixed.commit.slice(0, 12)})\n- {"url":"https://example.org"}`);
}, 30_000);

test("data and ideas scouts get B's task.md with the unit introduction, the profile, resources and research/, and the prompt names only those", async () => {
 const f = stateFixture();
 const slides = join(f.state, "slides.txt"); writeFileSync(slides, "course slides\n");
 const resources = [{source: slides, resource: {title: "Slides", path: "resources/slides.txt", media_type: "text/plain" as const, pages: 1, bytes: 14,
  sha256: createHash("sha256").update("course slides\n").digest("hex")}}];
 const inputs = stageScoutInputs(f.data, resources);
 expect(inputs.root).toBe(scoutWorkspace(f.data));
 expect(readFileSync(join(inputs.root, "task.md"), "utf8")).toBe("UNIT INTRO\n\nTASK TEXT\n");
 expect(existsSync(join(inputs.root, "profile.json"))).toBe(true);
 expect(inputs.dataPaths.split("\n").length).toBe(3);
 const sandbox = expertSandbox(f.data, "data", readPythonEnvironment(false));
 expect(sandbox.cwd).toBe(inputs.root);
 expect(sandbox.mounts).toContainEqual({source: join(inputs.root, "research"), writable: true});
 expect(expertSandbox(f.data, "ideas", readPythonEnvironment(false)).cwd).toBe(inputs.root);
 for (const id of ["team.data", "team.ideas"] as const) {
  const text = (id === "team.data" ? prompts.render(id, {taskId: "fixture", budget: "10", dataPaths: inputs.dataPaths, resources: inputs.resources})
   : prompts.render(id, {taskId: "fixture", budget: "10", webSearches: "3", resources: inputs.resources})).text;
  const named = [...text.matchAll(/`([^`\s]+)`/g)].map(match => match[1]).filter(path => /^[\w.-]+(\/[\w.-]*)*$/.test(path) && /[./]/.test(path) && !path.startsWith("/"));
  expect(named.length).toBeGreaterThan(2);
  for (const path of named) expect({path, exists: existsSync(join(inputs.root, path))}).toEqual({path, exists: true});
  expect(text).not.toContain("data-bullets"); expect(text).not.toContain("profile/profile.json");
 }
}, 30_000);

test("missing validation or task-data prerequisites stop every scout before its session", async () => {
 const { SetupSession, setupChecks } = await import("../pipeline/setup.js");
 const { scoutRequirements } = await import("./setup.js");
 expect(scoutRequirements("validation")).toContain("trial-checks");
 expect(scoutRequirements("validation")).not.toContain("web-search");
 const events: string[] = [];
 await expect(new SetupSession().check(setupChecks(["trial-checks"], {taskId: "fixture", prompts, executables: {git: "/nonexistent/git"}}),
  new AbortController().signal, event => events.push(event))).rejects.toThrow("validation-trial-checks");
 // Source preflight still refuses an unknown task before preparation.
 await expect(new SetupSession().check(setupChecks(["scouts"], {taskId: "no-such-task-prepared", prompts}),
  new AbortController().signal, () => {})).rejects.toThrow("scout-prompts");
 expect(events).toContain("setup_finished");
});

test('a transient unresolved reference is retried by the same resolver', async()=>{
 const f=stateFixture();const ref={experiment:'later'};
 expect((await f.resolver.status(ref)).status).toBe('unresolved');
 mkdirSync(join(f.trials,'later'),{recursive:true});const supervision=trialSupervisionDirectory(join(f.trials,'later'));mkdirSync(supervision,{recursive:true});
 writeFileSync(join(supervision,'recovery.json'),JSON.stringify({trial:{id:'later',source:{commit:f.measured.commit,tree:f.measured.tree},worktrees:[join(f.trials,'later/solutions')]},solutionsRoot:f.live}));
 expect((await f.resolver.status(ref)).status).toBe('resolved');
});
