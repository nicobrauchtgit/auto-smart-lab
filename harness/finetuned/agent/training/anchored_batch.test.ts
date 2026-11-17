import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkAnchoredTestArchive, setupChecks, SetupSession } from "../pipeline/setup.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { compactDiagnostics } from "./service.js";
import { taskContract } from "../prompts/lead.js";
import { HARNESS_CONFIG } from "../harness/config.js";
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
 const contract = taskContract(prompts,"fixture", configuration, "evidence").map(p=>p.text).join("\n");
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

const configuration: any = {kind:"clustering",execution:"batch",holdout:"stratified",metric:"adjusted_rand_index", samples:{source:"zip_members",train:"train.zip",test:"test.zip"}, targets:{kind:"families"}};
test("setupChecks prevents stage execution for missing anchored test archive", async () => {
 const root=mkdtempSync(join(tmpdir(),"anchor-setup-"));
 try {
  writeFileSync(join(root,"meta.json"),"{}"); writeFileSync(join(root,"prompt.md"),"fixture");
  let started=false;
  const checks=setupChecks(["task"], {taskId:"fixture",taskConfiguration:configuration,prompts:loadPromptSnapshot(),taskSource:{taskDir:root,testZip:join(root,"missing.zip")}});
  expect(() => checks[0]!.run(new AbortController().signal)).toThrow("requires a readable test archive");
  await expect(new SetupSession().check(checks,new AbortController().signal,()=>{}).then(()=>{started=true})).rejects.toThrow("Setup check failed");
  expect(started).toBe(false);
 } finally {rmSync(root,{recursive:true,force:true})}
});
test("fold recommendation is bounded and batch fragment is execution specific", () => {
 expect(recommendFolds(100000,{sealedRows:1}).folds).toBe(Math.max(...HARNESS_CONFIG.foldRecommendations.map(row=>row.folds)));
 const prompts=loadPromptSnapshot();
 const shared=prompts.render("team.lead-task-clustering",{taskId:"fixture",execution:"inductive",splitGuidance:prompts.render("team.lead-split-stratified",{}).text});
 const inductive=taskContract(prompts,"fixture",{...configuration,execution:"inductive"},"evidence");
 expect(inductive).toEqual([shared]);
 expect(inductive[0]!.text).not.toContain("sealed inputs followed");
 expect(taskContract(prompts,"fixture",configuration,"evidence").map(p=>p.text).join("\n")).toContain("sealed inputs followed");
});
