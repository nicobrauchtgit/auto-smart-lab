/** Execute live check code against immutable trial imports in a fresh interpreter. */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, realpathSync, readFileSync } from "node:fs";
import { join, resolve, sep, basename } from "node:path";
import { projectPython } from "../pipeline/task_configuration.js";
import type { SolveSandbox } from "../run/solve_sandbox.js";
import { resolveCommit, uncommittedFiles } from "./git.js";
import type { TrialSnapshot } from "../team/contracts.js";

const runner = `import os,sys
from pathlib import Path
source=Path(sys.argv[2]).resolve()
check=Path(sys.argv[1]).resolve()
sys.path[:]=[str(source)]+[p for p in sys.path if p and 'solutions' not in Path(p).parts]
os.environ['VALIDATION_SOURCE_ROOT']=str(source)
os.environ['VALIDATION_EXPERIMENT_ID']=sys.argv[3]
os.environ['PYTHONPATH']=str(source)
try:
 exec(compile(check.read_bytes(),str(check),'exec'),{'__name__':'__main__','__file__':str(check)})
finally:
 for module in list(sys.modules.values()):
  path=getattr(module,'__file__',None)
  if path and 'solutions' in Path(path).parts and not Path(path).resolve().is_relative_to(source):
   raise RuntimeError('Unsafe live solutions import: '+path)
`;
/** Grace after SIGTERM before the check's process group is killed, and again before its output pipes are abandoned. */
export const CHECK_CANCEL_GRACE_MS = 2000;

export async function runTrialChecks(snapshot: TrialSnapshot, checkPaths: string[], sandbox: SolveSandbox, signal?: AbortSignal,
 options: { cancelGraceMs?: number } = {}): Promise<{ passed: boolean; checks: { path: string; exitCode: number; outputPath: string }[] }> {
 const grace = options.cancelGraceMs ?? CHECK_CANCEL_GRACE_MS;
 const source = realpathSync(snapshot.sourceRoot), worktree = join(source, "solutions");
 const identity = resolveCommit(worktree, "HEAD");
 if (!identity || identity.commit !== snapshot.commit || identity.tree !== snapshot.tree || uncommittedFiles(worktree).length) throw new Error("Trial snapshot identity mismatch");
 const inside = (path: string, root: string) => path === root || path.startsWith(`${root}${sep}`);
 if (!sandbox.mounts.some(m => !m.writable && inside(source, realpathSync(m.source))) || sandbox.mounts.some(m => m.writable && (inside(source, realpathSync(m.source)) || inside(realpathSync(m.source), source)))) throw new Error("Trial checks require read-only snapshot mounts");
 const checks = [];
 const live = sandbox.mounts.find(mount => basename(mount.source) === "solutions" && realpathSync(mount.source) !== realpathSync(worktree))?.source ?? sandbox.cwd;
 const outputRoot = join(live, "scratch", "validation", snapshot.experimentId);
 mkdirSync(outputRoot, { recursive: true });
 for (const [index, path] of checkPaths.entries()) {
  signal?.throwIfAborted();
  const checked = realpathSync(path);
  if (!inside(checked, resolve(live, "checks")) || !checked.endsWith(".py")) throw new Error("Unsafe check path");
  const outputPath = join(outputRoot, `${index}.log`);
  const output = createWriteStream(outputPath);
  const exitCode = await new Promise<number>((done, reject) => {
   const command = [projectPython(), "-I", "-c", runner, checked, source, snapshot.experimentId];
   const child = spawn(sandbox.executable, sandbox.args(command), { cwd: sandbox.cwd, env: sandbox.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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
    output.end(() => error !== undefined ? reject(error) : signal?.aborted ? reject(signal.reason) : done(code ?? 1));
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
  if (readFileSync(outputPath, "utf8").includes("Unsafe live solutions import:")) throw new Error("Unsafe live solutions import origin; see the retained check log");
  checks.push({ path: checked, exitCode, outputPath });
 }
 return { passed: checks.every(check => check.exitCode === 0), checks };
}
