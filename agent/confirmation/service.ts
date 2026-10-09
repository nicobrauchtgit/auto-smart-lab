/** Controller-only, durable held-back confirmation after every solve session closes. */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicJson, claimWorkspace, liveGroup, ownedProcessAlive } from "../experiments/ownership.js";
import { ExperimentSupervisor } from "../experiments/supervisor.js";
import { addWorktree, resolveCommit, tagMessage, uncommittedFiles } from "../training/git.js";
import { canonical, digest, selectionClaimAsync } from "../training/terminal.js";
import { deriveTrialSeed, deriveBootstrapSeed, parseSeedPlan } from "../training/seeds.js";
import { inspectRefitCandidate, assertNoWorkers, type RefitOptions } from "../refit/service.js";
import { sanitizeTrainingEnvironment } from "../training/environment.js";
import { artifact } from "../evaluation/evidence.js";
import { confirmationRoot, confirmationHash } from "./receipt.js";
import type { SolveWorkspace } from "../solve/workspace.js";
import type { StageArtifact } from "../pipeline/types.js";

const PYTHON_ROOT = join(import.meta.dir, "../training/python");
const WORKER = join(PYTHON_ROOT, "confirm.py");
const RUNNER = join(PYTHON_ROOT, "runner.py");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
export interface ConfirmationOptions {
 workspace: SolveWorkspace; pythonExecutable: string; environmentFingerprint: string;
 env: Record<string, string>; report?: RefitOptions["report"]; signal?: AbortSignal;
 sandboxCommand?: (command: string[], input: { directory: string; sourceRoots: readonly string[] }) => string[];
}
export interface ConfirmationOutput { artifact: StageArtifact; summary: Record<string, unknown> }
function probe(options: ConfirmationOptions, args: string[]): void {
 const result = spawnSync(options.pythonExecutable, [WORKER, ...args], { env: sanitizeTrainingEnvironment(options.env),
  timeout: 30_000, encoding: "utf8", maxBuffer: 1024 * 1024 });
 if (result.error || result.status !== 0) throw new Error(`Holdout confirmation validation failed: ${result.error?.message ?? result.stderr.trim()}`);
}

