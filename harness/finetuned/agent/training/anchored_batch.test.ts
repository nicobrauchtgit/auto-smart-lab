import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAnchoredTestArchive } from "../pipeline/setup.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { compactDiagnostics } from "./service.js";
import { recommendFolds } from "../solve/folds.js";

test("anchored preflight refuses a missing test archive", () => {
 const root = mkdtempSync(join(tmpdir(), "anchor-preflight-"));
 try {
  const path = join(root, "test.zip");
  expect(() => checkAnchoredTestArchive(path)).toThrow("requires a readable test archive");
  writeFileSync(path, "fixture");
  expect(() => checkAnchoredTestArchive(path)).not.toThrow();
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("clustering prompt uses the new fold shape and smoke renders test-only structure", () => {
 const prompts = loadPromptSnapshot();
 const contract = prompts.render("team.lead-task-clustering", { taskId: "fixture", execution: "batch", splitGuidance: "" }).text;
 const shape = recommendFolds(800, { sealedRows: 200 });
 const text = prompts.render("team.lead-start", { task: "fixture", workspace: "fixture", datasetPaths: "fixture", targets: "fixture", rowCount: "800", targetSummary: "fixture", foldRecommendation: `${shape.folds}-fold ${shape.scheme}`, taskContract: contract, resources: "", followUp: "", resume: "", guidance: "" }).text;
 expect(text).toContain("4-fold"); expect(text).not.toContain("10-fold");
 expect(text).toContain("all test inputs");
 expect(prompts.render("training.smoke-test-part", { structure: "77 clusters, singleton fraction 0.2, largest share 0.4" }).text).toContain("test part: 77 clusters");
});

test("compact feedback preserves the exact testAgreement and testPart contracts", () => {
 const testAgreement = { available: true, meanAdjustedRandIndex: 0.7, minAdjustedRandIndex: 0.6, comparisons: 2 };
 const testPart = { rows: 1000, clusterCount: 77, singletonFraction: 0.2 };
 const compact = compactDiagnostics({ diagnostics: { kind: "clustering", testAgreement, folds: [{ diagnostics: { testPart } }] } }) as any;
 expect(compact.testAgreement).toEqual(testAgreement);
 expect(compact.folds[0].diagnostics.testPart).toEqual(testPart);
});
