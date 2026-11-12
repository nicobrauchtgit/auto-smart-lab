import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statfsSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { liveGroup } from "../experiments/ownership.js";
import { SetupSession, setupChecks } from "../pipeline/setup.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { checkSandboxScratch, sandboxPolicy, type SolveSandbox } from "./solve_sandbox.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "disk-sandbox-test-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const bun = realpathSync(process.execPath);
const PATH = "/run/current-system/sw/bin:/usr/bin:/bin";

function fixture() {
 const root = mkdtempSync(join(base, "case-"));
 const workspace = join(root, "workspace"); mkdirSync(workspace);
 const scratchRoot = join(root, "scratch");
 const policy = sandboxPolicy({ cwd: workspace, scratchRoot,
  mounts: [{ source: workspace, writable: true }, { source: dirname(bun) }],
  env: { PATH, TMPDIR: "/dev/shm", TEMP: "/dev/shm", TMP: "/dev/shm", JOBLIB_TEMP_FOLDER: "/dev/shm" } });
 return { root, workspace, scratchRoot, policy };
}
function run(policy: SolveSandbox, script: string) {
 return spawnSync(policy.executable, policy.args([bun, "-e", script]), { encoding: "utf8", timeout: 10_000 });
}
const waitFor = async (predicate: () => boolean) => {
 const end = Date.now() + 5000;
 while (!predicate() && Date.now() < end) await Bun.sleep(20);
 expect(predicate()).toBe(true);
};
function start(policy: SolveSandbox, script: string) {
 const child = spawn(policy.executable, policy.args([bun, "-e", script]), { detached: true, stdio: ["ignore", "pipe", "pipe"] });
 let stderr = "";
 child.stderr.on("data", data => { stderr += data.toString(); });
 const ended = new Promise<{code: number | null; signal: string | null}>(accept => child.on("close", (code, signal) => accept({code, signal})));
 return {child, ended, stderr: () => stderr};
}

test("temporary files and default library scratch use disk despite RAM temp overrides", () => {
 const f = fixture();
 const result = run(f.policy, `const fs = require('node:fs'); fs.writeFileSync('/tmp/example', 'scratch'); console.log(JSON.stringify({
  type: fs.statfsSync('/tmp').type, tmp: process.env.TMPDIR, temp: process.env.TEMP, joblib: process.env.JOBLIB_TEMP_FOLDER,
  home: fs.existsSync('/tmp/home'), sibling: fs.existsSync(${JSON.stringify(f.scratchRoot)}) }));`);
 expect({status: result.status, stderr: result.stderr}).toEqual({status: 0, stderr: ""});
 expect(JSON.parse(result.stdout)).toEqual({ type: statfsSync(f.root).type, tmp: "/tmp", temp: "/tmp", joblib: "/tmp", home: true, sibling: false });
 expect(readdirSync(f.scratchRoot)).toEqual([]);
});

test("success/failure cleanup never follows hostile symlinks or chmod, including very deep trees", () => {
 const f = fixture(), marker = join(f.root, "host-marker.txt");
 writeFileSync(marker, "HARMLESS_HOST_MARKER");
 const result = run(f.policy, `const fs = require('node:fs');
  fs.symlinkSync(${JSON.stringify(marker)}, '/tmp/host-link'); fs.mkdirSync('/tmp/nested');
  fs.symlinkSync(${JSON.stringify(f.root)}, '/tmp/nested/host-directory'); fs.chmodSync('/tmp/nested', 0);
  fs.mkdirSync('/tmp/deep'); process.chdir('/tmp/deep');
  for (let i = 0; i < 1100; i++) { fs.mkdirSync('d'); process.chdir('d'); }
  process.exit(7);`);
 expect({status: result.status, stderr: result.stderr}).toEqual({status: 7, stderr: ""});
 expect(readFileSync(marker, "utf8")).toBe("HARMLESS_HOST_MARKER");
 expect(readdirSync(f.scratchRoot)).toEqual([]);
});

