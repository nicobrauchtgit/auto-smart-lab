import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHarnessTraining } from "./index.js";
import { TrainingService } from "./service.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { atomicJson, claimWorkspace, processIdentity, ownedProcessAlive, liveGroup } from "../experiments/ownership.js";
import { removeWorktree, tagCommit } from "./git.js";
import { temporaryProject, commitAll, trainingEnvironment, PYTHON, WORKER, PROJECT_ROOT, until } from "./testing.js";
import { recoveryTrainingRoot } from "../run/harness_solve_session.js";

const read = (directory: string, name: string) => JSON.parse(readFileSync(join(directory, name), "utf8"));
const request = (search = true, delay = 0.3) => ({ schemaVersion: 2, hypothesis: "recovery fixture",
 pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline", parameters: { delay } },
 cv: { kind: "builtin", scheme: "stratified_kfold", folds: 3, repeats: 1 }, scope: { kind: "promotion" },
 ...(search ? { search: { space: { model__C: { type: "categorical", choices: [0.1, 1] } }, sampler: "random", maxConfigs: 4 } } : {}) });
function options(project: ReturnType<typeof temporaryProject>) {
 return { root: join(project.root, "training", "origin"), env: trainingEnvironment(), pythonExecutable: PYTHON,
 projectRoot: project.root, solutionsRoot: project.solutionsRoot, taskId: "fixture", datasetSha256: project.datasetSha256,
 rootSeed: 13, zipPath: project.zipPath, labelsPath: project.labelsPath, workerPath: WORKER, maxExperiments: 1,
 pipelineRunId: "origin-run", stageInvocationId: "origin-invocation", limits: { sampleIntervalMs: 25, stopGraceMs: 100 } };
}
/** Park the fourth fit, after configuration zero's authoritative checkpoint. */
function enableFitBarrier(project: ReturnType<typeof temporaryProject>) {
 const path = join(project.solutionsRoot, "features.py");
 const counter = JSON.stringify(join(project.root, "fit-counter"));
 const marker = JSON.stringify(join(project.root, "fit-blocked"));
 const code = readFileSync(path, "utf8").replace("        if self.delay:",
  `        from pathlib import Path\n        counter = Path(${counter})\n        count = int(counter.read_text()) + 1 if counter.exists() else 1\n        counter.write_text(str(count))\n        if count == 4:\n            Path(${marker}).touch()\n            while True:\n                time.sleep(0.05)\n        if self.delay:`);
 writeFileSync(path, code); project.head = commitAll(project.solutionsRoot, "Recovery acceptance fit barrier");
}

async function startChild(project: ReturnType<typeof temporaryProject>, raw = request()) {
 const config = join(project.root, "fixture.json"); const opts = options(project);
 writeFileSync(config, JSON.stringify({ options: opts, request: raw }));
 const child = spawn(process.execPath, [join(PROJECT_ROOT, "agent/training/fixtures/recovery-service.ts"), config], { env: trainingEnvironment(), stdio: "ignore" });
 expect(await until(() => existsSync(join(opts.root, "fixture-start.json")), 10000)).toBe(true);
 return { child, opts, started: read(opts.root, "fixture-start.json") };
}
async function crash(child: ChildProcess) {
 const exited = new Promise(resolve => child.once("exit", resolve)); child.kill("SIGKILL"); await exited;
}
async function killWorker(directory: string) {
 const identity = read(directory, "worker-owner.json").identity;
 if (ownedProcessAlive(identity)) process.kill(-identity.pgid, "SIGKILL");
 expect(await until(() => liveGroup(identity.pgid).length === 0)).toBe(true);
}

