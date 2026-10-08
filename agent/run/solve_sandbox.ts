/** Filesystem boundary for agent file/shell tools, not for trusted harness workers. */
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
 createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
 createBashToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
 defineTool, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { liveGroup } from "../experiments/ownership.js";
import { sanitizeTrainingEnvironment } from "../training/environment.js";
import type { SolveWorkspace } from "../solve/workspace.js";
import type { PythonEnvironment } from "./python_environment.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER = join(ROOT, "agent/run/solve_tool_worker.ts");
const factories = { read: createReadToolDefinition, write: createWriteToolDefinition, edit: createEditToolDefinition,
 bash: createBashToolDefinition, grep: createGrepToolDefinition, find: createFindToolDefinition, ls: createLsToolDefinition };
export const SOLVE_FILE_TOOLS = Object.keys(factories);
type ToolResult = Awaited<ReturnType<ToolDefinition["execute"]>>;
export interface SandboxMount { source: string; writable?: boolean }
export interface SolveSandbox { executable: string; cwd: string; mounts: SandboxMount[]; env: Record<string, string>; args(command: string[]): string[] }

function executable(name: string): string {
 for (const directory of (process.env.PATH ?? "").split(delimiter)) {
  const path = join(directory, name);
  try { accessSync(path, constants.X_OK); return realpathSync(path); } catch {}
 }
 throw new Error(`Missing sandbox executable: ${name}`);
}

export function findBubblewrap(override?: string): string {
 if (process.platform !== "linux") throw new Error("Solve filesystem isolation requires Linux bubblewrap");
 const configured = override ?? process.env.SOLVE_BWRAP;
 if (configured) { accessSync(configured, constants.X_OK); return realpathSync(configured); }
 try { return executable("bwrap"); } catch {}
 // NixOS already provides bubblewrap with user namespaces on some hosts,
 // without putting it on the shell PATH. No installation or host edits.
 if (existsSync("/nix/store")) for (const name of readdirSync("/nix/store").filter(name => name.includes("-bubblewrap-"))) {
  const path = join("/nix/store", name, "bin/bwrap");
  try { accessSync(path, constants.X_OK); return path; } catch {}
 }
 throw new Error("Install bubblewrap through the host administrator or set SOLVE_BWRAP to an existing executable");
}

