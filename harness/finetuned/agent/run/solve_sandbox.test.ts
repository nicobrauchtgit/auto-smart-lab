import { expect, test } from "bun:test";
import { copyFileSync, realpathSync, mkdtempSync, existsSync, mkdirSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { prepareSolveSandbox, isolatedSolveTools, trainingSandboxCommand, checkSolveSandbox, solvePythonEnvironmentTool, pythonManagerEnvironment } from "./solve_sandbox.js";
import { tmpdir } from "node:os";
import { liveGroup } from "../experiments/ownership.js";
import { spawnSync } from "node:child_process";
import { validatePythonEnvironment, type PythonEnvironment } from "./python_environment.js";
import { temporaryProject, writeSampleManifest, trainingEnvironment, PYTHON, WORKER, until } from "../training/testing.js";
import { createHarnessTraining } from "../training/index.js";
import { git } from "../training/git.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { SetupSession, setupChecks } from "../pipeline/setup.js";
import type { SolveWorkspace } from "../solve/workspace.js";

// Worktrees share the project environment as a symlink; the manager correctly
// refuses to manage that alias, so inspect its actual owning project for tests.
const environmentRoot = dirname(realpathSync(join(import.meta.dir, "../../.venv")));
function readPythonEnvironment(): PythonEnvironment {
 const prefix = join(environmentRoot, ".venv");
 const probe = spawnSync(join(prefix, "bin/python"), ["-I", join(environmentRoot, "agent/setup/python_environment.py"), "inspect", "--json"],
  { env: { ...process.env, VENV_DIR: prefix }, encoding: "utf8" });
 if (probe.status !== 0) throw new Error(probe.stderr);
 return validatePythonEnvironment(JSON.parse(probe.stdout));
}

function fixture() {
 const project = temporaryProject("solve-sandbox-");
 const root = join(project.root, "runs/fixture/solve"), researchDir = join(root, "research");
 mkdirSync(researchDir, { recursive: true });
 const data = join(root, "data"); mkdirSync(data);
 const devZip = join(data, "dev.zip"), testZip = join(data, "test.zip");
 copyFileSync(project.zipPath, devZip); copyFileSync(project.zipPath, testZip);
 const manifest = writeSampleManifest(data, devZip, project.labelsPath);
 const taskPath = join(root, "task.md"); writeFileSync(taskPath, "task runtime instructions");
 writeFileSync(join(researchDir, "research.md"), "selected research");
 const hidden = [project.zipPath, project.labelsPath, join(data, "sealed_ids.txt"), join(project.root, "other-task.zip"), join(project.root, "AGENTS.md")];
 for (const path of hidden.slice(2)) writeFileSync(path, "HIDDEN_INTEGRITY_MARKER");
 const workspace = { root, solutionsRoot: project.solutionsRoot, devZip, testZip, taskPath, researchDir,
  sampleManifestPath: manifest.sampleManifestPath } as SolveWorkspace;
 const python = readPythonEnvironment(), policy = prepareSolveSandbox(workspace, python);
 return { project, workspace, manifest, hidden, python, policy };
}

const content = (result: any) => result.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n");

async function execute(tools: ReturnType<typeof isolatedSolveTools>, name: string, params: any) {
 return await tools.find(tool => tool.name === name)!.execute("test-call", params, undefined, undefined, undefined as any);
}

test("all file/shell tools enforce mounts against absolute paths, symlinks and host proc escapes", async () => {
 const { project, workspace, hidden, policy } = fixture();
 const tools = isolatedSolveTools(policy);
 expect(content(await execute(tools, "read", { path: workspace.taskPath }))).toContain("runtime instructions");
 expect(content(await execute(tools, "read", { path: join(workspace.researchDir, "research.md") }))).toContain("selected research");
 for (const path of hidden) await expect(execute(tools, "read", { path })).rejects.toThrow();
 const alias = join(project.solutionsRoot, "escape"); symlinkSync(hidden[2]!, alias);
 await expect(execute(tools, "read", { path: alias })).rejects.toThrow();
 for (const name of ["ls", "find", "grep"]) await expect(execute(tools, name, { path: hidden[2], pattern: "HIDDEN" })).rejects.toThrow();
 await expect(execute(tools, "write", { path: hidden[2], content: "overwrite" })).rejects.toThrow("persistent solve workspace");
 await expect(execute(tools, "edit", { path: hidden[2], edits: [{ oldText: "HIDDEN", newText: "override" }] })).rejects.toThrow();
 const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
 const probes = hidden.map(path => `test ! -e ${quote(path)} && test ! -e ${quote(`/proc/1/root${path}`)}`).join(" && ");
 const result = await execute(tools, "bash", { command: `${probes} && test -f ${quote(workspace.devZip)} && test -f ${quote(workspace.testZip)} && test -z "$SAIA_API_KEY" && printf boundary-ok` });
 expect(content(result)).toContain("boundary-ok");
 const writable = join(policy.agentRoot, "scratch.txt");
 await execute(tools, "write", { path: writable, content: "scratch" });
 expect(readFileSync(writable, "utf8")).toBe("scratch");
 expect(readFileSync(hidden[2]!, "utf8")).toBe("HIDDEN_INTEGRITY_MARKER");
}, 30_000);

test("pipeline validation, custom features and harness fits cannot read hidden host data", async () => {
 const { project, manifest, hidden, policy, python } = fixture();
 const path = join(project.solutionsRoot, "features.py");
 writeFileSync(path, `from pathlib import Path\nHIDDEN = ${JSON.stringify(hidden)}\nassert not any(Path(path).exists() for path in HIDDEN), 'factory escaped data boundary'\n` +
  readFileSync(path, "utf8").replace('        # Raw sample input:', '        assert not any(Path(path).exists() for path in HIDDEN), "fit escaped data boundary"\n        # Raw sample input:'));
 git(project.solutionsRoot, ["add", "."]); git(project.solutionsRoot, ["commit", "-m", "boundary assertions"]);
 const training = createHarnessTraining({ root: join(project.root, "training"), projectRoot: project.root, solutionsRoot: project.solutionsRoot,
  taskId: "fixture", pythonExecutable: python.executable, env: trainingEnvironment(), datasetSha256: manifest.datasetSha256,
  rootSeed: 13, measurement: manifest.measurement, workerPath: WORKER, prompts: loadPromptSnapshot(),
  sandboxCommand: (command, input) => trainingSandboxCommand(policy, command, input), executionBoundaryFingerprint: "fixture",
  limits: { sampleIntervalMs: 25, stopGraceMs: 100 } });
 try {
  const trial = await training.service.start({ schemaVersion: 2, hypothesis: "boundary check", pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline", parameters: { jobs: 2 } },
   cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 }, scope: { kind: "promotion" } });
  expect(await until(() => training.supervisor.status(trial.id).status !== "running")).toBe(true);
  await training.service.finalize(trial.id);
  const result = JSON.parse(readFileSync(join(trial.directory, "trial-result.json"), "utf8"));
  expect(result.status).toBe("completed"); expect(result.promotionEligible).toBe(true);
  expect(result.metrics.balancedAccuracy).toBe(1);
 } finally { await training.close(); }
}, 40_000);