test("restart reattaches quiet live worker without duplicate, preserves log cursor and origin identity", async () => {
 const project = temporaryProject("recovery-live-"); const { child, opts, started } = await startChild(project, request(false, 1));
 let training: ReturnType<typeof createHarnessTraining> | undefined;
 try {
  expect(await until(() => existsSync(join(started.directory, "single-checkpoint.json")))).toBe(true);
  const owner = read(started.directory, "worker-owner.json"); const cursor = read(started.directory, "supervisor-state.json").cursor;
  await crash(child);
  const events: any[] = [];
  training = createHarnessTraining({ ...opts, pipelineRunId: "recovery-run", stageInvocationId: "recovery-invocation", prompts: loadPromptSnapshot(), record: (type, payload) => events.push({ type, ...payload }) });
  await training.ready();
  expect(read(started.directory, "worker-owner.json").token).toBe(owner.token);
  expect(training.supervisor.status(started.id).cursor).toBeGreaterThanOrEqual(cursor);
  expect(read(started.directory, "recovery.json").attempts).toBe(0);
  expect(events.find(e => e.type === "training_recovery_live").origin_pipeline_run_id).toBe("origin-run");
  expect(await until(() => training!.supervisor.status(started.id).status !== "running")).toBe(true);
  expect(read(started.directory, "trial-result.json").status).toBe("completed");
 } finally { if (child.exitCode === null && child.signalCode === null) await crash(child); await training?.close(); await killWorker(started.directory); }
}, 45000);

test("dead search restart keeps completed configs, budget, manifest/seeds and restores cleaned candidate/champion worktrees", async () => {
 const project = temporaryProject("recovery-search-"); enableFitBarrier(project);
 tagCommit(project.solutionsRoot, "champion", project.head, JSON.stringify({ experimentId: "prior", pipeline: request().pipeline }));
 const { child, opts, started } = await startChild(project);
 let training: ReturnType<typeof createHarnessTraining> | undefined;
 try {
  expect(await until(() => existsSync(join(project.root, "fit-blocked")))).toBe(true);
  const first = read(started.directory, "search-checkpoint.json").results[0];
  const manifest = readFileSync(join(started.directory, "fold-manifest.json"), "utf8");
  const seeds = readFileSync(join(started.directory, "seed-plan.json"), "utf8");
  await crash(child); await killWorker(started.directory);
  const meta = read(started.directory, "recovery.json");
  for (const tree of meta.trial.worktrees) removeWorktree(project.solutionsRoot, tree);
  expect(recoveryTrainingRoot(join(project.root, "training"), "new")).toBe(opts.root);
  training = createHarnessTraining({ ...opts, prompts: loadPromptSnapshot() }); await training.ready();
  expect(meta.trial.worktrees.every((p: string) => existsSync(p))).toBe(true);
  expect(await until(() => training!.supervisor.status(started.id).status !== "running")).toBe(true);
  const after = read(started.directory, "search-checkpoint.json");
  expect(after.results[0]).toEqual(first); expect(after.results).toHaveLength(4);
  expect(readFileSync(join(started.directory, "fold-manifest.json"), "utf8")).toBe(manifest);
  expect(readFileSync(join(started.directory, "seed-plan.json"), "utf8")).toBe(seeds);
  expect(read(started.directory, "recovery.json").budgetUnit).toBe(started.id);
  expect((training.service.describe(started.id)!.retainedProgress as any).configurations).toBe(4);
  expect((training.service.describe(started.id)!.recovery as any).attempts).toBe(1);
  await expect(training.service.start(request())).rejects.toThrow("budget exhausted");
  expect(read(started.directory, "trial-result.json").status).toBe("completed");
 } finally { if (child.exitCode === null && child.signalCode === null) await crash(child); await training?.close(); await killWorker(started.directory); }
}, 45000);

test("single trial restart retains atomic completed fold predictions and refits only incomplete folds", async () => {
 const project = temporaryProject("recovery-single-"); const { child, opts, started } = await startChild(project, request(false, .4));
 let training: ReturnType<typeof createHarnessTraining> | undefined;
 try {
  expect(await until(() => existsSync(join(started.directory, "single-checkpoint.json")))).toBe(true);
  const before = read(started.directory, "single-checkpoint.json");
  await crash(child); await killWorker(started.directory);
  training = createHarnessTraining({ ...opts, prompts: loadPromptSnapshot() }); await training.ready();
  expect(await until(() => training!.supervisor.status(started.id).status !== "running")).toBe(true);
  const after = read(started.directory, "single-checkpoint.json");
  expect(after.completed.slice(0, before.completed.length)).toEqual(before.completed);
  expect(after.oof.slice(0, before.oof.length)).toEqual(before.oof);
  expect(after.completed).toHaveLength(3);
 } finally { if (child.exitCode === null && child.signalCode === null) await crash(child); await training?.close(); await killWorker(started.directory); }
}, 45000);

