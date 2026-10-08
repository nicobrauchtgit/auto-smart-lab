/** Harness-owned terminal refit, with durable freeze and process-group ownership. */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { atomicJson, claimWorkspace, liveGroup, ownedProcessAlive } from "../experiments/ownership.js";
import { ExperimentSupervisor } from "../experiments/supervisor.js";
import { addWorktree, git, resolveCommit, tagMessage, uncommittedFiles } from "../training/git.js";
import { collectTrainingResults } from "../training/results.js";
import { championTag } from "../training/development_selection.js";
import { deriveTrialSeed, parseSeedPlan } from "../training/seeds.js";
import { candidateIdentity, canonical, digest, selectionClaim, terminalPath } from "../training/terminal.js";
import { sanitizeTrainingEnvironment } from "../training/environment.js";
import type { StageArtifact, StageReporter } from "../pipeline/types.js";
import type { PipelineRequest } from "../training/types.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";
import { confirmedCandidate } from "../confirmation/receipt.js";

const FRAMEWORK_ROOT = resolve(import.meta.dir, "..");
const WORKER = join(import.meta.dir, "worker.py");
const RUNNER = join(FRAMEWORK_ROOT, "training/python/runner.py");
export const hashFile = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
export interface RefitOptions {
 taskId: string; projectRoot: string; solutionsRoot: string; pythonExecutable: string;
 /** Selects the terminal fit and prediction domain; must agree with the measured champion. */
 taskConfiguration: TaskConfiguration;
 /** The original targets file (binary labels or families); absent for label-free tasks. */
 labelsPath?: string; trainZip: string; testZip: string;
 trainingRoot?: string; environmentFingerprint: string; env: Record<string, string>;
	/** Controller assertion binding reviewed upstream evidence to terminal selection. */
	expectedExperimentId?: string;
 signal?: AbortSignal; report?: StageReporter;
}
export interface RefitFreeze {
 schemaVersion: 1; identity: string; taskId: string; terminalPath: string; directory: string;
 source: { commit: string; tree: string }; sourceRoot: string; pipeline: PipelineRequest;
 chosenExperimentId: string; environment: { fingerprint: string; runtimeDependencyHash: string; frameworkHash: string };
 seed: number; seedLineage: unknown; evidence: { path: string; sha256: string }[];
 inputs: Record<string, unknown>; data: { trainIds: string[]; testIds: string[]; trainRows: number; developmentRows: number; sealedRows: number; testRows: number; hashes: Record<string, string> };
 origin: { pipelineRunId?: string | null; stageInvocationId?: string | null };
}
export interface TerminalRefitResult {
 schemaVersion: 1; status: "completed"; identity: string; freezeSha256: string;
 trainRows: number; testRows: number; fitCalls: 1; trainIdsSha256: string;
 source: RefitFreeze["source"]; pipeline: PipelineRequest; environment: RefitFreeze["environment"];
 seed: number; seedLineage: unknown; evidence: RefitFreeze["evidence"]; data: Record<string, string>;
 artifacts: { "predictions.csv": string; "model.pkl"?: string }; modelSerialization: { status: "available" | "unavailable"; errorType?: string }; seededParameters: string[];
}
function python(options: RefitOptions, args: string[], timeout = 30_000): string {
 const result = spawnSync(options.pythonExecutable, args, { encoding: "utf8", env: sanitizeTrainingEnvironment(options.env), timeout, maxBuffer: 16 * 1024 * 1024 });
 if (result.error || result.status !== 0) throw new Error(`Refit validation failed: ${result.error?.message ?? result.stderr.trim()}`);
 return result.stdout.trim();
}
export function runtimeDependencyHash(options: RefitOptions): string {
 return createHash("sha256").update(python(options, ["-I", "-c", "import importlib.metadata,json,platform; print(json.dumps({'python':platform.python_version(),'packages':sorted((d.metadata['Name'],d.version) for d in importlib.metadata.distributions())},sort_keys=True))"], 5000)).digest("hex");
}
/** Fingerprint every local executable adapter used by terminal refit/recovery. */
export const REFIT_FRAMEWORK_FILES = ["refit/worker.py", "training/python/runner.py", "refit/evidence.py", "training/python/task_samples.py", "training/python/pcap_samples.py",
 "training/python/confirm.py", "confirmation/receipt.ts", ...["metrics.py", "measurement.py", "id_leakage.py"].map(name => `training/python/smartlab_trial/${name}`)];