test("parallel invocations have separate scratch and cannot see each other's files", async () => {
 const f = fixture(), ready = join(f.workspace, "ready");
 const first = start(f.policy, `require('node:fs').writeFileSync('/tmp/private-first', 'first'); require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`);
 try {
  await waitFor(() => existsSync(ready));
  expect(readdirSync(f.scratchRoot)).toHaveLength(1);
  const second = run(f.policy, `console.log(require('node:fs').existsSync('/tmp/private-first'));`);
  expect(second.status).toBe(0); expect(second.stdout.trim()).toBe("false");
  expect(readdirSync(f.scratchRoot)).toHaveLength(1);
 } finally { first.child.kill("SIGTERM"); await first.ended; }
 expect(readdirSync(f.scratchRoot)).toEqual([]);
});

test("cancellation terminates namespace descendants and removes disk scratch", async () => {
 const f = fixture(), ready = join(f.workspace, "ready");
 const running = start(f.policy, `const fs = require('node:fs'); const cp = require('node:child_process');
  cp.spawn(${JSON.stringify(bun)}, ['-e', 'setInterval(() => {}, 1000)'], {detached: true, stdio: 'ignore'});
  fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
 await waitFor(() => existsSync(ready));
 const before = Date.now(); running.child.kill("SIGTERM");
 await running.ended;
 expect(Date.now() - before).toBeLessThan(4000);
 expect(running.stderr()).toBe("");
 await waitFor(() => liveGroup(running.child.pid!).length === 0);
 expect(readdirSync(f.scratchRoot)).toEqual([]);
});

test("a hard kill leaves private evidence-free scratch, reclaimed safely on a later launch", async () => {
 const f = fixture(), ready = join(f.workspace, "ready"), marker = join(f.root, "host-marker.txt");
 writeFileSync(marker, "HARMLESS_HOST_MARKER");
 const running = start(f.policy, `const fs = require('node:fs'); fs.symlinkSync(${JSON.stringify(marker)}, '/tmp/host-link');
  fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`);
 await waitFor(() => existsSync(ready));
 const [job] = readdirSync(f.scratchRoot);
 running.child.kill("SIGKILL"); await running.ended;
 await waitFor(() => liveGroup(running.child.pid!).length === 0);
 expect(readdirSync(f.scratchRoot)).toEqual([job!]);
 const old = new Date(Date.now() - 120_000); utimesSync(join(f.scratchRoot, job!), old, old);
 expect(run(f.policy, "console.log('recovered')").status).toBe(0);
 expect(readdirSync(f.scratchRoot)).toEqual([]);
 expect(readFileSync(marker, "utf8")).toBe("HARMLESS_HOST_MARKER");
});

test("stale cleanup skips a live invocation even if its directory timestamp is old", async () => {
 const f = fixture(), ready = join(f.workspace, "ready");
 const running = start(f.policy, `const fs = require('node:fs'); fs.writeFileSync('/tmp/live', 'live'); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); setInterval(() => {}, 1000);`);
 try {
  await waitFor(() => existsSync(ready));
  const [job] = readdirSync(f.scratchRoot), old = new Date(Date.now() - 120_000);
  utimesSync(join(f.scratchRoot, job!), old, old);
  expect(run(f.policy, "console.log('another')").status).toBe(0);
  expect(readFileSync(join(f.scratchRoot, job!, "tmp/live"), "utf8")).toBe("live");
 } finally { running.child.kill("SIGTERM"); await running.ended; }
 expect(readdirSync(f.scratchRoot)).toEqual([]);
});

test("RAM-backed scratch, symlink roots and roots visible to a sandbox fail closed", () => {
 const f = fixture(), alias = join(f.root, "alias"); mkdirSync(f.scratchRoot, { mode: 0o700 }); symlinkSync(f.scratchRoot, alias);
 expect(() => checkSandboxScratch(alias)).toThrow("disk-backed");
 expect(() => sandboxPolicy({ cwd: f.root, mounts: [{ source: f.root }], scratchRoot: f.scratchRoot })).toThrow("outside every sandbox mount");
 const ram = mkdtempSync("/dev/shm/sandbox-refusal-");
 try { expect(() => checkSandboxScratch(ram)).toThrow("disk-backed"); }
 finally { rmSync(ram, { recursive: true, force: true }); }
});

test("shared preflight declares and executes the disk scratch prerequisite before agents", async () => {
 const checks = setupChecks(["solve-isolation"], { taskId: "fixture", prompts: loadPromptSnapshot() });
 const scratch = checks.find(check => check.id === "solve-disk-scratch");
 expect(scratch?.phase).toBe("local");
 await new SetupSession().check([scratch!], new AbortController().signal, () => {});
});
