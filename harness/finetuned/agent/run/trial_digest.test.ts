import { test, expect } from "bun:test";
import { trialDigest } from "./trial_digest.js";
import { compactDiagnostics } from "../training/service.js";
import { loadPromptSnapshot } from "../prompts/loader.js";

const described = (...folds: any[]) => ({ diagnostics: { folds: folds.map(diagnostics => ({ diagnostics })) } });
const cluster = (n: number) => ({ structure: { clusterCount: n, singletonFraction: n / 100, largestClusterShare: .5 }, external: { available: true, pairPrecision: .8, pairRecall: .6 } });

test("clustering averages completed folds, range and cross-repeat ARI", () => {
 const input: any = described(cluster(2), cluster(4));
 input.diagnostics.folds.push({status:"failed",diagnostics:cluster(100)});
 input.diagnostics.stability = { available:true, comparisons:[{adjustedRandIndex:.6},{adjustedRandIndex:.8}] };
 expect(trialDigest("clustering", input)).toBe("clusters per batch 2-4; mean singleton fraction 0.030; mean largest-cluster share 0.500\nmean pair precision 0.800 (false merges), recall 0.600 (false splits); cross-repeat stability mean ARI 0.700");
});

test("clustering compact summary retains stability and all completed folds for feedback", () => {
 const raw: any = { diagnostics: {folds: Array.from({length:10}, (_,i)=>({diagnostics:cluster(i+1)})), stability:{available:true,summary:{available:true,mean:.75}}} };
 expect((compactDiagnostics(raw)!.folds as any[]).length).toBe(8);
 const full = compactDiagnostics(raw, true)!;
 expect((full.folds as any[]).length).toBe(10);
 expect(full.shownDiagnosticFolds).toBe(10);
 const text = trialDigest("clustering",{diagnostics:full});
 expect(text).toContain("clusters per batch 1-10; mean singleton fraction 0.055");
 expect(text).toContain("mean ARI 0.750");
});

test("optional Patch B fields present, partially available, and absent", () => {
 const input: any = described({...cluster(2), testPart:{clusterCount:10,singletonFraction:.1,largestClusterShare:.3}}, {...cluster(4),testPart:{clusterCount:20,singletonFraction:.2,largestClusterShare:.5}});
 input.diagnostics.testAgreement={available:true,meanAdjustedRandIndex:.9,minAdjustedRandIndex:.8};
 expect(trialDigest("clustering",input).split("\n")[2]).toBe("test part: clusters 10-20, singleton fraction 0.150, largest share 0.400; agreement across fits 0.900 (0.800)");
 input.diagnostics.testAgreement={available:false,meanAdjustedRandIndex:.9};
 expect(trialDigest("clustering",input)).toContain("agreement across fits unavailable (unavailable)");
 expect(trialDigest("clustering",described(cluster(2)))).not.toContain("test part:");
 expect(trialDigest("clustering",{diagnostics:{testAgreement:{available:false}}})).toContain("test part: clusters unavailable");
});

test("binary ranking, 1% FPR, advisory sweep and champion counts", () => {
 const fold = (x:number) => ({ranking:{available:true,rocAuc:x,averagePrecision:x-.1},lowFpr:{available:true,points:[{maxFpr:.001,recall:0},{maxFpr:.01,recall:x-.2}]},thresholdSweep:{available:true,defaultBalancedAccuracy:x-.1,bestBalancedAccuracy:x}});
 const input: any = described(fold(.8),fold(1));
 input.diagnostics.championComparison={status:"completed",correctedErrors:7,introducedErrors:2};
 expect(trialDigest("binary_classification",input)).toBe("mean ROC AUC 0.900, average precision 0.800; mean recall at 1% FPR 0.700\nthreshold sweep (advisory): mean default balanced accuracy 0.800 vs best 0.900\nchampion errors: corrected 7, introduced 2");
});

test("anomaly score health and flagged share are measured proxies", () => {
 expect(trialDigest("anomaly_detection",described({tieFraction:.2,constantScores:false,predictedAnomalyFraction:.1},{tieFraction:.4,constantScores:true,predictedAnomalyFraction:.3}))).toBe("score health (proxy): mean tie fraction 0.300; constant-score fold fraction 0.500; mean flagged share 0.200");
});

test("missing, unavailable and non-finite values are never invented", () => {
 for (const kind of ["clustering","binary_classification","anomaly_detection"]) {
  for (const input of [undefined,{},described({ranking:{available:false,rocAuc:.9},structure:{clusterCount:NaN},tieFraction:Infinity})]) {
   const text = trialDigest(kind,input);
   expect(text).toContain("unavailable"); expect(text).not.toMatch(/NaN|Infinity|0\.900/);
   expect(text.split("\n").length).toBeLessThanOrEqual(3);
  }
 }
});

test("lead trial prompt requires and renders the digest as factual input", () => {
 const prompts=loadPromptSnapshot();
 const values={experiment:"trial",status:"completed",hypothesis:"fixture",folds:".8",verdict:"unchanged",champion:"trial",holdout:"none",cost:"1s",streak:"0",budget:"1 of 10"};
 expect(()=>prompts.render("team.lead-trial", values as any)).toThrow(/digest/);
 const digest=trialDigest("anomaly_detection",{});
 expect(prompts.render("team.lead-trial",{...values,digest}).text).toContain(`Diagnostics: ${digest}\n`);
});