export function sandboxPolicy(options: { mounts: SandboxMount[]; cwd: string; env?: Record<string, string>; bwrap?: string }): SolveSandbox {
 const bwrap = findBubblewrap(options.bwrap);
 const mounts = [...options.mounts];
 // System runtime only. Never mount /, /home, /etc, host /proc or host /tmp.
 for (const source of ["/usr", "/bin", "/lib", "/lib64", "/nix/store", "/run/current-system/sw",
  "/etc/resolv.conf", "/etc/hosts", "/etc/ssl/certs"]) if (existsSync(source)) mounts.push({ source });
 const unique = [...new Map(mounts.map(mount => [resolve(mount.source), { ...mount, source: resolve(mount.source) }])).values()];
 const env = { HOME: "/tmp/home", TMPDIR: "/tmp", LANG: "C.UTF-8", ...options.env };
 return { executable: bwrap, cwd: options.cwd, mounts: unique, env, args(command) {
  const args = ["--unshare-all", "--share-net", "--die-with-parent", "--cap-drop", "ALL",
   "--clearenv", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/home"];
  for (const mount of unique) args.push(mount.writable ? "--bind" : "--ro-bind", mount.source, mount.source);
  for (const [key, value] of Object.entries(env)) args.push("--setenv", key, value);
  args.push("--chdir", options.cwd, "--", ...command);
  return args;
 } };
}

export function checkSolveSandbox(bwrap?: string): void {
 const shell = executable("bash");
 const policy = sandboxPolicy({ cwd: "/tmp", mounts: [{ source: dirname(shell) }], bwrap });
 const result = spawnSync(policy.executable, policy.args([shell, "-c", "test ! -e /home && test ! -e /proc/1/root/home"]),
  { timeout: 5_000, stdio: "ignore" });
 if (result.error || result.status !== 0) throw new Error("Bubblewrap mount/user/PID isolation is unavailable");
 for (const name of ["git", "rg", "fd", "uv"]) executable(name);
 accessSync(WORKER, constants.R_OK);
}

export function prepareSolveSandbox(workspace: SolveWorkspace, python: PythonEnvironment): SolveSandbox & { agentRoot: string } {
 const agentRoot = join(workspace.root, "agent");
 mkdirSync(agentRoot, { recursive: true });
 const binaries = ["bash", "git", "rg", "fd", "uv"].map(executable);
 const runtimePython = dirname(dirname(realpathSync(python.executable)));
 const mounts: SandboxMount[] = [
  { source: agentRoot, writable: true }, { source: workspace.solutionsRoot, writable: true },
  ...[workspace.devZip, workspace.testZip, workspace.sampleManifestPath, workspace.taskPath, workspace.researchDir]
   .filter(existsSync).map(source => ({ source })),
  { source: python.prefix }, { source: dirname(runtimePython) }, { source: WORKER },
  ...[join(dirname(python.prefix), "libs/smartlab-eval")].filter(existsSync).map(source => ({ source })),
  { source: join(ROOT, "node_modules") }, { source: realpathSync(join(ROOT, "node_modules")) },
  { source: dirname(realpathSync(process.execPath)) },
  ...binaries.map(path => ({ source: dirname(path) })),
  ...["pyproject.toml", "uv.lock", "agent/runtime/python/NOTES.md", "agent/setup/python_environment.py",
   "libs/smartlab-eval"].map(path => ({ source: join(ROOT, path) })).filter(mount => existsSync(mount.source)),
 ];
 const notes = join(ROOT, "agent/runtime/python/NOTES.md");
 if (existsSync(notes)) mounts.push({ source: notes, writable: true });
 const env: Record<string, string> = { PATH: [join(python.prefix, "bin"), ...binaries.map(dirname), "/usr/bin", "/bin"].join(delimiter),
  VENV_DIR: python.prefix, VIRTUAL_ENV: python.prefix, UV_PROJECT_ENVIRONMENT: python.prefix,
  UV_PYTHON: python.executable, UV_PYTHON_DOWNLOADS: "never", PYTHONNOUSERSITE: "1", SOLVE_WORKSPACE: agentRoot };
 for (const name of ["NIX_LD", "NIX_LD_LIBRARY_PATH", "LD_LIBRARY_PATH"]) if (process.env[name]) env[name] = process.env[name]!;
 const policy = sandboxPolicy({ mounts, cwd: dirname(workspace.solutionsRoot), env });
 return { ...policy, agentRoot };
}

function persistentWrite(policy: SolveSandbox, value: unknown): boolean {
 if (typeof value !== "string") return false;
 const path = resolve(policy.cwd, value);
 let parent = path;
 while (!existsSync(parent)) { const next = dirname(parent); if (next === parent) return false; parent = next; }
 const canonical = resolve(realpathSync(parent), relative(parent, path));
 return policy.mounts.filter(mount => mount.writable).some(mount => {
  const root = realpathSync(mount.source), delta = relative(root, canonical);
  return delta === "" || (statSync(root).isDirectory() && delta !== ".." && !delta.startsWith(`..${sep}`) && !delta.startsWith(sep));
 });
}

/** Every SDK filesystem tool runs in a fresh restricted mount/PID namespace. */
export function isolatedSolveTools(policy: SolveSandbox): ToolDefinition[] {
 return Object.entries(factories).map(([name, factory]) => ({ ...factory(policy.cwd), async execute(id, params, signal, onUpdate) {
  signal?.throwIfAborted();
  if (["write", "edit"].includes(name) && !persistentWrite(policy, (params as any).path)) throw new Error("Write outside the persistent solve workspace is unavailable");
  return await new Promise<ToolResult>((accept, reject) => {
   const child = spawn(policy.executable, policy.args([realpathSync(process.execPath), WORKER]), { stdio: ["pipe", "pipe", "pipe"] });
   let buffer = "", result: any, failure: string | undefined, stderr = "";
   child.stdout.on("data", bytes => {
    buffer += bytes.toString();
    while (buffer.includes("\n")) {
     const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
     try {
      const message = JSON.parse(line);
      if (message.update) onUpdate?.(message.update);
      if (message.result) result = message.result;
      if (message.error) failure = message.error;
     } catch { failure = "Invalid isolated tool response"; }
    }
   });
   child.stderr.on("data", bytes => { if (stderr.length < 4096) stderr += bytes.toString(); });
   const abort = () => child.kill("SIGKILL");
   signal?.addEventListener("abort", abort, { once: true });
   child.on("error", reject);
   child.on("close", code => {
    signal?.removeEventListener("abort", abort);
    if (signal?.aborted) reject(new Error("Tool cancelled"));
    else if (failure || code !== 0 || !result) reject(new Error(failure ?? `Isolated tool failed (${code}): ${stderr}`));
    else accept(result);
   });
   child.stdin.end(JSON.stringify({ name, id, params, cwd: policy.cwd }));
  });
 } }));
}

/** Trusted narrow service: dependency management stays outside filesystem tools. */
export interface PythonManagerIdentity { pipelineRunId?: string; stageInvocationId?: string; attempt?: number; sessionId?: string }
export function pythonManagerEnvironment(python: PythonEnvironment, managerRoot: string, identity: PythonManagerIdentity = {}): Record<string, string> {
 return { ...sanitizeTrainingEnvironment(process.env, identity), VENV_DIR: python.prefix,
  UV_CACHE_DIR: join(managerRoot, ".tools/uv/cache"), UV_PYTHON_INSTALL_DIR: join(managerRoot, ".tools/uv/python"),
  ...(identity.attempt === undefined ? {} : { PIPELINE_AGENT_ATTEMPT: String(identity.attempt) }),
  ...((identity.sessionId ?? process.env.PIPELINE_PYTHON_SESSION_ID) ? { PIPELINE_PYTHON_SESSION_ID: identity.sessionId ?? process.env.PIPELINE_PYTHON_SESSION_ID! } : {}) };
}
export function solvePythonEnvironmentTool(python: PythonEnvironment, description: string, managerRoot = ROOT, identity: PythonManagerIdentity = {}): ToolDefinition {
 return defineTool({ name: "python_environment", label: "Shared Python environment", description,
  parameters: Type.Object({ operation: Type.Union([Type.Literal("inspect"), Type.Literal("add"), Type.Literal("update")]),
   package: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), reason: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })) }),
  async execute(_id, args, signal) {
   signal?.throwIfAborted();
   if (!["inspect", "add", "update"].includes(args.operation)) throw new Error("Unknown environment operation");
   if (args.operation !== "inspect" && (!args.package || !args.reason)) throw new Error("A package and reason are required");
   if (args.operation === "inspect" && (args.package || args.reason)) throw new Error("inspect takes no package or reason");
   // The manager applies its own strict named-PyPI requirement parser before
   // running uv; arguments are never interpolated into a shell.
   const argv = ["-I", join(managerRoot, "agent/setup/python_environment.py"), args.operation,
    ...(args.operation === "inspect" ? ["--json"] : [args.package!, "--reason", args.reason!])];
   return await new Promise<ToolResult>((accept, reject) => {
    const child = spawn(python.executable, argv, { cwd: managerRoot, env: pythonManagerEnvironment(python, managerRoot, identity), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (bytes: Buffer) => { output = (output + bytes.toString()).slice(0, 128 * 1024); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    let cancelled = false;
    const stop = (signal: NodeJS.Signals) => { if (child.pid) try { process.kill(-child.pid, signal); } catch {} };
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { cancelled = true; stop("SIGTERM"); forceTimer ??= setTimeout(() => stop("SIGKILL"), 1000); };
    const timer = setTimeout(abort, 15 * 60_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", error => { clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); signal?.removeEventListener("abort", abort); reject(error); }); child.on("close", async code => {
     signal?.removeEventListener("abort", abort); clearTimeout(timer);
     if (cancelled && child.pid) {
      stop("SIGKILL");
      const deadline = Date.now() + 3000;
      while (liveGroup(child.pid).length && Date.now() < deadline) await Bun.sleep(25);
      if (liveGroup(child.pid).length) { reject(new Error("Python manager process group could not be stopped")); return; }
     }
     if (forceTimer) clearTimeout(forceTimer);
     if (cancelled) reject(new Error("Python environment operation cancelled or timed out"));
     else accept({ content: [{ type: "text", text: output }], details: { exitCode: code } });
    });
   });
  } });
}


/** Agent-authored factories, splitters and fits have the same data boundary.
 * The trusted launch receipt writer stays outside; its child remains in the
 * same host process group (no --new-session), preserving group cancellation. */
export function trainingSandboxCommand(base: SolveSandbox, command: string[], input: { directory: string; sourceRoots: readonly string[] }): string[] {
 const mounts = base.mounts.map(mount => ({ ...mount, writable: false }));
 mounts.push({ source: join(ROOT, "agent/training/python") });
 mounts.push({ source: input.directory, writable: true });
 for (const source of input.sourceRoots) if (existsSync(source)) mounts.push({ source });
 const policy = sandboxPolicy({ mounts, cwd: base.cwd, env: { ...base.env, PYTHONUNBUFFERED: "1" }, bwrap: base.executable });
 return [policy.executable, ...policy.args(command)];
}
