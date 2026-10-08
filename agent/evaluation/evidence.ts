import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { collectTrainingResults, collectTrainingTrial } from "../training/results.js";
import { championSelection, recordedRepository } from "../training/development_selection.js";
import { readPythonEnvironment } from "../run/python_environment.js";
import type { StageArtifact } from "../pipeline/types.js";

export const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export function artifact(kind: string, path: string): StageArtifact {
 const bytes = readFileSync(path);
 return { kind, path, sha256: digest(bytes), bytes: bytes.length };
}
export function selectedArtifact(upstream: StageArtifact[]): StageArtifact {
 const selected = upstream.filter(a => a.kind === "training_selected_result");
 if (selected.length !== 1 || !selected[0].sha256) throw new Error("Evaluation requires one hashed training_selected_result from solve");
 return selected[0];
}

export async function prepareEvidence(upstream: StageArtifact[], signal: AbortSignal, taskId: string) {
 const selected = selectedArtifact(upstream);
 const directory = dirname(resolve(selected.path));
 // Reuse the training contract and the champion tag as the only selection
 // rule, including manifest/seed checks; the repository is the one the trial
 // recorded as its source.
 const repository = recordedRepository(await collectTrainingTrial(directory));
 const collection = await championSelection(await collectTrainingResults(dirname(directory)), repository, taskId);
 const trial = collection.selected;
 if (!trial || trial.directory !== directory) throw new Error("Selected training evidence is not the current champion; run solve again");
 const sources = trial.artifacts.map(a => {
  const recorded = upstream.find(u => resolve(u.path) === resolve(a.path) && u.sha256 === a.sha256);
  if (!recorded) throw new Error(`Missing or changed upstream evidence: ${a.kind}`);
  return a;
 });
 if (digest(readFileSync(selected.path)) !== selected.sha256) throw new Error("Selected result hash changed");
 const seedPlan = JSON.parse(readFileSync(join(directory, "seed-plan.json"), "utf8"));
 if (seedPlan.taskId !== taskId) throw new Error("Selected trial belongs to a different task");
 const invocationPath = join(directory, "invocation.json");
 // Development targets: the labels file of binary classification, or the sample manifest of a sample task.
 const measurement = JSON.parse(readFileSync(invocationPath, "utf8")).measurement as { kind: string; sampleManifestPath: string; evidence?: { path: string } } | undefined;
 const targetsPath = measurement ? measurement.sampleManifestPath : trial.invocation?.inputs.labelsPath;
 if (typeof targetsPath !== "string") throw new Error("Selected trial has no development targets");
 sources.push({ ...artifact(measurement ? "evaluation_development_samples" : "evaluation_development_labels", targetsPath), experimentId: trial.experimentId } as typeof sources[number]);
 if (measurement?.evidence) sources.push({ ...artifact("evaluation_selection_evidence", measurement.evidence.path), experimentId: trial.experimentId } as typeof sources[number]);
 sources.push({ ...artifact("evaluation_invocation", invocationPath), experimentId: trial.experimentId } as typeof sources[number]);
 const { stdout } = await promisify(execFile)(readPythonEnvironment().executable,
  [new URL("./diagnostics.py", import.meta.url).pathname, directory],
  { signal, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
 // Ensure evidence did not change while it was read by the diagnostic process.
 for (const source of sources) {
  if (digest(readFileSync(source.path)) !== source.sha256) throw new Error(`Evidence changed during evaluation: ${source.kind}`);
 }
 const diagnostics = JSON.parse(stdout);
 return { directory, experimentId: trial.experimentId, sources, diagnostics,
  candidate: { request: trial.request, trialsConsidered: collection.trials.length,
   eligibleTrials: collection.trials.filter(t => t.eligible).length,
   measurementKind: measurement?.kind ?? "classification",
   selectionRule: "The authoritative champion tag: a promotion trial whose paired lead over the previous champion on the task's development metric exceeded noise; no independent comparison is implied." } };
}
export type EvaluationEvidence = Awaited<ReturnType<typeof prepareEvidence>>;