test("unavailable isolation fails closed through shared preflight", async () => {
 const events: string[] = [];
 const checks = setupChecks(["solve-isolation"], { taskId: "fixture", prompts: loadPromptSnapshot(), executables: { bwrap: "/missing/bubblewrap" } });
 await expect(new SetupSession().check(checks, new AbortController().signal, type => events.push(type))).rejects.toThrow("solve-filesystem-isolation");
 expect(events).toContain("setup_finished");
 expect(() => checkSolveSandbox("/missing/bubblewrap")).toThrow();
});

test("observed dependency tool uses the shared manager for read-only inspection", async () => {
 const python = readPythonEnvironment(), prompts = loadPromptSnapshot();
 const tool = solvePythonEnvironmentTool(python, prompts.render("solve.python-environment-tool", {}).text, environmentRoot);
 const result = await tool.execute("inspect", { operation: "inspect" }, undefined, undefined, undefined as any);
 const inventory = JSON.parse(content(result));
 expect(inventory.schema_version).toBe(1); expect(inventory.fingerprint).toBe(python.fingerprint);
 await expect(tool.execute("invalid", { operation: "add", package: "numpy" }, undefined, undefined, undefined as any)).rejects.toThrow("reason");
}, 30_000);


test("dependency manager audit retains explicit run/invocation/attempt/session identity and excludes credentials", () => {
 const python = readPythonEnvironment();
 const environment = pythonManagerEnvironment(python, environmentRoot, { pipelineRunId: "origin-run", stageInvocationId: "origin-stage", attempt: 1, sessionId: "origin-session" });
 expect(environment.PIPELINE_RUN_ID).toBe("origin-run");
 expect(environment.PIPELINE_STAGE_INVOCATION_ID).toBe("origin-stage");
 expect(environment.PIPELINE_AGENT_ATTEMPT).toBe("1");
 expect(environment.PIPELINE_PYTHON_SESSION_ID).toBe("origin-session");
 expect(environment.SAIA_API_KEY).toBeUndefined();
 expect(environment.UV_CACHE_DIR).toBe(join(environmentRoot, ".tools/uv/cache"));
});


