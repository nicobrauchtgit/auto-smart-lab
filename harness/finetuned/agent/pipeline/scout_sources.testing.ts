/** Source-only unit fixtures for preflight tests; no fetched data or run preparation. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT, listTasks } from "./resolve_task.js";

export async function withScoutSourceFixtures(taskIds: string[], run: () => Promise<void>) {
 const missing = taskIds.filter(id => !listTasks().some(task => task.taskId === id));
 const root = missing.length ? mkdtempSync(join(PROJECT_ROOT, "units", "99-scout-source-test-")) : undefined;
 try {
  if (root) {
   writeFileSync(join(root, "unit-intro.md"), "Source-only preflight test unit introduction.\n");
   for (const taskId of missing) {
    const task = join(root, taskId);
    mkdirSync(task);
    writeFileSync(join(task, "meta.json"), JSON.stringify({ short_id: taskId, data_files: [] }));
    writeFileSync(join(task, "prompt.md"), "Source-only preflight test task.\n");
   }
  }
  await run();
 } finally { if (root) rmSync(root, { recursive: true, force: true }); }
}
