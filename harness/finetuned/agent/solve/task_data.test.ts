import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { prepareSolveWorkspace, archiveRows, archiveMembers, splitDeclaration } from "./workspace.js";
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
  const savedDeclaration = readFileSync(declaration);
  const legacyRoot = join(first.root, "data"); mkdirSync(legacyRoot, { recursive: true });
  const legacy = { ...first.split, holdoutSeedPlan: first.holdoutSeedPlan };
  writeFileSync(join(legacyRoot, "holdout.json"), JSON.stringify(legacy));
  rmSync(declaration);
  expect(prepareSolveWorkspace("spam1", options).split).toEqual(first.split);
  rmSync(declaration);
  writeFileSync(join(legacyRoot, "holdout.json"), JSON.stringify({ ...legacy, holdoutSeedPlan: { ...first.holdoutSeedPlan, rootSeed: 123 } }));
  expect(() => prepareSolveWorkspace("spam1", options)).toThrow("Legacy exposed task data");
  writeFileSync(declaration, savedDeclaration);
  writeFileSync(declaration, "corrupt");
  expect(() => prepareSolveWorkspace("spam1", options)).toThrow("Corrupt task split");
  expect(readFileSync(declaration, "utf8")).toBe("corrupt");
 } finally { rmSync(root, { recursive: true, force: true }); }
}, 60000);

test("only holdout, targets, seed and archive identity change the split declaration", () => {
 const base = JSON.parse(readFileSync("harness/finetuned/pipeline.config.json", "utf8")).pipeline.tasks.spam1;
 const declare = (configuration: any, seed?: number) => splitDeclaration("spam1", configuration, "a".repeat(64), ["b", "a"], { seed });
 const reference = JSON.stringify(declare(base));
 // Metric, refit, submission, execution, selection and anomaly edits reuse the split.
 for (const edit of [{ metric: "none" }, { refit: "fit_predict_test_batch" }, { execution: "batch" }, { submission: { format: "id_semicolon_prediction", predictions: "cluster_id" } },
  { selection: { basis: "evidence", metric: "evidence_roc_auc", direction: "maximize", population: "development" } }, { anomaly: { scoreMethod: "score_samples", scoreDirection: "higher_is_anomalous", anomalyLabel: 1 } }])
  expect(JSON.stringify(declare({ ...base, ...edit }))).toBe(reference);
 expect(JSON.stringify(declare({ ...base, holdout: "none" }))).not.toBe(reference);
 expect(JSON.stringify(declare({ ...base, targets: { kind: "none" } }))).not.toBe(reference);
 expect(JSON.stringify(declare({ ...base, samples: { ...base.samples, source: "pcap_tcp_connections" } }))).not.toBe(reference);
 expect(JSON.stringify(declare(base, 99))).not.toBe(reference);
 expect(JSON.stringify(splitDeclaration("spam1", base, "a".repeat(64), ["a", "c"], {}))).not.toBe(reference);
});

test("a stale development archive holding now-sealed rows is rebuilt, never exposed", () => {
 const root = mkdtempSync(join(tmpdir(), "stale-dev-zip-"));
 try {
  const options = { configuration: JSON.parse(readFileSync("harness/finetuned/pipeline.config.json", "utf8")).pipeline.tasks.spam1, projectRoot: root, taskDir: resolveTask({ taskId: "spam1" }).taskDir };
  const first = prepareSolveWorkspace("spam1", options);
  // Explicit reset: the harness-only state goes, a full-membership archive remains.
  rmSync(join(root, "runs/finetuned/spam1/data/sealed"), { recursive: true });
  copyFileSync(first.trainZip, first.devZip);
  const reset = prepareSolveWorkspace("spam1", { ...options, seed: 7 });
  expect(reset.split.sealedIds).not.toEqual(first.split.sealedIds);
  const members = archiveMembers(projectPython(), reset.devZip);
  const sealed = new Set(reset.split.sealedIds);
  expect(members.some(member => sealed.has(member))).toBe(false);
  expect(members.length).toBe(reset.rowCount);
  // The manifest follows the new split; reuse keeps it byte for byte.
  expect(JSON.parse(readFileSync(reset.sampleManifestPath, "utf8")).samples.some((row: any) => sealed.has(row.id))).toBe(false);
  const bytes = readFileSync(reset.sampleManifestPath);
  expect(readFileSync(prepareSolveWorkspace("spam1", { ...options, seed: 7 }).sampleManifestPath)).toEqual(bytes);
 } finally { rmSync(root, { recursive: true, force: true }); }
}, 120000);

test("pre-v2 development data stay at their measured paths and bytes", () => {
 const fresh = mkdtempSync(join(tmpdir(), "v2-layout-"));
 const root = mkdtempSync(join(tmpdir(), "legacy-layout-"));
 try {
  const options = { configuration: JSON.parse(readFileSync("harness/finetuned/pipeline.config.json", "utf8")).pipeline.tasks.spam1, taskDir: resolveTask({ taskId: "spam1" }).taskDir };
  const current = prepareSolveWorkspace("spam1", { ...options, projectRoot: fresh });
  // Emulate the pre-v2 layout: solve/data holds the split, archive and manifest
  // that measured trials and the champion recorded by absolute path and hash.
  const legacy = join(root, "runs/finetuned/spam1/solve/data");
  mkdirSync(legacy, { recursive: true });
  const legacyZip = join(legacy, basename(current.devZip));
  copyFileSync(current.devZip, legacyZip);
  writeFileSync(join(legacy, "holdout.json"), JSON.stringify({ ...current.split, holdoutSeedPlan: current.holdoutSeedPlan }));
  const manifest = readFileSync(current.sampleManifestPath, "utf8").replaceAll(JSON.stringify(current.devZip), JSON.stringify(legacyZip));
  writeFileSync(join(legacy, "development-samples.json"), manifest);
  const fingerprint = createHash("sha256").update(readFileSync(legacyZip)).update(manifest).digest("hex");
  const adopted = prepareSolveWorkspace("spam1", { ...options, projectRoot: root });
  expect(adopted.sampleManifestPath).toBe(join(legacy, "development-samples.json"));
  expect(adopted.devZip).toBe(legacyZip);
  expect(readFileSync(adopted.sampleManifestPath, "utf8")).toBe(manifest);
  expect((adopted as any).datasetSha256).toBe(fingerprint);
  expect(adopted.split).toEqual(current.split);
  // The choice is durable: later runs reuse the same location.
  expect(prepareSolveWorkspace("spam1", { ...options, projectRoot: root }).sampleManifestPath).toBe(adopted.sampleManifestPath);
  // A changed measured manifest is refused, never silently rewritten.
  writeFileSync(join(legacy, "development-samples.json"), manifest.replace("schemaVersion", "schemaVersion "));
  rmSync(join(root, "runs/finetuned/spam1/data/sealed/task-data.json"));
  expect(() => prepareSolveWorkspace("spam1", { ...options, projectRoot: root })).toThrow("differs from the stored split");
 } finally { rmSync(root, { recursive: true, force: true }); rmSync(fresh, { recursive: true, force: true }); }
}, 120000);
