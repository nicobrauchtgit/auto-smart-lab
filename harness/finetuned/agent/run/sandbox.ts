/** One task-data sandbox policy, parameterized by expert role. */
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { TaskData, TeamRole, TrialSnapshot } from "../team/contracts.js";
import { resolveCommit, uncommittedFiles } from "../training/git.js";
import type { PythonEnvironment } from "./python_environment.js";
import { prepareSolveSandbox, sandboxPolicy, type SolveSandbox } from "./solve_sandbox.js";
/** Per-task scout folder in the shared tree's ignored scratch space: staged task inputs and research/. */
export function scoutWorkspace(data: TaskData): string { return join(data.solutionsRoot, "scratch", "scouts", data.taskId); }
export function expertSandbox(data: TaskData, role: TeamRole, python: PythonEnvironment, trial?: TrialSnapshot): SolveSandbox {
 if (!["lead", "data", "ideas", "validation"].includes(role)) throw new Error("Invalid expert role");
 if (role === "validation" && !trial) throw new Error("Validation requires a measured trial snapshot");
 const base = prepareSolveSandbox(data, python);
 const mounts = base.mounts.map(mount => ({ ...mount, ...(realpathSync(mount.source) === realpathSync(data.solutionsRoot) && role === "ideas" ? { writable: false } : {}) }));
 if (existsSync(data.profilePath)) mounts.push({ source: data.profilePath });
 const env = { ...base.env };
 // Data and ideas scouts work in the task's scout folder; its research/ is writable for the data scout.
 const cwd = role === "data" || role === "ideas" ? scoutWorkspace(data) : base.cwd;
 if (cwd !== base.cwd) mkdirSync(join(cwd, "research"), { recursive: true });
 if (role === "data") mounts.push({ source: join(cwd, "research"), writable: true });
 if (trial) {
  const source = realpathSync(trial.sourceRoot), repository = join(source, "solutions");
  const identity = resolveCommit(repository, "HEAD");
  if (!identity || identity.commit !== trial.commit || identity.tree !== trial.tree || uncommittedFiles(repository).length) throw new Error("Invalid expert trial snapshot");
  mounts.push({ source });
  env.VALIDATION_SOURCE_ROOT = source; env.VALIDATION_EXPERIMENT_ID = trial.experimentId;
 }
 return sandboxPolicy({ mounts, cwd, env, bwrap: base.bwrap, scratchRoot: base.scratchRoot });
}
export type { SolveSandbox } from "./solve_sandbox.js";
