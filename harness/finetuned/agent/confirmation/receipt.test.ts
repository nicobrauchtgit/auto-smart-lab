import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmedCandidate, confirmationRequirement, confirmationHash } from "./receipt.js";

const candidate = { chosenExperimentId: "trial", source: { commit: "c" }, pipeline: { module: "m", factory: "f" } };

test("refit refuses an unconfirmed champion whenever the harness sealed rows", () => {
 const root = mkdtempSync(join(tmpdir(), "receipt-gate-"));
 try {
  // No harness split at all: the pre-confirmation refit contract applies.
  expect(confirmedCandidate(root, "spam1", candidate)).toBeUndefined();
  const sealed = join(root, "runs/finetuned/spam1/data/sealed");
  mkdirSync(sealed, { recursive: true });
  // Exactly the location prepareSolveWorkspace writes.
  // Group/label-free splits carry no confirmation metadata: no gate.
  writeFileSync(join(sealed, "split.json"), JSON.stringify({ declaration: {}, split: { scheme: "group", sealedIds: ["a"] } }));
  expect(confirmedCandidate(root, "spam1", candidate)).toBeUndefined();
  writeFileSync(join(sealed, "split.json"), JSON.stringify({ declaration: {}, split: { sealedIds: ["a"], confirmation: { rows: 1, precision: "target" } } }));
  expect(confirmationRequirement(root, "spam1")).toContain("split.json");
  expect(() => confirmedCandidate(root, "spam1", candidate)).toThrow("Held-back confirmation is required before refit");
  rmSync(join(sealed, "split.json"));
  writeFileSync(join(sealed, "holdout.json"), "{corrupt");
  expect(() => confirmedCandidate(root, "spam1", candidate)).toThrow("unreadable sealed split record");
  rmSync(join(sealed, "holdout.json"));
  // Pre-v2 solve records with confirmation metadata also require confirmation.
  const legacy = join(root, "runs/finetuned/spam1/solve/data");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "holdout.json"), JSON.stringify({ sealedIds: ["a"], confirmation: { rows: 1 } }));
  expect(() => confirmedCandidate(root, "spam1", candidate)).toThrow("required");
  writeFileSync(join(legacy, "holdout.json"), JSON.stringify({ sealedIds: ["a"] }));
  expect(confirmedCandidate(root, "spam1", candidate)).toBeUndefined();
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an exact historical confirmation survives a newer latest pointer without spending another read", () => {
 const root=mkdtempSync(join(tmpdir(),'historical-receipt-'));
 try {
  const dir=join(root,'runs/finetuned/spam1/confirmation');mkdirSync(dir,{recursive:true});
  const record={schemaVersion:1,taskId:'spam1',experimentId:'trial',identity:'receipt-a',population:'population',source:candidate.source,pipeline:candidate.pipeline,status:'completed'};
  const path=join(dir,'a.json');writeFileSync(path,JSON.stringify(record));const receipt={path,sha256:confirmationHash(path)};
  writeFileSync(join(dir,'latest.json'),JSON.stringify({path:join(dir,'b.json'),sha256:'newer'}));
  const ledger=join(root,'runs/finetuned/spam1/holdout-ledger.json');
  writeFileSync(ledger,JSON.stringify({schemaVersion:1,taskId:'spam1',populations:{population:{reads:[{identity:'receipt-a',experimentId:'trial'},{identity:'receipt-b',experimentId:'new'}]}}}));
  expect(confirmedCandidate(root,'spam1',candidate,receipt)?.populationReadCount).toBe(2);
  expect(()=>confirmedCandidate(root,'spam1',{...candidate,chosenExperimentId:'new'},receipt)).toThrow('differs');
  expect(()=>confirmedCandidate(root,'spam1',{...candidate,pipeline:{...candidate.pipeline,parameters:{changed:true}}},receipt)).toThrow('differs');
  writeFileSync(ledger,JSON.stringify({schemaVersion:1,taskId:'spam1',populations:{population:{reads:[]}}}));
  expect(()=>confirmedCandidate(root,'spam1',candidate,receipt)).toThrow('reservation');
  writeFileSync(path,JSON.stringify({...record,status:'failed'}));expect(()=>confirmedCandidate(root,'spam1',candidate,receipt)).toThrow('checksum');
 }finally{rmSync(root,{recursive:true,force:true});}
});