export function frameworkHash(root = FRAMEWORK_ROOT): string {
 return digest(REFIT_FRAMEWORK_FILES.map(path => hashFile(join(root, path))));
}

/** The measurement declaration a sample trial ran under, as the training service hashed it. */
function measuredDeclaration(measurement: Record<string, unknown>): Record<string, unknown> {
 const { sampleManifestSha256: _hash, hasTargets: _targets, evidenceManifestSha256: _evidence, evidence: _evidencePath, ...declaration } = measurement;
 return declaration;
}

/** The champion must have been measured under the configuration the refit now applies. */
function assertMeasuredConfiguration(configuration: TaskConfiguration, measurement: Record<string, any> | undefined): void {
 if (!measurement) throw new Error("Champion was measured on the retired decoded-text frame; promote a champion on raw sample input first");
 const kind = configuration.kind === "binary_classification" ? "classification" : configuration.kind;
 if (measurement.kind !== kind || measurement.execution !== configuration.execution) throw new Error("Champion measurement kind/execution differs from the task configuration");
 if (canonical(configuration.selection ?? null) !== canonical(measurement.selection ?? null)) throw new Error("Champion selection differs from task configuration");
 if (configuration.kind === "anomaly_detection" && ["scoreMethod", "scoreDirection", "anomalyLabel"].some(key => measurement[key] !== (configuration.anomaly as Record<string, unknown>)[key])) throw new Error("Champion anomaly score semantics differ from the task configuration");
}