export async function runConfirmation(options: ConfirmationOptions): Promise<ConfirmationOutput> {
 const { workspace } = options;
 const projectRoot = dirname(workspace.solutionsRoot);
 const taskId = workspace.holdoutSeedPlan?.taskId ?? json(workspace.sampleManifestPath).taskId;
 if (!taskId) throw new Error("Confirmation requires the controller holdout seed plan");
 const root = confirmationRoot(projectRoot, taskId);
 const release = claimWorkspace(root);
 let unlock: (() => void) | undefined;
 let supervisor: ExperimentSupervisor | undefined;
 try {
  options.signal?.throwIfAborted();
  unlock = await selectionClaimAsync(workspace.solutionsRoot);
  const prepared = await inspectRefitCandidate({ taskId, projectRoot, solutionsRoot: workspace.solutionsRoot,
   pythonExecutable: options.pythonExecutable, environmentFingerprint: options.environmentFingerprint, env: options.env,
   taskConfiguration: workspace.configuration, trainZip: workspace.trainZip, testZip: workspace.testZip,
   labelsPath: workspace.originalTargetsPath, signal: options.signal });
  assertNoWorkers(join(workspace.root, "training"));
  const chosen = JSON.parse(tagMessage(workspace.solutionsRoot, `champion/${taskId}`)!.message);
  assertNoWorkers(chosen.trainingRoot);
  const holdout = { ...workspace.split.confirmation, sha256: workspace.split.sha256,
   fraction: workspace.split.fraction, seed: workspace.split.seed };
  const identity = digest({ taskId, experimentId: prepared.chosenExperimentId, source: prepared.source, pipeline: prepared.pipeline, holdout });
  const directory = join(root, identity);
  mkdirSync(directory, { recursive: true });
  const resultPath = join(directory, "holdout-confirmation.json");
  const ledgerPath = join(projectRoot, "runs", taskId, "holdout-ledger.json");
  const ledger = existsSync(ledgerPath) ? json(ledgerPath) : { schemaVersion: 1, taskId, populations: {} };
  if (ledger.schemaVersion !== 1 || ledger.taskId !== taskId || !ledger.populations || Array.isArray(ledger.populations)
   || Object.values(ledger.populations).some((entry: any) => !Array.isArray(entry.reads)
    || entry.reads.some((read: any) => typeof read.identity !== "string" || typeof read.experimentId !== "string"))) throw new Error("Corrupt holdout ledger");
  const population = digest({ dataset: workspace.holdoutSeedPlan?.datasetSha256, holdout: workspace.split.sha256 });
  const count = () => ledger.populations[population]?.reads?.length ?? 0;
  const measuredManifest = String(prepared.inputs.devManifest);
  if (confirmationHash(measuredManifest) !== confirmationHash(workspace.sampleManifestPath)) throw new Error("Champion was selected on a different development split");
  const devIds = new Set<string>(json(measuredManifest).samples.map((sample: any) => sample.id));
  const expectedSealed = prepared.data.trainIds.filter(id => !devIds.has(id));
  if (canonical([...workspace.split.sealedIds].sort()) !== canonical(expectedSealed)) throw new Error("Sealed IDs do not complement champion development data");
  const common = { schemaVersion: 1, taskId, identity, population, experimentId: prepared.chosenExperimentId,
   source: prepared.source, pipeline: prepared.pipeline, holdout, advisoryOnly: true };
  const skipped = workspace.configuration.kind !== "binary_classification" || !workspace.split.sealedIds.length;
  if (skipped) {
   if (!existsSync(resultPath)) atomicJson(resultPath, { ...common, status: "skipped", readCount: count(),
    precision: "none", reason: workspace.split.confirmation?.reason ?? "Binary stratified confirmation does not apply to this task" });
  } else {
   const freezePath = join(directory, "freeze.json");
   const trialPath = join(chosen.trainingRoot, prepared.chosenExperimentId);
   const plan = parseSeedPlan(readFileSync(join(trialPath, "seed-plan.json"), "utf8"));
   const framework = digest([WORKER, ...["agent_code.py", "id_leakage.py", "metrics.py", "measurement.py"].map(name => join(PYTHON_ROOT, "smartlab_trial", name))].map(confirmationHash));
   if (!existsSync(freezePath)) {
    if (ledger.populations[population]?.reads?.some((read: any) => read.identity === identity)) throw new Error("Confirmation read was already reserved; refusing a duplicate sealed read");
    options.signal?.throwIfAborted();
    const sourceRoot = join(directory, "source");
    addWorktree(workspace.solutionsRoot, join(sourceRoot, "solutions"), prepared.source.commit);
    const preparation = join(directory, "prepare.json");
    const originalHashes = { [workspace.trainZip]: confirmationHash(workspace.trainZip),
     [workspace.originalTargetsPath!]: confirmationHash(workspace.originalTargetsPath!) };
    atomicJson(preparation, { originalHashes, trainZip: workspace.trainZip, targetsPath: workspace.originalTargetsPath, sealedIds: workspace.split.sealedIds });
    probe(options, ["--prepare", preparation]);
    const validationManifest = join(directory, "sealed-samples.json");
    const measuredDev = measuredManifest;
    const sealed = json(validationManifest).samples.map((sample: any) => sample.id).sort();
    if (canonical(sealed) !== canonical(expectedSealed)) throw new Error("Sealed IDs do not complement champion development data");
    ledger.populations[population] ??= { reads: [] };
    ledger.populations[population].reads.push({ identity, experimentId: prepared.chosenExperimentId, reservedAt: new Date().toISOString() });
    // Reservation precedes launch; a crash never silently repeats sealed reads.
    atomicJson(ledgerPath, ledger);
    atomicJson(freezePath, { ...common, readCount: count(), sourceRoot, environment: prepared.environment, framework,
     origin: Object.fromEntries(Object.entries({ pipelineRunId: options.report?.agentIdentity(1).pipelineRunId,
      stageInvocationId: options.report?.agentIdentity(1).stageInvocationId }).filter(([, value]) => typeof value === "string" && value)),
     developmentManifest: measuredDev, validationManifest, seedLineage: plan, holdoutSeedPlan: workspace.holdoutSeedPlan,
     seed: deriveTrialSeed(plan, "holdout-confirmation"), bootstrapSeed: deriveBootstrapSeed(plan),
     cvMean: json(join(trialPath, "trial-result.json")).metrics.balancedAccuracy,
     hashes: Object.fromEntries([measuredDev, String(prepared.inputs.devZip), validationManifest, join(directory, "sealed.zip")].map(path => [path, confirmationHash(path)])) });
   }
   const frozen = json(freezePath);
   if (!ledger.populations[population]?.reads?.some((read: any) => read.identity === identity && read.experimentId === prepared.chosenExperimentId)
    || frozen.readCount > count()) throw new Error("Confirmation read reservation is missing or corrupt");
   if (frozen.identity !== identity || frozen.framework !== framework || canonical(frozen.environment) !== canonical(prepared.environment)) throw new Error("Frozen confirmation identity/environment drifted");
   if (canonical(frozen.seedLineage) !== canonical(plan) || frozen.seed !== deriveTrialSeed(plan, "holdout-confirmation")
    || frozen.bootstrapSeed !== deriveBootstrapSeed(plan)) throw new Error("Frozen confirmation seed lineage drifted");
   for (const [path, hash] of Object.entries(frozen.hashes)) if (confirmationHash(path) !== hash) throw new Error("Frozen confirmation data drifted");
   const source = resolveCommit(join(frozen.sourceRoot, "solutions"), "HEAD");
   if (source?.commit !== prepared.source.commit || source.tree !== prepared.source.tree || uncommittedFiles(join(frozen.sourceRoot, "solutions")).length) throw new Error("Frozen confirmation source drifted");
   if (!existsSync(resultPath)) {
    const workerDirectory = join(directory, "worker");
    supervisor = new ExperimentSupervisor({ root: workerDirectory, env: sanitizeTrainingEnvironment(options.env),
     deliver() {},
     record: (type, payload) => options.report?.event(type, payload), pipelineRunId: options.report?.agentIdentity(1).pipelineRunId ?? undefined,
     stageInvocationId: options.report?.agentIdentity(1).stageInvocationId ?? undefined });
    const ownerPath = join(workerDirectory, "worker-owner.json");
    const experimentPath = join(workerDirectory, "experiment.json");
    const owner = existsSync(ownerPath) ? json(ownerPath) : undefined;
    const prior = existsSync(experimentPath) ? json(experimentPath) : undefined;
    const statePath = join(workerDirectory, "supervisor-state.json");
    const state = existsSync(statePath) ? json(statePath) : undefined;
    if (ownedProcessAlive(owner?.identity) || ownedProcessAlive(state?.identity)) {
     if (ownedProcessAlive(owner?.identity) && ownedProcessAlive(state?.identity) && owner.identity.birth !== state.identity.birth) throw new Error("Conflicting live confirmation ownership receipts");
     if (ownedProcessAlive(owner?.identity)) atomicJson(join(workerDirectory, "launch-released.json"), { token: owner.token });
     const identity = ownedProcessAlive(owner?.identity) ? owner.identity : state.identity;
     supervisor.attach({ ...prior, id: "confirmation", pid: identity.pid, pgid: identity.pgid, directory: workerDirectory,
      logPath: join(workerDirectory, "output.log"), startedAt: prior?.startedAt ?? new Date().toISOString(), hypothesis: "Frozen champion confirmation", scope: "sealed rows", argv: [], cwd: frozen.sourceRoot }, { ...state, identity, status: "running" });
    } else if (owner || prior) {
     if (liveGroup(owner?.identity.pgid ?? prior.pgid).length) throw new Error("Confirmation descendants survive without verified ownership");
     throw new Error("Confirmation attempt was interrupted or failed; sealed read was consumed and cannot automatically repeat");
    } else {
     const reservation = join(directory, "launch-reserved.json");
     if (existsSync(reservation)) throw new Error("Confirmation launch was interrupted; inspect consumed sealed read before retrying");
     atomicJson(reservation, { reserved: true });
     const token = randomUUID();
     const command = [options.pythonExecutable, WORKER, "--directory", directory];
     const wrapped = options.sandboxCommand?.(command, { directory, sourceRoots: [frozen.sourceRoot, freezePath, ...Object.keys(frozen.hashes)] }) ?? command;
     supervisor.start({ argv: [options.pythonExecutable, RUNNER, "--directory", workerDirectory, "--token", token, "--", ...wrapped],
      cwd: frozen.sourceRoot, hypothesis: "Frozen champion held-back confirmation", scope: "fit development rows; predict sealed rows" }, undefined, "confirmation", workerDirectory);
     atomicJson(join(workerDirectory, "launch-released.json"), { token });
     options.report?.event("holdout_confirmation_started", { experiment_id: prepared.chosenExperimentId, identity, read_count: count(), holdout });
    }
    while (supervisor.status("confirmation").status === "running") {
     if (options.signal?.aborted) { await supervisor.stop("confirmation", "confirmation cancelled"); options.signal.throwIfAborted(); }
     await Bun.sleep(50);
    }
    if (!existsSync(resultPath)) throw new Error("Confirmation did not complete; consumed read and worker logs retained");
   }
   probe(options, ["--directory", directory, "--validate"]);
  }
  const result = json(resultPath);
  if (result.identity !== identity) throw new Error("Confirmation identity check failed");
  const output = artifact("holdout_confirmation", resultPath);
  atomicJson(join(root, "latest.json"), { path: resultPath, sha256: output.sha256 });
  if (result.idLeakage) throw new Error("Confirmation ID leakage check failed");
  const summary = { status: result.status, precision: result.holdout.precision ?? "none", balancedAccuracy: result.metrics?.balancedAccuracy,
   gap: result.gap, interval: result.interval, likelySelectionOverfit: result.likelySelectionOverfit, readCount: result.readCount,
   populationReadCount: count(), reason: result.reason, experimentId: result.experimentId };
  options.report?.event("holdout_confirmation_validated", summary);
  options.report?.input({ kind: "holdout_confirmation", version: 1, delivery: "workspace_file", status: "available", artifact: resultPath, content_sha256: output.sha256 });
  return { artifact: output, summary };
 } finally { await supervisor?.close(); unlock?.(); release(); }
}
