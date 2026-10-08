/** Read-only confirmation identities, shared by evaluation and terminal refit. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonical } from "../training/terminal.js";

export const confirmationRoot = (projectRoot: string, taskId: string) => join(projectRoot, "runs", taskId, "confirmation");
export const confirmationHash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
export function confirmedCandidate(projectRoot: string, taskId: string, candidate: { chosenExperimentId: string; source: unknown; pipeline: unknown }) {
 const latest = join(confirmationRoot(projectRoot, taskId), "latest.json");
 if (!existsSync(latest)) {
  const metadata = join(projectRoot, "runs", taskId, "solve", "data", "holdout.json");
  if (existsSync(metadata) && JSON.parse(readFileSync(metadata, "utf8")).confirmation) throw new Error("Held-back confirmation is required before refit");
  return undefined; // Older/manual champions retain their existing refit contract.
 }
 const pointer = JSON.parse(readFileSync(latest, "utf8"));
 if (confirmationHash(pointer.path) !== pointer.sha256) throw new Error("Holdout confirmation checksum changed");
 const record = JSON.parse(readFileSync(pointer.path, "utf8"));
 if (record.schemaVersion !== 1 || record.taskId !== taskId || record.experimentId !== candidate.chosenExperimentId
  || canonical(record.source) !== canonical(candidate.source) || canonical(record.pipeline) !== canonical(candidate.pipeline)) {
  throw new Error("Chosen champion differs from held-back confirmation; confirm the frozen champion before refit");
 }
 if (!["completed", "skipped"].includes(record.status) || record.idLeakage) throw new Error("Holdout confirmation did not produce valid evidence");
 const ledgerPath = join(projectRoot, "runs", taskId, "holdout-ledger.json");
 const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : undefined;
 if (record.status === "completed" && (ledger?.schemaVersion !== 1 || ledger.taskId !== taskId
  || !Array.isArray(ledger.populations?.[record.population]?.reads)
  || !ledger.populations[record.population].reads.some((read: any) => read.identity === record.identity && read.experimentId === record.experimentId))) {
  throw new Error("Confirmation read reservation is missing or corrupt");
 }
 const populationReadCount = ledger?.populations?.[record.population]?.reads?.length ?? record.readCount;
 return { record, populationReadCount, path: pointer.path, sha256: pointer.sha256 };
}