/** No-fit state-machine fixtures use real frozen repository/data metadata. */
async function durableFixture() {
 const project = temporaryProject("recovery-state-"); const opts = options(project); let starts = 0;
 const supervisor = { start(spec: any, _: any, id: string) { starts++; return { id, status: "running" as const, scope: spec.scope, hypothesis: spec.hypothesis, elapsedSeconds: 0, linesEmitted: 0, cursor: 0, logPath: "log" }; } };
 const make = () => new TrainingService({ ...opts, trainingRoot: opts.root, supervisor, validatePipeline: async () => [] });
 const original = make(); const started = await original.start(request());
 // Abrupt service loss releases the kernel claim without intentional-close metadata.
 (original as any).releaseClaims();
 return { project, opts, started, make, get starts() { return starts; } };
}
for (const [name, state, result, report, lifecycle] of [
 ["intentional cancellation", { stopReason: "agent evidence stop" }, {}, {}, "active"],
 ["cost acknowledgement pause", {}, { status: "interrupted" }, { stopReason: "acknowledgement_required" }, "active"],
 ["runtime overrun pause", {}, { status: "interrupted" }, { stopReason: "overrun" }, "active"],
 ["hard cap", {}, { status: "interrupted" }, { stopReason: "max_seconds" }, "active"],
 ["completed experiment", {}, { status: "completed" }, {}, "active"],
 ["deterministic failure", {}, { status: "failed" }, {}, "active"],
 ["service close", {}, {}, {}, "service_closed"],
] as const) test(`${name} does not automatically restart`, async () => {
 const f = await durableFixture(); const dir = f.started.directory;
 atomicJson(join(dir, "supervisor-state.json"), state); atomicJson(join(dir, "trial-result.json"), result); atomicJson(join(dir, "search-report.json"), report);
 atomicJson(join(dir, "recovery.json"), { ...read(dir, "recovery.json"), lifecycle });
 const service = f.make(); try { await service.ready(); expect(f.starts).toBe(1); } finally { await service.close(); }
});

test("concurrent workspace claims are exclusive and kernel releases them", async () => {
 const f = await durableFixture(); const release = claimWorkspace(f.opts.root);
 expect(() => claimWorkspace(f.opts.root)).toThrow("another service"); release();
 const service = f.make(); try { await service.ready(); expect(f.starts).toBe(2); } finally { await service.close(); }
});
test("PID reuse birth mismatch is never ownership", () => {
 const identity = processIdentity(process.pid)!;
 expect(ownedProcessAlive(identity)).toBe(true);
 expect(ownedProcessAlive({ ...identity, birth: `${identity.birth}-old` })).toBe(false);
});
for (const field of ["data", "invocation", "dependency", "metadata"] as const) test(`refuses incompatible/corrupt ${field} before another fit`, async () => {
 const f = await durableFixture(); const dir = f.started.directory;
 if (field === "data") writeFileSync(f.project.labelsPath, "changed");
 if (field === "invocation") writeFileSync(join(dir, "invocation.json"), "{}");
 if (field === "dependency") atomicJson(join(dir, "recovery.json"), { ...read(dir, "recovery.json"), environmentFingerprint: "different" });
 if (field === "metadata") writeFileSync(join(dir, "recovery.json"), "broken json");
 const service = f.make(); try { if (field === "metadata") await expect(service.ready()).rejects.toThrow("Corrupt"); else await service.ready(); expect(f.starts).toBe(1); } finally { await service.close(); }
});
test("two attempts bound recovery across restarts without extra experiment budget", async () => {
 const f = await durableFixture(); const dir = f.started.directory;
 for (const attempt of [1, 2, 2]) {
  const service = f.make(); await service.ready(); expect(read(dir, "recovery.json").attempts).toBe(attempt);
  await expect(service.start(request())).rejects.toThrow("budget exhausted"); (service as any).releaseClaims();
 }
 expect(f.starts).toBe(3);
});
test("agent resume tool resumes intentional pause and requires cost acknowledgement", async () => {
 const f = await durableFixture(); const dir = f.started.directory;
 atomicJson(join(dir, "trial-result.json"), { status: "interrupted", runtimeGuard: { projectedSeconds: 50 } });
 atomicJson(join(dir, "search-report.json"), { stopReason: "acknowledgement_required", runtimeGuard: { projectedSeconds: 50 } });
 const training = createHarnessTraining({ ...f.opts, prompts: loadPromptSnapshot(), validatePipeline: async () => [] });
 try {
  await training.ready();
  const tool = training.tools.find(t => t.name === "experiment_resume")!;
  await expect(tool.execute("resume", { id: f.started.id }, new AbortController().signal)).rejects.toThrow("acceptEstimatedSeconds");
  await expect(tool.execute("resume", { id: f.started.id, acceptEstimatedSeconds: 1 }, new AbortController().signal)).rejects.toThrow("at least 50");
  const result = await tool.execute("resume", { id: f.started.id, acceptEstimatedSeconds: 50 }, new AbortController().signal);
  expect(result.content[0].text).toContain('"budgetConsumed":false');
  expect(await until(() => training.supervisor.status(f.started.id).status !== "running")).toBe(true);
  expect(read(dir, "trial-result.json").status).toBe("completed");
 } finally { await training.close(); }
}, 45000);

