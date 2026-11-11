/** One task-data sandbox policy, parameterized by expert role. */
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TaskData } from "../solve/task_data.js";
import type { TrialSnapshot } from "../training/trial_source.js";
import { resolveCommit, uncommittedFiles } from "../training/git.js";
import type { PythonEnvironment } from "./python_environment.js";
import { prepareSolveSandbox, sandboxPolicy, type SolveSandbox } from "./solve_sandbox.js";
export function expertSandbox(data: TaskData, role: "lead" | "data" | "ideas" | "validation", python: PythonEnvironment, trial?: TrialSnapshot): SolveSandbox {
 if (!["lead", "data", "ideas", "validation"].includes(role)) throw new Error("Invalid expert role");
 if (role === "validation" && !trial) throw new Error("Validation requires a measured trial snapshot");
 const base = prepareSolveSandbox(data, python);
 const mounts = base.mounts.map(mount => ({ ...mount, ...(realpathSync(mount.source) === realpathSync(data.solutionsRoot) && role === "ideas" ? { writable: false } : {}) }));
 if (existsSync(data.profilePath)) mounts.push({ source: data.profilePath });
 const env = { ...base.env };
 if (trial) {
  const source = resolve(trial.sourceRoot), repository = join(source, "solutions");
  const identity = resolveCommit(repository, "HEAD");
  if (!identity || identity.commit !== trial.commit || identity.tree !== trial.tree || uncommittedFiles(repository).length) throw new Error("Invalid expert trial snapshot");
  mounts.push({ source });
  env.VALIDATION_SOURCE_ROOT = source; env.VALIDATION_EXPERIMENT_ID = trial.experimentId;
 }
 return sandboxPolicy({ mounts, cwd: base.cwd, env, bwrap: base.executable });
}
export type { SolveSandbox } from "./solve_sandbox.js";
