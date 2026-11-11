/** Controller-only retained data. Legacy solve uses this same split implementation. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../pipeline/resolve_task.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";
import { statePath } from "../paths.js";
import { prepareSolveWorkspace, type PrepareOptions, type SolveWorkspace } from "./workspace.js";

export interface TaskData extends SolveWorkspace { materializedHashes: Record<string, string>; taskId: string; profilePath: string; datasetSha256: string; developmentArchive: string; developmentManifest: string; testArchive: string; originalTrainingPath: string }
export function prepareTaskData(taskId: string, configuration: TaskConfiguration, options: PrepareOptions & { signal?: AbortSignal } = {}): TaskData {
 options.signal?.throwIfAborted();
 return prepareSolveWorkspace(taskId, { ...options, configuration }) as TaskData;
}
export function readTaskData(taskId: string, projectRoot = PROJECT_ROOT): TaskData | undefined {
 const root = statePath(projectRoot, taskId, "data", "sealed");
 if (!existsSync(join(root, "split.json"))) return undefined;
 try {
  const data = JSON.parse(readFileSync(join(root, "task-data.json"), "utf8"));
  if (!data.split || !existsSync(data.sampleManifestPath) || !existsSync(data.devZip)) throw new Error("incomplete");
  return data;
 } catch { throw new Error("Corrupt or incomplete task data; resume prepareTaskData with the original declaration"); }
}
export function prepareModellingWorkspace(data: TaskData, configuration: TaskConfiguration): SolveWorkspace {
 if (JSON.stringify(data.configuration) !== JSON.stringify(configuration)) throw new Error("Task configuration differs from prepared data");
 if (!existsSync(data.devZip) || !existsSync(data.sampleManifestPath)) throw new Error("Missing retained inputs; resume task data preparation");
 return data;
}
