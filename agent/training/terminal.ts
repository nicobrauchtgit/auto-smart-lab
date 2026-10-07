/** Terminal identities share a repository lock with development starts. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claimWorkspace } from "../experiments/ownership.js";
import { git } from "./git.js";
import type { PipelineRequest } from "./types.js";
export function canonical(value: unknown): string {
 if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
 if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
 return JSON.stringify(value);
}
export function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
export function selectionDirectory(repository: string): string {
 const result = git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
 if (result.status) throw new Error("Solutions repository unavailable");
 return join(result.stdout.trim(), "smartlab-terminal");
}
export function candidateIdentity(taskId: string, commit: string, pipeline: PipelineRequest): string {
 return digest({ taskId, commit, pipeline: { module: pipeline.module, factory: pipeline.factory,
  parameters: pipeline.parameters ?? null, estimatorParams: pipeline.estimatorParams ?? {} } });
}
export function selectionClaim(repository: string): () => void { return claimWorkspace(selectionDirectory(repository)); }
export function terminalPath(repository: string, identity: string): string { return join(selectionDirectory(repository), `${identity}.json`); }
/** A terminal champion may be retained as history, never rerun for comparison. */
export function isTerminalCandidate(repository: string, taskId: string, commit: string, pipeline: PipelineRequest): boolean {
 const identity = candidateIdentity(taskId, commit, pipeline), path = terminalPath(repository, identity);
 if (!existsSync(path)) return false;
 const record = JSON.parse(readFileSync(path, "utf8"));
 if (record.schemaVersion !== 1 || record.identity !== identity || record.taskId !== taskId || record.source?.commit !== commit || candidateIdentity(taskId, commit, record.pipeline) !== identity) throw new Error("Corrupt terminal candidate marker; restore before development");
 return true;
}
export function assertDevelopmentCandidate(repository: string, taskId: string, commit: string, pipeline: PipelineRequest): void {
 const path = terminalPath(repository, candidateIdentity(taskId, commit, pipeline));
 if (existsSync(path)) {
  JSON.parse(readFileSync(path, "utf8")); // Corrupt records fail closed too.
  throw new Error("Candidate is terminal: its sealed rows are training data. Change source or fixed parameters and validate a new candidate.");
 }
}

export async function selectionClaimAsync(repository: string): Promise<() => void> {
 const deadline = Date.now() + 5000;
 while (true) {
  try { return selectionClaim(repository); }
  catch (error) {
   if (!(error instanceof Error) || !error.message.includes("owned by another service") || Date.now() >= deadline) throw error;
   await Bun.sleep(25);
  }
 }
}
