import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confirmedCandidate, confirmationRequirement } from "./receipt.js";

const candidate = { chosenExperimentId: "trial", source: { commit: "c" }, pipeline: { module: "m", factory: "f" } };

test("refit refuses an unconfirmed champion whenever the harness sealed rows", () => {
 const root = mkdtempSync(join(tmpdir(), "receipt-gate-"));
 try {
  // No harness split at all: the pre-confirmation refit contract applies.
  expect(confirmedCandidate(root, "spam1", candidate)).toBeUndefined();
  const sealed = join(root, "runs/finetuned/spam1/data/sealed");
  mkdirSync(sealed, { recursive: true });
  // Exactly the location prepareSolveWorkspace writes.
  writeFileSync(join(sealed, "split.json"), JSON.stringify({ declaration: {}, split: { sealedIds: ["a"] } }));
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
