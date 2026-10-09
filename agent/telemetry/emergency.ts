import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** A failure-only journal. It never creates a file for healthy execution. */
export class EmergencyJournal {
 private active = false;
 private broken = false;
 constructor(readonly path: string, private failedWrite: () => void) {}
 get localPath(): string | undefined { return this.active && !this.broken ? this.path : undefined; }
 activate(reason: string, context: unknown) {
  if (this.active) return;
  this.active = true;
  this.write({ version: 1, kind: "delivery_failure", at: new Date().toISOString(), reason, context,
   coverage: "failed batches and subsequent records; not a complete run mirror" });
 }
 write(record: unknown) {
  if (!this.active || this.broken) return;
  try {
   mkdirSync(dirname(this.path), { recursive: true });
   appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  } catch { this.broken = true; this.failedWrite(); }
 }
}
