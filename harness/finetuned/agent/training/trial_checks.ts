/** Execute live check code (read once, hashed, piped in) against immutable trial imports in a fresh interpreter. */
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { closeSync, createWriteStream, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, sep, basename } from "node:path";
import { assertHarnessOwnedRoot } from "../run/agent_shell.js";
import { projectPython } from "../pipeline/task_configuration.js";
import type { SolveSandbox } from "../run/solve_sandbox.js";
import { resolveCommit, uncommittedFiles } from "./git.js";
import type { TrialSnapshot } from "../team/contracts.js";
import { openLog, writeCopy } from "../experiments/safe_files.js";

const runner = `import os,sys
from pathlib import Path
source=Path(sys.argv[2]).resolve()
check=Path(sys.argv[1]).resolve()
code=sys.stdin.buffer.read()
sys.path[:]=[str(source)]+[p for p in sys.path if p and 'solutions' not in Path(p).parts]
os.environ['VALIDATION_SOURCE_ROOT']=str(source)
os.environ['VALIDATION_EXPERIMENT_ID']=sys.argv[3]
os.environ['PYTHONPATH']=str(source)
try:
 exec(compile(code,str(check),'exec'),{'__name__':'__main__','__file__':str(check)})
finally:
 for module in list(sys.modules.values()):
  path=getattr(module,'__file__',None)
  if path and 'solutions' in Path(path).parts and not Path(path).resolve().is_relative_to(source):
   raise RuntimeError('Unsafe live solutions import: '+path)
`;
const UNSAFE_IMPORT = "Unsafe live solutions import:";
/** Bytes of a check's output kept in memory for its result. */
const KEPT_OUTPUT_BYTES = 64 * 1024;

/**
 * A check's output as it arrives through its pipes: the end, and whether the
 * unsafe-import marker appeared anywhere. The harness answers from this, never
 * by reading the retained log back: the authoritative log stays outside writable mounts; scratch receives only a copy.
 */
class CheckOutput {
 private kept = Buffer.alloc(0);
 private carry = "";
 unsafe = false;
 add(chunk: Buffer): void {
  const text = this.carry + chunk.toString("latin1");
  if (text.includes(UNSAFE_IMPORT)) this.unsafe = true;
  this.carry = text.slice(-(UNSAFE_IMPORT.length - 1));
  this.kept = Buffer.concat([this.kept, chunk]);
  if (this.kept.length > KEPT_OUTPUT_BYTES) this.kept = this.kept.subarray(this.kept.length - KEPT_OUTPUT_BYTES);
 }
 text(): string { return this.kept.toString("utf8"); }
}

/** Grace after SIGTERM before the check's process group is killed, and again before its output pipes are abandoned. */
export const CHECK_CANCEL_GRACE_MS = 2000;

export async function runTrialChecks(snapshot: TrialSnapshot, checkPaths: string[], sandbox: SolveSandbox, signal?: AbortSignal,
 options: { cancelGraceMs?: number } = {}): Promise<{ passed: boolean; checks: { path: string; sha256: string; exitCode: number; outputPath: string; logPath: string; output: string }[] }> {
 const grace = options.cancelGraceMs ?? CHECK_CANCEL_GRACE_MS;
 const source = realpathSync(snapshot.sourceRoot), worktree = join(source, "solutions");
 const identity = resolveCommit(worktree, "HEAD");
 if (!identity || identity.commit !== snapshot.commit || identity.tree !== snapshot.tree || uncommittedFiles(worktree).length) throw new Error("Trial snapshot identity mismatch");
 const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);
 if (!sandbox.mounts.some(m => !m.writable && inside(source, realpathSync(m.source))) || sandbox.mounts.some(m => m.writable && (inside(source, realpathSync(m.source)) || inside(realpathSync(m.source), source)))) throw new Error("Trial checks require read-only snapshot mounts");
 const checks = [];
 const live = sandbox.mounts.find(mount => basename(mount.source) === "solutions" && realpathSync(mount.source) !== realpathSync(worktree))?.source ?? sandbox.cwd;
 // Only a disposable copy is published here; writeCopy pins directories from the live root.
 const outputRoot = join(live, "scratch", "validation", snapshot.experimentId);
 const trustedRoot = assertHarnessOwnedRoot(mkdtempSync(join(tmpdir(), "trial-check-logs-")), sandbox);
 for (const [index, path] of checkPaths.entries()) {
  signal?.throwIfAborted();
  const checked = realpathSync(path);
  if (!inside(checked, resolve(live, "checks")) || !checked.endsWith(".py")) throw new Error("Unsafe check path");
  // Read once: these exact bytes are hashed and piped to the runner, so a concurrent
  // rewrite of the live file cannot change what ran under this hash.
  const code = readFileSync(checked), sha256 = createHash("sha256").update(code).digest("hex");
  const outputPath = join(outputRoot, `${index}.log`);
  const logPath = join(trustedRoot, `${index}.log`);
  const logFd = openLog(logPath);
  const output = createWriteStream("", { fd: logFd, autoClose: false });
  const captured = new CheckOutput();
  const exitCode = await new Promise<number>((done, reject) => {
   const command = [projectPython(), "-I", "-c", runner, checked, source, snapshot.experimentId];
   const child = spawn(sandbox.executable, sandbox.args(command), { cwd: sandbox.cwd, env: sandbox.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
   child.stdin.on("error", () => { /* A check that exits before reading fails on its own. */ });
   child.stdin.end(code);
   child.stdout.on("data", (chunk: Buffer) => captured.add(chunk)); child.stderr.on("data", (chunk: Buffer) => captured.add(chunk));
   child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
   const timers: ReturnType<typeof setTimeout>[] = [];
   let settled = false, cancelling = false;
   const settle = (error?: unknown, code?: number | null) => {
    if (settled) return;
    settled = true;
    // A cancelled check's leader may exit while a descendant that ignores
    // SIGTERM survives: kill the whole group before the escalation timer goes.
    if (cancelling) group("SIGKILL");
    for (const timer of timers) clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
    output.end(() => {
     try { writeCopy(live, outputRoot, `${index}.log`, logFd); } catch { /* Untrusted copy destination refused; result uses captured pipes. */ }
     finally { closeSync(logFd); }
     if (error !== undefined) reject(error); else if (signal?.aborted) reject(signal.reason); else done(code ?? 1);
    });
   };
   const group = (name: NodeJS.Signals) => { try { process.kill(-child.pid!, name); } catch {} };
   // A check may handle SIGTERM, or leave a descendant that ignores it:
   // escalate to SIGKILL on the whole group, then stop waiting for pipes a
   // process outside the group may still hold open.
   function cancel() {
    cancelling = true;
    group("SIGTERM");
    timers.push(setTimeout(() => {
     group("SIGKILL");
     timers.push(setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); settle(signal?.reason ?? new Error("Check cancelled")); }, grace));
    }, grace));
   }
   signal?.addEventListener("abort", cancel, { once: true });
   if (signal?.aborted) cancel();
   child.once("error", error => settle(error));
   child.once("close", code => settle(undefined, code));
  });
  if (captured.unsafe) throw new Error("Unsafe live solutions import origin; see the retained check log");
  checks.push({ path: checked, sha256, exitCode, outputPath, logPath, output: captured.text() });
 }
 return { passed: checks.every(check => check.exitCode === 0), checks };
}