test("worker death during an active session is diagnosed and recovered once", async () => {
 const project = temporaryProject("recovery-active-"); enableFitBarrier(project); const opts = options(project); const events: string[] = [];
 const training = createHarnessTraining({ ...opts, prompts: loadPromptSnapshot(), record: type => events.push(type) });
 try {
  const started = await training.service.start(request());
  expect(await until(() => existsSync(join(project.root, "fit-blocked")))).toBe(true);
  await killWorker(started.directory);
  expect(await until(() => read(started.directory, "recovery.json").attempts === 1 && existsSync(join(started.directory, "trial-result.json")))).toBe(true);
  expect(read(started.directory, "trial-result.json").status).toBe("completed");
  expect(events).toContain("training_recovery_attempt"); expect(events).toContain("training_recovery_started");
 } finally { await training.close(); }
}, 45000);

test("restored original experiment budget cannot be increased by restart options", async () => {
 const f = await durableFixture();
 const service = new TrainingService({ ...f.opts, trainingRoot: f.opts.root, maxExperiments: 100,
  supervisor: { start() { throw new Error("No additional budget"); } }, validatePipeline: async () => [] });
 try { await service.ready(); await expect(service.start(request())).rejects.toThrow("budget exhausted (1)"); }
 finally { await service.close(); }
});

test("a live group with unverifiable/reused leader blocks recovery and is never signalled", async () => {
 const f = await durableFixture();
 const child = spawn(PYTHON, ["-c", "import time; time.sleep(20)"], { detached: true, stdio: "ignore", env: trainingEnvironment() });
 const service = f.make();
 try {
  expect(await until(() => !!processIdentity(child.pid!))).toBe(true);
  const identity = processIdentity(child.pid!)!;
  atomicJson(join(f.started.directory, "supervisor-state.json"), { identity: { ...identity, birth: identity.birth + "-reused" }, status: "running" });
  await service.ready(); expect(f.starts).toBe(1); expect(ownedProcessAlive(identity)).toBe(true);
  await service.close(); expect(ownedProcessAlive(identity)).toBe(true);
 } finally { child.kill("SIGKILL"); (service as any).releaseClaims(); }
});

test("live dependency inventory drift refuses recovery even with the same startup fingerprint", async () => {
 const f = await durableFixture();
 expect(read(f.started.directory, "recovery.json").runtimeDependencyHash).toMatch(/^[a-f0-9]{64}$/);
 const service = f.make(); (service as any).runtimeDependencyHash = () => "changed-live-inventory";
 try { await service.ready(); expect(f.starts).toBe(1); expect(read(f.started.directory, "recovery.json").diagnosis).toContain("incompatible"); }
 finally { await service.close(); }
});

test("altered frozen worktree is refused and preserved through cleanup", async () => {
 const f = await durableFixture(); const meta = read(f.started.directory, "recovery.json");
 const path = join(meta.trial.worktrees[0], "features.py"); writeFileSync(path, "# retained edit\n");
 const service = f.make(); await service.ready(); await service.close();
 expect(f.starts).toBe(1); expect(readFileSync(path, "utf8")).toBe("# retained edit\n");
});
