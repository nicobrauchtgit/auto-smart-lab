import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ensureSolutionsRepository, git, addWorktree, resolveCommit } from "./git.js";
import { runTrialChecks } from "./trial_checks.js";
test("live fixes cannot make a defective measured snapshot pass executable checks", async () => {
 const root = mkdtempSync(join(tmpdir(), "frozen-check-"));
 const live = join(root, "live", "solutions"), frozen = join(root, "snapshot", "solutions");
 try {
  ensureSolutionsRepository(live);
  writeFileSync(join(live, "model.py"), "value = False\n");
  git(live, ["add", "-A"]); git(live, ["commit", "-qm", "measured defect"]);
  const source = resolveCommit(live, "HEAD")!;
  addWorktree(live, frozen, source.commit);
  mkdirSync(join(live, "checks"));
  const check = join(live, "checks", "test_model.py");
  writeFileSync(check, "from solutions.model import value\nassert value\n");
  writeFileSync(join(live, "model.py"), "value = True\n");
  git(live, ["add", "-A"]); git(live, ["commit", "-qm", "live fix"]);
  // The process adapter is deliberately unsandboxed in this unit test; production supplies bubblewrap.
  const result = await runTrialChecks({ experimentId: "measured", commit: source.commit, tree: source.tree, sourceRoot: dirname(frozen) }, [check], { executable: "env", bwrap: "env", scratchRoot: "/nonexistent-scratch", cwd: live, mounts: [{ source: dirname(frozen) }], env: { ...process.env } as Record<string, string>, args: command => command });
  expect(result.passed).toBe(false);
  expect(result.checks[0].exitCode).toBe(1);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cancelling a check that traps SIGTERM escalates to SIGKILL on its whole process group", async () => {
 const root = mkdtempSync(join(tmpdir(), "check-cancel-"));
 const live = join(root, "live", "solutions"), frozen = join(root, "snapshot", "solutions");
 const marker = join(root, "pids");
 try {
  ensureSolutionsRepository(live);
  writeFileSync(join(live, "model.py"), "value = True\n");
  git(live, ["add", "-A"]); git(live, ["commit", "-qm", "measured"]);
  const source = resolveCommit(live, "HEAD")!;
  addWorktree(live, frozen, source.commit);
  mkdirSync(join(live, "checks"));
  const check = join(live, "checks", "test_hangs.py");
  // The check handles SIGTERM, and its descendant ignores it while holding the output pipes.
  writeFileSync(check, `import os, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, lambda *_: None)
child = subprocess.Popen([sys.executable, "-c", "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(120)"])
with open(${JSON.stringify(marker)}, "w") as stream:
    stream.write(f"{os.getpid()} {child.pid}")
while True:
    time.sleep(0.05)
`);
  const controller = new AbortController();
  const running = runTrialChecks({ experimentId: "hang", commit: source.commit, tree: source.tree, sourceRoot: dirname(frozen) }, [check],
   { executable: "env", bwrap: "env", scratchRoot: "/nonexistent-scratch", cwd: live, mounts: [{ source: dirname(frozen) }], env: { ...process.env } as Record<string, string>, args: command => command },
   controller.signal, { cancelGraceMs: 200 });
  const outcome = running.then(() => "resolved", () => "rejected");
  const deadline = Date.now() + 20_000;
  while (!(existsSync(marker) && readFileSync(marker, "utf8").includes(" ")) && Date.now() < deadline) await Bun.sleep(25);
  const pids = readFileSync(marker, "utf8").split(" ").map(Number);
  const cancelledAt = Date.now();
  controller.abort(new Error("cancelled by test"));
  const settled = await Promise.race([outcome, Bun.sleep(10_000).then(() => "hung")]);
  expect(settled).toBe("rejected");
  expect(Date.now() - cancelledAt).toBeLessThan(5_000);
  const alive = (pid: number) => { try { process.kill(pid, 0); return !readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z"); } catch { return false; } };
  for (const pid of pids) expect(alive(pid)).toBe(false);
 } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);

test("a cancelled check whose leader exits still has its SIGTERM-ignoring descendant killed", async () => {
 const root = mkdtempSync(join(tmpdir(), "check-cancel-leader-"));
 const live = join(root, "live", "solutions"), frozen = join(root, "snapshot", "solutions");
 const marker = join(root, "pids");
 try {
  ensureSolutionsRepository(live);
  writeFileSync(join(live, "model.py"), "value = True\n");
  git(live, ["add", "-A"]); git(live, ["commit", "-qm", "measured"]);
  const source = resolveCommit(live, "HEAD")!;
  addWorktree(live, frozen, source.commit);
  mkdirSync(join(live, "checks"));
  const check = join(live, "checks", "test_hangs.py");
  // The leader exits on SIGTERM; its descendant ignores SIGTERM and does not hold the output pipes.
  writeFileSync(check, `import os, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
ready = ${JSON.stringify(marker)} + ".ready"
child = subprocess.Popen([sys.executable, "-c", "import pathlib, signal, sys, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); pathlib.Path(sys.argv[1]).touch(); time.sleep(120)", ready],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
while not os.path.exists(ready):
    time.sleep(0.01)
with open(${JSON.stringify(marker)}, "w") as stream:
    stream.write(f"{os.getpid()} {child.pid}")
while True:
    time.sleep(0.05)
`);
  const controller = new AbortController();
  const running = runTrialChecks({ experimentId: "leader-exits", commit: source.commit, tree: source.tree, sourceRoot: dirname(frozen) }, [check],
   { executable: "env", bwrap: "env", scratchRoot: "/nonexistent-scratch", cwd: live, mounts: [{ source: dirname(frozen) }], env: { ...process.env } as Record<string, string>, args: command => command },
   controller.signal, { cancelGraceMs: 200 });
  const outcome = running.then(() => "resolved", () => "rejected");
  const deadline = Date.now() + 20_000;
  while (!(existsSync(marker) && readFileSync(marker, "utf8").includes(" ")) && Date.now() < deadline) await Bun.sleep(25);
  const pids = readFileSync(marker, "utf8").split(" ").map(Number);
  const cancelledAt = Date.now();
  controller.abort(new Error("cancelled by test"));
  const settled = await Promise.race([outcome, Bun.sleep(10_000).then(() => "hung")]);
  expect(settled).toBe("rejected");
  expect(Date.now() - cancelledAt).toBeLessThan(5_000);
  const alive = (pid: number) => { try { process.kill(pid, 0); return !readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].startsWith("Z"); } catch { return false; } };
  // SIGKILL is delivered asynchronously; allow the kernel a moment to end the process.
  const until = Date.now() + 2_000;
  while (pids.some(alive) && Date.now() < until) await Bun.sleep(25);
  for (const pid of pids) expect(alive(pid)).toBe(false);
 } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);


test("validation check output ignores host-file symlinks and a swapped scratch directory", async () => {
 const root = mkdtempSync(join(tmpdir(), "check-log-swap-"));
 const live = join(root, "live", "solutions"), frozen = join(root, "snapshot", "solutions");
 const host = join(root, "host"); mkdirSync(host);
 const marker = "HARMLESS_HOST_MARKER_validation_symlink";
 const secret = join(host, "marker.txt"); writeFileSync(secret, marker);
 try {
  ensureSolutionsRepository(live);
  writeFileSync(join(live, "model.py"), "value = True\n");
  git(live, ["add", "-A"]); git(live, ["commit", "-qm", "measured"]);
  const source = resolveCommit(live, "HEAD")!; addWorktree(live, frozen, source.commit);
  mkdirSync(join(live, "checks"));
  const outputRoot = join(live, "scratch", "validation", "swap");
  const check = join(live, "checks", "swap.py");
  writeFileSync(check, `import os
from pathlib import Path
p = Path(${JSON.stringify(outputRoot)})
p.mkdir(parents=True, exist_ok=True)
(p / "0.log").symlink_to(${JSON.stringify(secret)})
print("REAL_CHECK_OUTPUT", flush=True)
p.rename(str(p) + "-moved")
p.symlink_to(${JSON.stringify(host)})
`);
  const result = await runTrialChecks({experimentId: "swap", commit: source.commit, tree: source.tree, sourceRoot: dirname(frozen)}, [check],
   { executable: "env", bwrap: "env", scratchRoot: "/nonexistent-scratch", cwd: live, mounts: [{source: dirname(frozen)}, {source: live, writable: true}], env: {...process.env} as Record<string,string>, args: command => command});
  expect(result.passed).toBe(true);
  expect(result.checks[0].output).toContain("REAL_CHECK_OUTPUT");
  expect(readFileSync(result.checks[0].logPath, "utf8")).toBe("REAL_CHECK_OUTPUT\n");
  expect(result.checks[0].logPath.startsWith(live)).toBe(false);
  expect(JSON.stringify(result)).not.toContain(marker);
  expect(readFileSync(secret, "utf8")).toBe(marker);
  expect(readdirSync(host)).toEqual(["marker.txt"]);
  expect(lstatSync(outputRoot).isSymbolicLink()).toBe(true);
 } finally { rmSync(root, {recursive: true, force: true}); }
}, 30_000);

test("a check rewritten after it was hashed still runs, and is recorded as, the hashed bytes", async () => {
 const root = mkdtempSync(join(tmpdir(), "check-rewrite-"));
 const live = join(root, "live", "solutions"), frozen = join(root, "snapshot", "solutions");
 try {
  ensureSolutionsRepository(live);
  writeFileSync(join(live, "model.py"), "value = False\n");
  git(live, ["add", "-A"]); git(live, ["commit", "-qm", "measured defect"]);
  const source = resolveCommit(live, "HEAD")!;
  addWorktree(live, frozen, source.commit);
  mkdirSync(join(live, "checks"));
  const check = join(live, "checks", "test_model.py");
  const original = "from solutions.model import value\nassert value, 'defect still present'\n";
  writeFileSync(check, original);
  // Another writer (a parallel validation scout or the lead) replaces the check with a
  // trivially passing one after the harness read it and before the interpreter starts.
  const swap = `printf 'print("swapped")\\n' > ${JSON.stringify(check)}; exec "$@"`;
  const result = await runTrialChecks({ experimentId: "rewrite", commit: source.commit, tree: source.tree, sourceRoot: dirname(frozen) }, [check],
   { executable: "env", bwrap: "env", scratchRoot: "/nonexistent-scratch", cwd: live, mounts: [{ source: dirname(frozen) }], env: { ...process.env } as Record<string, string>,
    args: command => ["sh", "-c", swap, "sh", ...command] });
  expect(readFileSync(check, "utf8")).toContain("swapped");
  expect(result.passed).toBe(false);
  expect(result.checks[0].output).toContain("defect still present");
  expect(result.checks[0].sha256).toBe(new Bun.CryptoHasher("sha256").update(original).digest("hex"));
 } finally { rmSync(root, { recursive: true, force: true }); }
});
