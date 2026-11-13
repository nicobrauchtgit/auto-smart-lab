import { trialSupervisionDirectory } from "../training/results.js";
/**
 * Experiment and commit-bound references, resolved through stream B's trial
 * source service. Every trial of a task lives under
 * `<state>/<task>/solve/training/<training root>/.supervision/<experiment>/recovery.json`.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { readRecord } from "../experiments/safe_files.js";
import { collectTrainingTrial } from "../training/results.js";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveTrialSnapshot } from "../workspace/trial_source.js";
import { git, resolveCommit } from "../training/git.js";
import type { FindingRef, TrialSnapshot, TrialReviewContext } from "./contracts.js";

const EXPERIMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The training roots of one task, newest layout first; absent roots are skipped. */
export function taskTrialRoots(stateRoot: string, taskId: string): string[] {
 const parent = join(stateRoot, taskId, "solve", "training");
 if (!existsSync(parent)) return [];
 return readdirSync(parent).map(name => join(parent, name)).filter(path => statSync(path).isDirectory()).sort();
}

/**
 * resolved: the experiment's snapshot (or the file at its commit) was verified.
 * stale: the record was found but its source is missing or changed.
 * unresolved: no record to check against (unknown experiment, no repository).
 */
export type RefState = { status: "resolved" | "stale" | "unresolved"; reason?: string; snapshot?: TrialSnapshot };

export interface TrialResolver {
 /** The training root holding this experiment's receipt; throws on an unsafe or ambiguous ID. */
 locate(experimentId: string): string | undefined;
 /** B's resolver: verified (and, when absent, restored) immutable source. Throws when unknown or unverifiable. */
 snapshot(experimentId: string): Promise<TrialSnapshot>;
 /** Safe measured configuration, separate from source and unavailable sibling records. */
 review(experimentId: string): Promise<TrialReviewContext>;
 /** Status of an experiment or commit-bound file reference; other refs are not this resolver's concern. */
 status(ref: FindingRef): Promise<RefState>;
}

/**
 * `roots` lists the training roots to search (default: the task's roots under
 * the state root, read on every call). `solutionsRoot` is the shared tree that
 * commit-bound file references name. Results are cached per resolver, so a
 * snapshot is restored at most once per resolver.
 */
