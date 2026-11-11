import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSolveWorkspace, archiveRows } from "./workspace.js";
import { readTaskData } from "./task_data.js";
import { resolveTask } from "../pipeline/resolve_task.js";
import { projectPython } from "../pipeline/task_configuration.js";
import { sealConfirmationSet } from "./folds.js";

test("spam1 keeps the original split, resumes missing materialization, rejects changed seed", () => {
 const root = mkdtempSync(join(tmpdir(), "persistent-spam-"));
 try {
  const options = { configuration: JSON.parse(readFileSync("harness/finetuned/pipeline.config.json", "utf8")).pipeline.tasks.spam1, projectRoot: root, taskDir: resolveTask({ taskId: "spam1" }).taskDir };
  const first = prepareSolveWorkspace("spam1", options);
  const rows = archiveRows(projectPython(), first.trainZip, first.originalTargetsPath, "binary");
  const old = sealConfirmationSet(rows.ids.map((id, i) => ({ id, label: rows.targets![i] as 0 | 1 })), { seed: first.holdoutSeedPlan!.sealedSeed });
  expect(first.split.sealedIds).toEqual(old.sealedIds);
  const bytes = readFileSync(first.sampleManifestPath);
  rmSync(first.sampleManifestPath);
  expect(() => readTaskData("spam1", root)).toThrow("resume");
  const resumed = prepareSolveWorkspace("spam1", options);
  expect(resumed.split).toEqual(first.split);
  expect(readFileSync(resumed.sampleManifestPath)).toEqual(bytes);
  expect(() => prepareSolveWorkspace("spam1", { ...options, seed: 123 })).toThrow("rootSeed");
  const declaration = join(root, "runs", "finetuned", "spam1", "data", "sealed", "split.json");
  writeFileSync(declaration, "corrupt");
  expect(() => prepareSolveWorkspace("spam1", options)).toThrow("Corrupt task split");
  expect(readFileSync(declaration, "utf8")).toBe("corrupt");
 } finally { rmSync(root, { recursive: true, force: true }); }
}, 60000);
