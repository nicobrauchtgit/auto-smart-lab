import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { SetupSession, setupChecks } from "../pipeline/setup.js";
import { createScouts } from "./scouts.js";
import { READ_ONLY_SCOUT_TOOLS, scoutToolset } from "./runner.js";
const prompts = loadPromptSnapshot();

function scoutsBehindSetup(scoutPaths: {journal: string; unitIntro: string}) {
 const starts = {count: 0};
 const scope = createScouts({prompts, taskId: "fixture", task: "task", unitIntro: "intro", dataPaths: "dev", journalPath: scoutPaths.journal,
  datasetSha256: "data", runId: "run", invocationId: "invoke",
  prepare: (_roles, signal) => new SetupSession().check(setupChecks(["scouts"], {taskId: "fixture", prompts, scoutPaths}), signal ?? new AbortController().signal, () => {}),
  run: async () => {starts.count++; return "- result";}});
 return {scope, starts};
}

test("scout-prompts preflight blocks every scout on a missing unit introduction or unwritable journal", async () => {
 const root = mkdtempSync(join(tmpdir(), "scout-setup-"));
 const unitIntro = join(root, "unit-intro.md"); writeFileSync(unitIntro, "Unit introduction");
 const journal = join(root, "task/findings/journal.jsonl");

 const missing = scoutsBehindSetup({journal, unitIntro: join(root, "missing/unit-intro.md")});
 await expect(missing.scope.scout({role: ["data", "ideas"], question: "q"})).rejects.toThrow("scout-prompts");
 expect(missing.starts.count).toBe(0);

 const locked = join(root, "locked"); mkdirSync(locked); chmodSync(locked, 0o500);
 try {
  const unwritable = scoutsBehindSetup({journal: join(locked, "journal.jsonl"), unitIntro});
  await expect(unwritable.scope.scout({role: "data", question: "q"})).rejects.toThrow("scout-prompts");
  expect(unwritable.starts.count).toBe(0);
 } finally {chmodSync(locked, 0o700);}

 const ready = scoutsBehindSetup({journal, unitIntro});
 expect(await ready.scope.scout({role: "data", question: "q"})).toBe("- result");
 expect(ready.starts.count).toBe(1);
});

test("the runner's tool set: ideas is read-only with search, data writes only its research folder", () => {
 const root = mkdtempSync(join(tmpdir(), "scout-tools-"));
 const workspace = join(root, "workspace"), shared = join(root, "shared");
 mkdirSync(join(workspace, "research"), {recursive: true}); mkdirSync(shared);
 // The real policy needs an executable for bubblewrap; no process is started here.
 const sandbox = {executable: process.execPath, cwd: workspace, env: {}, args: () => [],
  mounts: [{source: workspace, writable: true}, {source: shared, writable: true}, {source: join(root, "data")}]};
 const ideas = scoutToolset("ideas", {sandbox, researchRoot: join(workspace, "research"), searchApiKey: "fixture"});
 expect(ideas.tools.map(tool => tool.name).sort()).toEqual([...READ_ONLY_SCOUT_TOOLS, "web_search"].sort());
 expect(ideas.sandbox.mounts.filter(mount => mount.writable)).toEqual([]);
 expect(ideas.sandbox.args(["true"])).not.toContain("--bind");

 const data = scoutToolset("data", {sandbox, researchRoot: join(workspace, "research")});
 expect(data.tools.map(tool => tool.name)).toContain("bash"); expect(data.tools.map(tool => tool.name)).not.toContain("web_search");
 expect(data.sandbox.mounts.filter(mount => mount.writable).map(mount => mount.source)).toEqual([join(workspace, "research")]);
 const args = data.sandbox.args(["true"]);
 expect(args[args.indexOf("--bind") + 1]).toBe(join(workspace, "research"));
 expect(args.filter(arg => arg === "--bind").length).toBe(1);

 expect(() => scoutToolset("ideas", {sandbox, researchRoot: join(workspace, "research")})).toThrow("search key");
 expect(() => scoutToolset("data", {sandbox, researchRoot: join(root, "elsewhere")})).toThrow("research/ folder");
});