/** Worker inputs for original-data inspection, without development evidence. */
export function originalRefitData(options: Pick<RefitOptions, "taskConfiguration" | "labelsPath" | "trainZip" | "testZip">): Record<string, unknown> {
 return { kind: "samples", task: { kind: options.taskConfiguration.kind === "binary_classification" ? "classification" : options.taskConfiguration.kind, targets: options.taskConfiguration.targets.kind, source: options.taskConfiguration.samples.source },
  trainZip: options.trainZip, testZip: options.testZip, ...(options.labelsPath ? { targetsPath: options.labelsPath } : {}) };
}
export function assertNoWorkers(root: string): void {
 if (!existsSync(root)) return;
 for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "source" || entry.name === "champion") continue;
  const path = join(root, entry.name);
  const record = join(path, "experiment.json");
  const owner = join(path, "worker-owner.json");
  if ((existsSync(record) && liveGroup(json(record).pgid).length)
   || (existsSync(owner) && liveGroup(json(owner).identity.pgid).length)) throw new Error(`Training worker still active: ${path}. Finish or stop it before terminal selection.`);
  // Search run directories only, never recurse into source/data archives.
  if (!existsSync(join(path, "invocation.json"))) assertNoWorkers(path);
 }
}
/** Read-only candidate integrity check; never selects by score. */
export async function inspectRefitCandidate(options: RefitOptions): Promise<RefitFreeze> {
 options.signal?.throwIfAborted();
 const tag = tagMessage(options.solutionsRoot, championTag(options.taskId));
 if (!tag) throw new Error("No authoritative champion tag; complete a measured promotion first");
 const chosen = JSON.parse(tag.message);
 if (options.expectedExperimentId !== undefined && chosen.experimentId !== options.expectedExperimentId) throw new Error("Chosen champion differs from controller-supplied reviewed evidence");
 if (typeof chosen.experimentId !== "string" || !chosen.pipeline || typeof chosen.trainingRoot !== "string") throw new Error("Champion tag lacks evidence or fixed pipeline");
 const trainingRoot = resolve(options.trainingRoot ?? chosen.trainingRoot);
 if (trainingRoot !== resolve(chosen.trainingRoot)) throw new Error("Supplied evidence root disagrees with champion tag");
 const collection = await collectTrainingResults(trainingRoot);
 const trial = collection.trials.find(t => t.experimentId === chosen.experimentId);
 if (!trial?.eligible || !trial.invocation || !trial.request || trial.request.search) throw new Error("Chosen champion has no valid eligible measured confirmation evidence");
 if (canonical(chosen.pipeline) !== canonical(trial.request.pipeline)) throw new Error("Champion parameters disagree with measured confirmation");
 const source = trial.invocation.source as { commit: string; tree: string; repository: string } | undefined;
 const resolved = resolveCommit(options.solutionsRoot, tag.commit);
 if (!source || !resolved || source.commit !== tag.commit || source.tree !== resolved.tree || resolve(source.repository) !== resolve(options.solutionsRoot)) throw new Error("Champion source integrity failed");
 if (git(options.solutionsRoot, ["ls-tree", "-r", tag.commit]).stdout.split("\n").some(line => line.startsWith("120000"))) throw new Error("Frozen source cannot contain symlinks");
 const recoveryPath = join(trial.directory, "recovery.json");
 const recovery = json(recoveryPath);
 const dependencies = runtimeDependencyHash(options);
 if (recovery.runtimeDependencyHash !== dependencies || recovery.environmentFingerprint !== options.environmentFingerprint) throw new Error("Champion dependency fingerprint drifted; restore measured environment");
 const measurement = json(join(trial.directory, "invocation.json")).measurement as Record<string, any> | undefined;
 assertMeasuredConfiguration(options.taskConfiguration, measurement);
 const devZip = String(trial.invocation.inputs.zipPath);
 // Trials hash their declaration and manifest; the solve fingerprint also covers the archive bytes.
 const manifest = String(measurement!.sampleManifestPath);
 const dataHash = createHash("sha256").update(canonical(measuredDeclaration(measurement!))).update(readFileSync(manifest)).digest("hex");
 const datasetHash = createHash("sha256").update(readFileSync(devZip)).update(readFileSync(manifest)).digest("hex");
 if (recovery.dataHash !== dataHash || recovery.datasetSha256 !== datasetHash) throw new Error("Measured evidence/data identity drifted");
 const original = originalRefitData(options) as { task: Record<string, unknown> };
 const inputs: Record<string, unknown> = { ...original, task: { ...original.task, execution: options.taskConfiguration.execution, predictions: options.taskConfiguration.submission.predictions,
  ...(options.taskConfiguration.anomaly ? { anomaly: options.taskConfiguration.anomaly } : {}),
  // Exactly the controller context the factory received in its measured trials.
  measurement: Object.fromEntries(Object.entries(measurement!).filter(([key]) => !["sampleManifestPath", "sampleManifestSha256", "evidence", "evidenceManifestSha256"].includes(key))) },
  devZip, devManifest: manifest };
 if (recovery.invocationHash !== hashFile(join(trial.directory, "invocation.json"))
  || recovery.seedPlanHash !== hashFile(join(trial.directory, "seed-plan.json"))) throw new Error("Measured evidence/data identity drifted");
 const plan = parseSeedPlan(readFileSync(join(trial.directory, "seed-plan.json"), "utf8"));
 if (plan.taskId !== options.taskId) throw new Error("Champion belongs to another task");
 const data = JSON.parse(python(options, [WORKER, "--inspect-json", JSON.stringify(inputs)]));
 python(options, [WORKER, "--evidence", trial.directory]);
 const identity = candidateIdentity(options.taskId, tag.commit, trial.request.pipeline);
 const directory = join(options.projectRoot, "runs", options.taskId, "refit", identity);
 const evidencePaths = [...trial.artifacts.map(a => a.path), ...["request.json", "invocation.json", "recovery.json", "single-checkpoint.json"].map(name => join(trial.directory, name))];
 const prepared: RefitFreeze = { schemaVersion: 1, identity, taskId: options.taskId, terminalPath: terminalPath(options.solutionsRoot, identity), directory,
  source: { commit: tag.commit, tree: resolved.tree }, sourceRoot: join(directory, "source"), pipeline: trial.request.pipeline,
  chosenExperimentId: trial.experimentId, environment: { fingerprint: options.environmentFingerprint, runtimeDependencyHash: dependencies, frameworkHash: frameworkHash() },
  seed: deriveTrialSeed(plan, "terminal-refit"), seedLineage: plan,
  evidence: [...new Set(evidencePaths)].map(path => ({ path, sha256: hashFile(path) })), inputs, data,
  origin: { pipelineRunId: options.report?.agentIdentity(1).pipelineRunId, stageInvocationId: options.report?.agentIdentity(1).stageInvocationId } };
 if (existsSync(prepared.terminalPath)) {
  const frozen: RefitFreeze = json(prepared.terminalPath);
  if (frozen.chosenExperimentId !== prepared.chosenExperimentId || canonical(frozen.source) !== canonical(prepared.source)) throw new Error("Chosen champion disagrees with terminal freeze");
  validateFrozen(options, frozen, false);
  const local = join(frozen.directory, "freeze.json");
  if (existsSync(local) && hashFile(local) !== hashFile(frozen.terminalPath)) throw new Error("Local freeze differs from terminal marker");
  if (existsSync(join(frozen.directory, "result.json"))) python(options, [WORKER, "--directory", frozen.directory, "--validate"]);
 }
 return prepared;
}
export async function prepareRefit(options: RefitOptions): Promise<RefitFreeze> {
 const prepared = await inspectRefitCandidate(options);
 const confirmation = confirmedCandidate(options.projectRoot, options.taskId, prepared);
 if (confirmation) {
  prepared.evidence.push({ path: confirmation.path, sha256: confirmation.sha256 });
  if (confirmation.record.status === "completed") {
   const directory = dirname(confirmation.path);
   python(options, [join(FRAMEWORK_ROOT, "training/python/confirm.py"), "--directory", directory, "--validate"]);
   const freeze = json(join(directory, "freeze.json"));
   for (const path of [join(directory, "freeze.json"), join(directory, "predictions.csv"), ...Object.keys(freeze.hashes)]) {
    if (!prepared.evidence.some(entry => entry.path === path)) prepared.evidence.push({ path, sha256: hashFile(path) });
   }
  }
 }
 return prepared;
}
function validateFrozen(options: RefitOptions, freeze: RefitFreeze, restoreSource = true): void {
 if (freeze.schemaVersion !== 1 || freeze.identity !== candidateIdentity(options.taskId, freeze.source.commit, freeze.pipeline)
  || freeze.directory !== join(options.projectRoot, "runs", options.taskId, "refit", freeze.identity)
  || freeze.terminalPath !== terminalPath(options.solutionsRoot, freeze.identity)
  || freeze.sourceRoot !== join(freeze.directory, "source")) throw new Error("Invalid terminal freeze identity or paths");
 if (freeze.environment.fingerprint !== options.environmentFingerprint || freeze.environment.runtimeDependencyHash !== runtimeDependencyHash(options)
  || freeze.environment.frameworkHash !== frameworkHash()) throw new Error("Frozen refit environment/framework drifted");
 for (const entry of freeze.evidence) if (hashFile(entry.path) !== entry.sha256) throw new Error(`Frozen evidence changed: ${entry.path}`);
 const data = JSON.parse(python(options, [WORKER, "--inspect-json", JSON.stringify(freeze.inputs)]));
 if (canonical(data) !== canonical(freeze.data)) throw new Error("Frozen refit data drifted");
 const worktree = join(freeze.sourceRoot, "solutions");
 if (!existsSync(worktree)) {
  if (!restoreSource) { if (resolveCommit(options.solutionsRoot, freeze.source.commit)?.tree !== freeze.source.tree) throw new Error("Frozen source unavailable"); return; }
  git(options.solutionsRoot, ["worktree", "prune"]); addWorktree(options.solutionsRoot, worktree, freeze.source.commit);
 }
 const source = resolveCommit(worktree, "HEAD");
 if (source?.commit !== freeze.source.commit || source.tree !== freeze.source.tree || uncommittedFiles(worktree).length) throw new Error("Frozen refit worktree changed; restore original source without discarding edits");
}
export async function runRefit(options: RefitOptions): Promise<{ artifacts: StageArtifact[]; validation: { valid: boolean; errors: string[] } }> {
 const prepared = await prepareRefit(options);
 const release = claimWorkspace(prepared.directory);
 let supervisor: ExperimentSupervisor | undefined;
 try {
  const unlock = selectionClaim(options.solutionsRoot);
  let freeze: RefitFreeze;
  try {
   if (existsSync(prepared.terminalPath)) freeze = json(prepared.terminalPath);
   else {
    const current = tagMessage(options.solutionsRoot, championTag(options.taskId));
    if (!current || current.commit !== prepared.source.commit || JSON.parse(current.message).experimentId !== prepared.chosenExperimentId || canonical(JSON.parse(current.message).pipeline) !== canonical(prepared.pipeline)) throw new Error("Champion changed while preparing refit; retry selection");
    for (const entry of prepared.evidence) if (hashFile(entry.path) !== entry.sha256) throw new Error("Evidence changed before freeze");
    assertNoWorkers(join(options.projectRoot, "runs", options.taskId, "solve", "training"));
    assertNoWorkers(options.trainingRoot ?? JSON.parse(tagMessage(options.solutionsRoot, championTag(options.taskId))!.message).trainingRoot);
    freeze = prepared;
    mkdirSync(freeze.directory, { recursive: true });
    // One atomic record is both the freeze and terminal selection boundary.
    atomicJson(freeze.terminalPath, freeze);
   }
  } finally { unlock(); }
  options.report?.event("refit_candidate_frozen", { candidate_identity: freeze.identity, chosen_experiment_id: freeze.chosenExperimentId,
   freeze_path: freeze.terminalPath, freeze_sha256: hashFile(freeze.terminalPath), source: freeze.source, pipeline: freeze.pipeline,
   environment: freeze.environment, seed: freeze.seed, original_identity: freeze.origin });
  const path = join(freeze.directory, "freeze.json");
  if (existsSync(path) && hashFile(path) !== hashFile(freeze.terminalPath)) throw new Error("Local freeze differs from durable terminal marker");
  if (!existsSync(path)) atomicJson(path, freeze);
  validateFrozen(options, freeze);
  for (const evidence of freeze.evidence) options.report?.input({ kind: "refit_supporting_evidence", version: 1, delivery: "none", status: "available", artifact: evidence.path, content_sha256: evidence.sha256 });
  options.report?.input({ kind: "terminal_refit_freeze", version: 1, delivery: "none", status: "available", artifact: path, content_sha256: hashFile(path), candidate_identity: freeze.identity });
  const identity = options.report?.agentIdentity(1);
  supervisor = new ExperimentSupervisor({ root: freeze.directory, env: sanitizeTrainingEnvironment(options.env, { pipelineRunId: identity?.pipelineRunId ?? undefined, stageInvocationId: identity?.stageInvocationId ?? undefined }),
   deliver: (_text, update) => options.report?.event("refit_process_update", { update }), record: options.report?.event,
   environmentFingerprint: freeze.environment.fingerprint, pipelineRunId: identity?.pipelineRunId ?? undefined, stageInvocationId: identity?.stageInvocationId ?? undefined });
  const workerDirectory = join(freeze.directory, "worker");
  const recordPath = join(workerDirectory, "experiment.json");
  let attached = false;
  if (existsSync(recordPath) || existsSync(join(workerDirectory, "worker-owner.json"))) {
   const receipt = existsSync(join(workerDirectory, "worker-owner.json")) ? json(join(workerDirectory, "worker-owner.json")) : undefined;
   const record = existsSync(recordPath) ? json(recordPath) : { id: "refit", pid: receipt.identity.pid, pgid: receipt.identity.pgid, directory: workerDirectory, logPath: join(workerDirectory, "output.log"), startedAt: new Date().toISOString(), hypothesis: "Terminal refit recovery", scope: "all labels", argv: [], cwd: freeze.sourceRoot };
   const statePath = join(workerDirectory, "supervisor-state.json");
   const state = existsSync(statePath) ? json(statePath) : {};
   const ownerPath = join(workerDirectory, "worker-owner.json");
   const owner = existsSync(ownerPath) ? json(ownerPath) : undefined;
   if (ownedProcessAlive(state.identity) || ownedProcessAlive(owner?.identity)) {
    if (ownedProcessAlive(state.identity) && ownedProcessAlive(owner?.identity) && state.identity.birth !== owner.identity.birth) throw new Error("Conflicting live refit ownership receipts; inspect recorded groups before retry");
    const identity = ownedProcessAlive(owner?.identity) ? owner.identity : state.identity;
    if (ownedProcessAlive(owner?.identity)) atomicJson(join(workerDirectory, "launch-released.json"), { token: owner.token });
    supervisor.attach({ ...record, pid: identity.pid, pgid: identity.pgid }, { ...state, identity, status: "running" });
    attached = true;
   } else if (liveGroup(record.pgid).length || (owner && liveGroup(owner.identity.pgid).length)) throw new Error("Refit descendants survive without verified leader; resolve recorded group before retry");
  }
  if (!attached && !existsSync(join(freeze.directory, "result.json"))) {
   options.signal?.throwIfAborted();
   const attemptPath = join(freeze.directory, "attempt.json");
   const attempt = existsSync(attemptPath) ? json(attemptPath).attempt + 1 : 1;
   if (attempt > 3) throw new Error("Refit retry limit exhausted; retained freeze and logs require inspection");
   atomicJson(attemptPath, { attempt });
   const token = randomUUID();
   mkdirSync(workerDirectory, { recursive: true });
   supervisor.start({ argv: [options.pythonExecutable, RUNNER, "--directory", workerDirectory, "--token", token, "--", options.pythonExecutable, WORKER, "--directory", freeze.directory],
    cwd: freeze.sourceRoot, hypothesis: "Terminal frozen champion refit", scope: "all original labelled rows; no independent sealed evidence" }, undefined, "refit", workerDirectory);
   atomicJson(join(workerDirectory, "launch-released.json"), { token });
   options.report?.event("refit_attempt_started", { candidate_identity: freeze.identity, attempt });
   attached = true;
  }
  if (attached) {
   while (supervisor.status("refit").status === "running") {
    if (options.signal?.aborted) { await supervisor.stop("refit", "refit cancelled"); options.signal.throwIfAborted(); }
    await Bun.sleep(50);
   }
   const view = supervisor.status("refit");
   if (view.exitCode !== 0 && !existsSync(join(freeze.directory, "result.json"))) throw new Error(`Refit worker did not complete (${view.status}); inspect ${view.logPath}`);
  }
  options.signal?.throwIfAborted();
  python(options, [WORKER, "--directory", freeze.directory, "--validate"]);
  validateFrozen(options, freeze);
  const result: TerminalRefitResult = json(join(freeze.directory, "result.json"));
  const artifacts = [["terminal_refit_freeze", "freeze.json"], ["terminal_refit_result", "result.json"], ["final_test_predictions", "predictions.csv"], ...(result.modelSerialization.status === "available" ? [["terminal_fitted_model", "model.pkl"]] : [])].map(([kind, name]) => ({ kind, path: join(freeze.directory, name), sha256: hashFile(join(freeze.directory, name)) }));
  options.report?.event("refit_artifacts_validated", { candidate_identity: freeze.identity, train_rows: freeze.data.trainRows, sealed_rows: freeze.data.sealedRows, test_rows: freeze.data.testRows });
  return { artifacts, validation: { valid: true, errors: [] } };
 } finally { await supervisor?.close(); release(); }
}
