/** Test-only sandbox: a writable workspace and a read-only task folder, with bash, the tools and the project Python. */
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { ARM_ROOT, REPO_ROOT } from "../paths.js";
import type { PythonEnvironment } from "./python_environment.js";
import { executable, sandboxPolicy, type SandboxMount, type SolveSandbox } from "./solve_sandbox.js";

export function workspaceTestSandbox(workspace: string, taskDir: string, python: PythonEnvironment): SolveSandbox {
 const binaries = ["bash", "git", "rg", "fd", "uv"].map(executable);
 const mounts: SandboxMount[] = [
  { source: workspace, writable: true }, { source: taskDir },
  { source: python.prefix }, { source: dirname(dirname(dirname(realpathSync(python.executable)))) },
  { source: join(ARM_ROOT, "agent/run/solve_tool_worker.ts") },
  { source: join(REPO_ROOT, "node_modules") }, { source: realpathSync(join(REPO_ROOT, "node_modules")) },
  { source: dirname(realpathSync(process.execPath)) },
  ...binaries.map(path => ({ source: dirname(path) })),
  ...["pyproject.toml", "uv.lock"].map(path => ({ source: join(ARM_ROOT, path) })).filter(mount => existsSync(mount.source)),
 ];
 const env: Record<string, string> = { PATH: [join(python.prefix, "bin"), ...binaries.map(dirname), "/run/current-system/sw/bin", "/usr/bin", "/bin"].join(delimiter),
  VIRTUAL_ENV: python.prefix, UV_PYTHON: python.executable, UV_PYTHON_DOWNLOADS: "never", PYTHONNOUSERSITE: "1" };
 for (const name of ["NIX_LD", "NIX_LD_LIBRARY_PATH", "LD_LIBRARY_PATH"]) if (process.env[name]) env[name] = process.env[name]!;
 return sandboxPolicy({ mounts, cwd: workspace, env });
}
