/** Read-only confirmation identities, shared by evaluation and terminal refit. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonical } from "../training/terminal.js";
import { statePath } from "../paths.js";

export const confirmationRoot = (projectRoot: string, taskId: string) => statePath(projectRoot, taskId, "confirmation");
export const confirmationHash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** Harness-owned split records, current location first, then the pre-v2 solve location. */
export const sealedSplitRecords = (projectRoot: string, taskId: string) => [
 statePath(projectRoot, taskId, "data", "sealed", "split.json"),
 statePath(projectRoot, taskId, "data", "sealed", "holdout.json"),
 statePath(projectRoot, taskId, "solve", "data", "holdout.json"),
];
/**
 * Why refit must wait for confirmation, or undefined when none applies.
 * A split whose record carries confirmation metadata (binary stratified
 * holdouts, including "too small" skips) is confirmed or explicitly skipped by
 * the solve chain before refit. Group and label-free splits carry none.
 * An unreadable record fails closed rather than waiving the gate.
 */
export function confirmationRequirement(projectRoot: string, taskId: string): string | undefined {
 for (const path of sealedSplitRecords(projectRoot, taskId)) {
  if (!existsSync(path)) continue;
  let record: any;
  try { record = JSON.parse(readFileSync(path, "utf8")); } catch { return `unreadable sealed split record ${path}`; }
  const split = path.endsWith("split.json") ? record?.split : record;
  if (split === null || typeof split !== "object") return `incomplete sealed split record ${path}`;
  if (split.confirmation) return `confirmation metadata recorded at ${path}`;
 }
 return undefined;
}
export function confirmedCandidate(projectRoot: string, taskId: string, candidate: { chosenExperimentId: string; source: unknown; pipeline: unknown }) {
 const latest = join(confirmationRoot(projectRoot, taskId), "latest.json");
 if (!existsSync(latest)) {
  const required = confirmationRequirement(projectRoot, taskId);
  if (required) throw new Error(`Held-back confirmation is required before refit (${required}); run the confirmation of the frozen champion first`);
  return undefined; // Champions without harness-sealed task data retain their existing refit contract.
 }
 const pointer = JSON.parse(readFileSync(latest, "utf8"));
 if (confirmationHash(pointer.path) !== pointer.sha256) throw new Error("Holdout confirmation checksum changed");
 const record = JSON.parse(readFileSync(pointer.path, "utf8"));
 if (record.schemaVersion !== 1 || record.taskId !== taskId || record.experimentId !== candidate.chosenExperimentId
  || canonical(record.source) !== canonical(candidate.source) || canonical(record.pipeline) !== canonical(candidate.pipeline)) {
  throw new Error("Chosen champion differs from held-back confirmation; confirm the frozen champion before refit");
 }
 if (!["completed", "skipped"].includes(record.status)) throw new Error("Holdout confirmation did not produce valid evidence");
 const ledgerPath = statePath(projectRoot, taskId, "holdout-ledger.json");
 const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : undefined;
 if (record.status === "completed" && (ledger?.schemaVersion !== 1 || ledger.taskId !== taskId
  || !Array.isArray(ledger.populations?.[record.population]?.reads)
  || !ledger.populations[record.population].reads.some((read: any) => read.identity === record.identity && read.experimentId === record.experimentId))) {
  throw new Error("Confirmation read reservation is missing or corrupt");
 }
 const populationReadCount = ledger?.populations?.[record.population]?.reads?.length ?? record.readCount;
 return { record, populationReadCount, path: pointer.path, sha256: pointer.sha256 };
}
