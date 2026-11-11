/** Bounded static checks for the shared authored tree. */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { projectPython } from "../pipeline/task_configuration.js";
export interface WorkspaceCheck { valid: boolean; errors: string[]; warnings: string[]; measurements: Record<string, number>; changedPaths: string[] }
export async function checkWorkspace(root: string, taskId: string, changedPaths: string[] = []): Promise<WorkspaceCheck> {
 return new Promise((resolve, reject) => execFile(projectPython(), [join(import.meta.dir, "workspace_check.py"), root, taskId], { timeout: 2000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
  if (error) { reject(new Error("Workspace check failed or exceeded 2 seconds")); return; }
  try { resolve({ ...JSON.parse(stdout), changedPaths }); } catch (error) { reject(error); }
 }));
}