export function createTrialResolver(options: { roots: () => readonly string[]; solutionsRoot?: string }): TrialResolver {
 const cache = new Map<string, Promise<RefState>>();
 const locate = (experimentId: string) => {
  if (!EXPERIMENT_ID.test(experimentId)) throw new Error("Unsafe experiment ID");
  const found = options.roots().filter(root => existsSync(join(trialSupervisionDirectory(join(root, experimentId)), "recovery.json")));
  if (found.length > 1) throw new Error(`Experiment ${experimentId} is recorded in more than one training root`);
  return found[0];
 };
 const snapshot = async (experimentId: string) => {
  const root = locate(experimentId);
  if (!root) throw new Error(`No trial record for experiment ${experimentId}`);
  return await resolveTrialSnapshot(root, experimentId);
 };
 const reason = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200);
 const experiment = async (id: string): Promise<RefState> => {
  let root: string | undefined;
  try { root = locate(id); } catch (error) { return {status: "unresolved", reason: reason(error)}; }
  if (!root) return {status: "unresolved", reason: `no trial record for ${id}`};
  try { return {status: "resolved", snapshot: await resolveTrialSnapshot(root, id)}; }
  catch (error) { return {status: "stale", reason: reason(error)}; }
 };
 const file = (path: string, line: number, commit: string): RefState => {
  const repository = options.solutionsRoot;
  if (!repository || !existsSync(join(repository, ".git"))) return {status: "unresolved", reason: "no solutions repository"};
  if (!/^[0-9a-f]{7,64}$/i.test(commit)) return {status: "stale", reason: "malformed commit"};
  if (!resolveCommit(repository, commit)) return {status: "stale", reason: `commit ${commit} not in the solutions repository`};
  // Scout citations are stored relative to the state root; the repository names paths relative to itself.
  const inside = relative(repository, resolve(repository, path.startsWith("solutions/") ? path.slice("solutions/".length) : path)).split(sep).join("/");
  if (!inside || inside === ".." || inside.startsWith("../") || isAbsolute(inside)) return {status: "stale", reason: "path outside the solutions repository"};
  const shown = git(repository, ["show", `${commit}:${inside}`]);
  if (shown.status !== 0) return {status: "stale", reason: `${inside} absent at ${commit.slice(0, 12)}`};
  if (shown.stdout.split("\n").length < line) return {status: "stale", reason: `${inside} has fewer than ${line} lines at ${commit.slice(0, 12)}`};
  return {status: "resolved"};
 };
 const status = (ref: FindingRef): Promise<RefState> => {
  const key = JSON.stringify(ref);
  if (!cache.has(key)) cache.set(key, "experiment" in ref && !("check" in ref) ? experiment(ref.experiment)
   : "file" in ref && ref.commit ? Promise.resolve(file(ref.file, ref.line, ref.commit))
   : Promise.reject(new Error("Not an experiment or commit-bound reference")));
  return cache.get(key)!.then(value => { if (value.status !== "resolved") cache.delete(key); return value; }, error => { cache.delete(key); throw error; });
 };
 const review = async (experimentId: string): Promise<TrialReviewContext> => {
  const frozen = await snapshot(experimentId), root = locate(experimentId)!;
  const directory = join(root, experimentId);
  const receipt = JSON.parse(readRecord(join(trialSupervisionDirectory(directory), "recovery.json")) ?? "");
  const invocation = readRecord(join(directory, "invocation.json"));
  if (!invocation || createHash("sha256").update(invocation).digest("hex") !== receipt.invocationHash)
   throw new Error("Measured review invocation identity mismatch");
  const measured = await collectTrainingTrial(directory);
  const source = measured.invocation?.source as {commit?: string; tree?: string} | undefined;
  if (!measured.eligible || !measured.request || source?.commit !== frozen.commit || source.tree !== frozen.tree)
   throw new Error("Measured review requires completed eligible evidence matching the snapshot");
  const measurement = measured.invocation?.measurement as {execution?: string} | undefined;
  if (measurement?.execution !== "inductive" && measurement?.execution !== "batch")
   throw new Error("Measured review lacks an execution contract");
  // Parsing in collectTrainingTrial fixes search winners and rejects unexpected request fields.
  // Copy explicitly; never forward the raw invocation, inputs, predictions or private feedback.
  return structuredClone({experimentId, commit: frozen.commit, tree: frozen.tree,
   pipeline: measured.request.pipeline, cv: measured.request.cv,
   coverage: {requestedFolds: measured.result!.requestedFolds!, completedFolds: measured.result!.completedFolds!},
   execution: measurement.execution});
 };
 return {locate, snapshot, status, review};
}

/** Whether this resolver decides the reference (experiment or commit-bound file). */
export function trialBound(ref: FindingRef): boolean {
 return ("experiment" in ref && !("check" in ref)) || ("file" in ref && !!ref.commit);
}

/** One line per reference for a scout's opening: the lead's refs with what the harness found. */
export async function describeRefs(refs: readonly FindingRef[], resolver?: TrialResolver): Promise<string> {
 if (!refs.length) return "none";
 const lines: string[] = [];
 for (const ref of refs) {
  const text = JSON.stringify(ref);
  if (!trialBound(ref)) { lines.push(`- ${text}`); continue; }
  const state = resolver ? await resolver.status(ref) : {status: "unresolved" as const, reason: "no trial records available"};
  lines.push(`- ${text}: ${state.status}${state.snapshot ? ` (commit ${state.snapshot.commit.slice(0, 12)})` : state.reason ? ` (${state.reason})` : ""}`);
 }
 return lines.join("\n");
}
