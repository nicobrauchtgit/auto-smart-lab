/** Bounded static checks for the shared authored tree. */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { realpathSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { projectPython } from "../pipeline/task_configuration.js";
export interface WorkspaceCheck { valid: boolean; errors: string[]; warnings: string[]; measurements: Record<string, number>; changedPaths: string[] }
export async function checkWorkspace(root: string, taskId: string, changedPaths: string[] = []): Promise<WorkspaceCheck> {
 root = realpathSync(root);
 if (!statSync(root).isDirectory()) throw new Error("Workspace root must be a directory");
 return new Promise((resolve, reject) => execFile(projectPython(), [join(import.meta.dir, "workspace_check.py"), root, taskId], { timeout: 2000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
  if (error) { reject(new Error("Workspace check failed or exceeded 2 seconds")); return; }
  try { resolve({ ...JSON.parse(stdout), changedPaths }); } catch (error) { reject(error); }
 }));
}

export function workspaceCheckTool(root: string, taskId: string, prompts: import("../prompts/loader.js").PromptSnapshot) {
 return defineTool({ name: "workspace_check", label: "Check shared workspace", description: prompts.render("training.workspace-check-tool", {}).text,
  parameters: Type.Object({}), async execute() { return { content: [{ type: "text" as const, text: JSON.stringify(await checkWorkspace(root, taskId)) }], details: {} }; } });
}