test("sandboxed fit descendants stop with their owned group and changed boundary refuses resume", async () => {
 const { project, manifest, policy, python } = fixture();
 const root = join(project.root, "training"), events: Array<{ type: string; payload: any }> = [];
 const harness = (fingerprint: string) => createHarnessTraining({ root, projectRoot: project.root, solutionsRoot: project.solutionsRoot,
  taskId: "fixture", pythonExecutable: python.executable, env: trainingEnvironment(), datasetSha256: manifest.datasetSha256,
  rootSeed: 13, measurement: manifest.measurement, workerPath: WORKER, prompts: loadPromptSnapshot(),
  sandboxCommand: (command, input) => trainingSandboxCommand(policy, command, input), executionBoundaryFingerprint: fingerprint,
  record: (type, payload) => events.push({ type, payload }), limits: { sampleIntervalMs: 25, stopGraceMs: 100 } });
 const features = join(project.solutionsRoot, "features.py");
 writeFileSync(features, readFileSync(features, "utf8").replace("        if self.delay:",
  "        import subprocess, sys\n        if self.delay:\n            subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n            print('SANDBOX_CHILD_STARTED', flush=True)\n        if self.delay:"));
 git(project.solutionsRoot, ["add", "."]); git(project.solutionsRoot, ["commit", "-m", "owned namespace child fixture"]);
 const training = harness("boundary-one");
 let trial: Awaited<ReturnType<typeof training.service.start>>;
 try {
  trial = await training.service.start({ schemaVersion: 2, hypothesis: "interrupt multiprocessing fit", pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline", parameters: { delay: 30, jobs: 2 } },
   cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 }, scope: { kind: "promotion" } });
  const record = JSON.parse(readFileSync(join(trial.directory, "experiment.json"), "utf8"));
  expect(await until(() => readFileSync(join(trial.directory, "output.log"), "utf8").includes("SANDBOX_CHILD_STARTED"))).toBe(true);
  expect(liveGroup(record.pgid).length).toBeGreaterThanOrEqual(4);
  const stopped = await training.supervisor.stop(trial.id, "fixture interruption");
  expect(stopped.status).toBe("stopped");
  expect(await until(() => liveGroup(record.pgid).length === 0)).toBe(true);
 } finally { await training.close(); }
 const changed = harness("boundary-two");
 try { await expect(changed.service.resume(trial!.id)).rejects.toThrow(/Recovery inputs are incompatible/i);
  expect(events.some(event => event.type === "training_recovery_refused")).toBe(true);
 } finally { await changed.close(); }
}, 40_000);

test("cancelling dependency manager stops its uv-like descendant group", async () => {
 const python = readPythonEnvironment(), managerRoot = mkdtempSync(join(tmpdir(), "manager-cancel-"));
 const setup = join(managerRoot, "agent/setup"); mkdirSync(setup, { recursive: true });
 const receipt = join(managerRoot, "group.json");
 writeFileSync(join(setup, "python_environment.py"), `import json, os, pathlib, subprocess, sys, time
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
pathlib.Path(${JSON.stringify(receipt)}).write_text(json.dumps({'group': os.getpgrp(), 'child': child.pid}))
time.sleep(60)
`);
 const tool = solvePythonEnvironmentTool(python, "fixture manager", managerRoot);
 const controller = new AbortController();
 const pending = tool.execute("cancel", { operation: "inspect" }, controller.signal, undefined, undefined as any);
 expect(await until(() => existsSync(receipt))).toBe(true);
 const group = JSON.parse(readFileSync(receipt, "utf8")).group;
 expect(liveGroup(group).length).toBeGreaterThanOrEqual(2);
 controller.abort();
 await expect(pending).rejects.toThrow("cancelled");
 expect(await until(() => liveGroup(group).length === 0)).toBe(true);
}, 20_000);
