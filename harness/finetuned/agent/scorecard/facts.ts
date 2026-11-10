/**
 * Reads the facts of one finetuned run. Read-only: files are only read, and git
 * runs with optional locks disabled so it never writes into the solutions
 * repository.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { validateReview } from "../evaluation/reviewer.js";
import { codeCensus, type CodeCensus } from "./code.js";
import { place, type ScorecardLayout } from "./layout.js";

type Json = Record<string, any>;
export interface JournalEntry { revision: number; at: number; kind: string; payload: Json }
export interface StageRun {
 invocationId: string; stage: string; role: "research" | "modelling" | "validation" | "handOver" | "other";
 status: string; outcome?: string; startedAt?: number; finishedAt?: number; durationMs?: number;
 /** The end is the last journal activity before the interruption was recorded. */
 endEstimated?: boolean; error?: string;
}
export interface TrialFact {
 experimentId: string; directory: string; invocationId: string;
 kind: "pilot" | "promotion" | "search" | "unknown"; status: string; startedAt?: number; durationSeconds?: number;
 score?: number; fitSeconds?: number; exitCode?: number; peakMemoryBytes?: number;
}
export interface ScriptObservation { command: string; durationSeconds?: number; peakMemoryBytes?: number; source: string }
export interface RunFacts {
 runsDir: string;
 run: { runId: string; taskId: string; status: string; reason?: string; startedAt: number; endedAt: number; durationMs: number; checksumValid: boolean; ended: boolean };
 stages: StageRun[];
 stageTotals: { stage: string; runs: number; totalMs: number }[];
 budget: { modelRequests: number; sessions: number; toolCalls: number; trialsCharged: number; retries: number;
  modelRequestsOutsideStages: number; modelRequestsDuringStages: number;
  /** Only when budget entries name their requester (`payload.source`). */
  orchestratorRequestsWhileWaiting?: number };
 firstModellingStart?: number; firstTrialStart?: number; minutesToFirstTrial?: number;
 trials: TrialFact[]; referencedTrials: TrialFact[]; championUnknown?: boolean; sealedUnknown?: boolean;
 champion?: { experimentId: string; commit: string; taggedAt?: number; inRun: boolean; score?: number; fitSeconds?: number; trialFound: boolean; module?: string; source?: string; kind?: string };
 sealed?: { status: string; score?: number; cvMean?: number; interval?: { lower: number; upper: number }; agrees?: boolean; at: number; inRun: boolean; path: string };
 handOver: { directory: string; deliveredAt?: number; files: string[]; rows?: number; inRun: boolean }[];
 reports: { stageReports: string[]; agentStagesNeedingReport: string[]; knowledgeNotes: number; knowledgeRevisions: number; unknownRevisionAuthors: number; validationReports: string[] };
 memory: { trialPeakBytes?: number; trialsWithMemory: number; scripts: ScriptObservation[] };
 code: CodeCensus;
 notes: string[];
}

const readJson = (path: string): Json | undefined => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const within = (path: string, root: string) => resolve(path) === resolve(root) || resolve(path).startsWith(resolve(root) + sep);

export function git(repository: string, args: string[]): string | undefined {
 const result = spawnSync("git", ["-C", repository, ...args], { encoding: "utf8", timeout: 10_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
 return result.status === 0 ? result.stdout : undefined;
}

/** Run directories of a task, newest first. */
export function listRuns(runsDir: string, task: string, layout: ScorecardLayout): { runId: string; startedAt: number }[] {
 const root = resolve(runsDir, place(layout.runsOfTask, { task }));
 if (!existsSync(root)) return [];
 return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(join(root, entry.name, layout.stateFile)))
  .map(entry => ({ runId: entry.name, startedAt: Number(readJson(join(root, entry.name, layout.stateFile))?.state?.startedAt ?? 0) }))
  .sort((a, b) => b.startedAt - a.startedAt);
}

/** Recursively collect the largest value of any peak-memory key. */
function peakBytes(value: unknown): number | undefined {
 let best: number | undefined;
 const visit = (node: unknown, depth: number) => {
  if (!node || typeof node !== "object" || depth > 6) return;
  for (const [key, item] of Object.entries(node)) {
   let bytes: number | undefined;
   if (typeof item === "number" && Number.isFinite(item) && item >= 0) {
    if (/^(peak(Rss|Memory)?Bytes|peak_(rss|memory)_bytes|maxRssBytes)$/.test(key)) bytes = item;
    else if (/^(peak(Rss|Memory)?(Mb|MB)|peak_(rss|memory)_mb|maxRssMb)$/.test(key)) bytes = item * 1024 ** 2;
   }
   if (bytes !== undefined) best = Math.max(best ?? 0, bytes);
   else visit(item, depth + 1);
  }
 };
 visit(value, 0);
 return best;
}

function trialDirectories(root: string, depth = 0): string[] {
 if (!existsSync(root) || depth > 3) return [];
 const found: string[] = [];
 for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "source" || entry.name.startsWith(".")) continue;
  const path = join(root, entry.name);
  if (existsSync(join(path, "request.json"))) found.push(path);
  else found.push(...trialDirectories(path, depth + 1));
 }
 return found;
}

function readTrial(directory: string, invocationId: string, metricKey: string, layout: ScorecardLayout): TrialFact {
 const request = readJson(join(directory, "request.json")) ?? {};
 const result = readJson(join(directory, "trial-result.json"));
 const exit = readJson(join(directory, "worker-exit.json"));
 const runtime = readJson(join(directory, "worker-runtime.json"));
 let startedAt: number | undefined;
 const events = join(directory, "events.jsonl");
 if (existsSync(events)) for (const line of readFileSync(events, "utf8").split("\n")) {
  try { const timestamp = JSON.parse(line).timestamp; if (typeof timestamp === "number") { startedAt = timestamp * 1000; break; } } catch { /* partial line */ }
 }
 startedAt ??= statSync(join(directory, "request.json")).mtimeMs;
 const kind = request.search ? "search" : request.scope?.kind === "pilot" || request.scope?.kind === "promotion" ? request.scope.kind : "unknown";
 const score = result?.metrics?.[metricKey];
 let peak: number | undefined;
 for (const name of layout.trialResourceFiles) { const value = peakBytes(readJson(join(directory, name))); if (value !== undefined) peak = Math.max(peak ?? 0, value); }
 return { experimentId: basename(directory), directory, invocationId, kind, status: typeof result?.status === "string" ? result.status : "unfinished",
  startedAt, durationSeconds: typeof runtime?.seconds === "number" ? runtime.seconds : undefined,
  score: typeof score === "number" && Number.isFinite(score) ? score : undefined, fitSeconds: typeof result?.diagnostics?.fitSeconds === "number" && Number.isFinite(result.diagnostics.fitSeconds) && result.diagnostics.fitSeconds >= 0 ? result.diagnostics.fitSeconds : undefined, exitCode: typeof exit?.exitCode === "number" ? exit.exitCode : undefined, peakMemoryBytes: peak };
}

function lineCount(path: string): number {
 const text = readFileSync(path, "utf8");
 return text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export function readRunFacts(options: { runsDir: string; task: string; runId: string; layout: ScorecardLayout; metricKey: string }): RunFacts {
 const { runsDir, task, runId, layout } = options;
 const notes: string[] = [];
 const statePath = resolve(runsDir, place(layout.runsOfTask, { task }), runId, layout.stateFile);
 const envelope = readJson(statePath);
 if (!envelope?.state) throw new Error(`No readable run state at ${statePath}`);
 const s = envelope.state as Json;
 const checksumValid = envelope.sha256 === hash(s);
 if (!checksumValid) notes.push("state.json checksum does not match its contents; facts are read as stored");
 const journal = (s.journal ?? []) as JournalEntry[];
 const terminal = ["finished", "cancelled", "blocked"].includes(s.status);
 const endedAt = Math.max(s.startedAt, ...journal.map(entry => entry.at));
 if (!terminal) notes.push(`Run status is "${s.status}": the run is still running or died without a final record; its end is the last journal entry`);

 // Stages: dispatch and completion come from the journal; results carry exact times when present.
 const roleOf = (stage: string): StageRun["role"] => (Object.entries(layout.stages).find(([role, names]) => role !== "agent" && names.includes(stage))?.[0] as StageRun["role"]) ?? "other";
 const dispatchedAt = new Map<string, number>(), completedAt = new Map<string, number>(), interruptedAt = new Map<string, number>();
 for (const entry of journal) {
  const id = entry.payload?.invocationId;
  if (typeof id !== "string") continue;
  if (entry.kind === "stage_dispatched" && !dispatchedAt.has(id)) dispatchedAt.set(id, entry.at);
  if (entry.kind === "stage_completed") completedAt.set(id, entry.at);
  if (entry.kind === "agent_invocation_interrupted") interruptedAt.set(id, entry.at);
 }
 const stages: StageRun[] = (s.works ?? []).map((work: Json) => {
  const startedAt = Date.parse(work.result?.startedAt ?? "") || dispatchedAt.get(work.id);
  let finishedAt = Date.parse(work.result?.finishedAt ?? "") || completedAt.get(work.id);
  let endEstimated = false;
  if (!finishedAt && startedAt) {
   const interrupted = interruptedAt.get(work.id);
   const last = journal.filter(entry => entry.at >= startedAt && (interrupted === undefined || entry.at < interrupted) && entry.kind !== "telemetry_execution_started").at(-1);
   finishedAt = last?.at; endEstimated = true;
  }
  return { invocationId: work.id, stage: work.stage, role: roleOf(work.stage), status: work.status, outcome: work.summary?.outcome ?? work.result?.outcome,
   startedAt, finishedAt, durationMs: startedAt && finishedAt ? finishedAt - startedAt : undefined, endEstimated: endEstimated || undefined,
   error: typeof work.summary?.error === "string" ? work.summary.error.slice(0, 200) : typeof work.summary?.reason === "string" ? work.summary.reason.slice(0, 200) : undefined };
 }).sort((a: StageRun, b: StageRun) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
 const stageTotals = [...new Set(stages.map(stage => stage.stage))].map(stage => ({ stage, runs: stages.filter(run => run.stage === stage).length,
  totalMs: stages.filter(run => run.stage === stage).reduce((sum, run) => sum + (run.durationMs ?? 0), 0) }));

 // Budget: every model request is charged as a journal entry; stage windows tell who could have made it.
 const windows = stages.filter(stage => stage.startedAt).map(stage => [stage.startedAt!, stage.finishedAt ?? endedAt] as const);
 const requests = journal.filter(entry => entry.kind === "budget_reserved" && entry.payload?.counter === "modelRequests");
 const during = requests.filter(entry => windows.some(([a, b]) => entry.at >= a && entry.at <= b));
 const sourced = requests.every(entry => typeof entry.payload?.source === "string") && requests.length > 0;
 const budget = { modelRequests: s.counters?.modelRequests ?? 0, sessions: s.counters?.sessions ?? 0, toolCalls: s.counters?.toolCalls ?? 0, trialsCharged: s.counters?.trials ?? 0, retries: s.counters?.retries ?? 0,
  modelRequestsOutsideStages: requests.length - during.length, modelRequestsDuringStages: during.length,
  ...(sourced ? { orchestratorRequestsWhileWaiting: during.filter(entry => entry.payload.source === "orchestrator").length } : {}) };

 // Trials: the training directories of this run's modelling stages, plus trials its artifacts name.
 const modelling = stages.filter(stage => stage.role === "modelling");
 const directories = new Map<string, string>();
 for (const stage of modelling) for (const directory of trialDirectories(resolve(runsDir, place(layout.trainingDir, { task, invocation: stage.invocationId })))) directories.set(directory, stage.invocationId);
 const artifacts: Json[] = [...(s.artifacts ?? []), ...(s.works ?? []).flatMap((w: Json) => w.result?.artifacts ?? [])];
 const referencedDirectories = new Set<string>();
 for (const artifact of artifacts) {
  if (typeof artifact.path !== "string" || !String(artifact.kind).startsWith("training_")) continue;
  const directory = resolve(dirname(artifact.path));
  if (existsSync(join(directory, "request.json")) && !directories.has(directory)) referencedDirectories.add(directory);
 }
 const referencedTrials = [...referencedDirectories].map(directory => readTrial(directory, basename(dirname(directory)), options.metricKey, layout));
 const trials = [...directories].map(([directory, invocation]) => readTrial(directory, invocation, options.metricKey, layout)).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
 const firstModellingStart = modelling.find(stage => stage.startedAt)?.startedAt;
 const firstTrialStart = trials.find(trial => trial.startedAt)?.startedAt;

 // Resolve selection from immutable run artifacts before consulting mutable tags.
 const solutions = resolve(runsDir, layout.solutionsRoot);
 let champion: RunFacts["champion"];
 let championUnknown = false;
 const selected = artifacts.filter(a => a.kind === "training_selected_result").at(-1);
 const selectedWork = [...(s.works ?? [])].reverse().find((w: Json) => w.summary?.selected_experiment_id);
 const selectedId = selected ? basename(dirname(selected.path)) : selectedWork?.summary?.selected_experiment_id;
 const tagName = place(layout.championTag, { task });
 const tagCommit = git(solutions, ["rev-parse", "--verify", "--quiet", `refs/tags/${tagName}^{commit}`])?.trim();
 let parsed: Json = {};
 try { parsed = JSON.parse(git(solutions, ["tag", "-l", "--format=%(contents)", tagName]) ?? "{}"); } catch { /* unknown tag */ }
 const date = git(solutions, ["for-each-ref", "--format=%(taggerdate:unix)%(committerdate:unix)", `refs/tags/${tagName}`])?.trim();
 const tagTime = date ? Number(date.slice(0, 10)) * 1000 : undefined;
 const historicalTag = tagCommit && tagTime !== undefined && tagTime <= endedAt + 1000;
 const experimentId = selectedId ?? (historicalTag ? parsed.experimentId : undefined);
 if (experimentId) {
  const trial = [...trials, ...referencedTrials].find(t => t.experimentId === experimentId)
   ?? (historicalTag && typeof parsed.trainingRoot === "string" && existsSync(join(parsed.trainingRoot, experimentId, "request.json"))
    ? readTrial(join(parsed.trainingRoot, experimentId), basename(parsed.trainingRoot), options.metricKey, layout) : undefined);
  const invocation = trial ? readJson(join(trial.directory, "invocation.json")) : undefined;
  const commit = invocation?.source?.commit ?? (historicalTag && parsed.experimentId === experimentId ? tagCommit : "unknown");
  const taggedAt = selectedId ? undefined : tagTime;
   const module = trial ? readJson(join(trial.directory, "request.json"))?.pipeline?.module : undefined;
   let source: string | undefined;
   if (typeof module === "string") {
    const path = module.startsWith(layout.solutionsModulePrefix) ? module.slice(layout.solutionsModulePrefix.length) : module;
    source = git(solutions, ["show", `${commit}:${path}`]);
    // Local modules the entrypoint imports, one level deep.
    if (source) for (const match of source.matchAll(/^\s*from\s+([\w.]+)\s+import|^\s*import\s+([\w.]+)/gm)) {
     const name = (match[1] ?? match[2]).replaceAll(".", "/");
     const extra = git(solutions, ["show", `${commit}:${name}.py`]) ?? git(solutions, ["show", `${commit}:${dirname(path)}/${name}.py`]);
     if (extra) source += `\n${extra}`;
    }
   }
   champion = { experimentId, commit, taggedAt, inRun: trials.some(t => t.experimentId === experimentId),
    score: trial?.score, fitSeconds: trial?.fitSeconds, trialFound: !!trial, module, source, kind: trial?.kind };
 } else if ((tagCommit && !historicalTag) || modelling.some(stage => stage.outcome === "success")) championUnknown = true;
 if (selectedId && !champion?.trialFound) championUnknown = true;

 // Sealed check: the confirmation pointer and its record.
 let sealed: RunFacts["sealed"];
 const pointerPath = resolve(runsDir, place(layout.confirmationPointer, { task }));
 const confirmationArtifact = artifacts.filter(a => a.kind === "holdout_confirmation").at(-1);
 const pointer = confirmationArtifact ?? readJson(pointerPath);
 let sealedUnknown = (!!confirmationArtifact && !readJson(confirmationArtifact.path)) || (!pointer?.path && modelling.some(stage => stage.outcome === "success"));
 if (pointer?.path && existsSync(pointer.path)) {
  const record = readJson(pointer.path) ?? {};
  const at = statSync(pointer.path).mtimeMs;
  const score = record.metrics?.[options.metricKey];
  const cvMean = typeof record.gap === "number" && typeof score === "number" ? score + record.gap : undefined;
  const interval = typeof record.interval?.lower === "number" && typeof record.interval?.upper === "number" ? { lower: record.interval.lower, upper: record.interval.upper } : undefined;
  sealed = { status: String(record.status ?? "unknown"), score, cvMean, interval, at, path: pointer.path,
   agrees: cvMean !== undefined && interval ? cvMean >= interval.lower && cvMean <= interval.upper : undefined,
   inRun: record.origin?.pipelineRunId ? record.origin.pipelineRunId === runId : at >= s.startedAt && at <= endedAt + 1000 };
 }

 // Hand-over: delivery directories; this run's are named by its artifacts or fall in its window.
 const deliveredPaths = new Set(((s.artifacts ?? []) as Json[]).filter(a => a.kind === "final_delivery").map(a => resolve(dirname(a.path))));
 const deliveriesRoot = resolve(runsDir, place(layout.deliveries, { task }));
 const handOver = existsSync(deliveriesRoot) ? readdirSync(deliveriesRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
  const directory = join(deliveriesRoot, entry.name);
  const manifest = readJson(join(directory, layout.handOverManifest));
  const deliveredAt = Date.parse(manifest?.deliveredAt ?? "") || undefined;
  const file = join(directory, layout.handOverFile);
  return { directory, deliveredAt, files: readdirSync(directory), rows: existsSync(file) ? lineCount(file) : undefined,
   inRun: deliveredPaths.has(resolve(directory)) || (deliveredAt !== undefined && deliveredAt >= s.startedAt && deliveredAt <= endedAt + 1000) };
 }) : [];

 // Stage reports and knowledge notes.
 const reportsDir = resolve(runsDir, place(layout.reportsDir, { task }));
 const ids = stages.map(stage => stage.invocationId);
 const reportFiles = existsSync(reportsDir) ? readdirSync(reportsDir).filter(name => ids.some(id => name.includes(id))).map(name => join(reportsDir, name)) : [];
 const fromArtifacts = ((s.artifacts ?? []) as Json[]).filter(a => a.kind === "stage_report").map(a => a.path as string);
 const stageReports = [...new Set([...reportFiles, ...fromArtifacts].map(path => resolve(path)))].filter(path => existsSync(path));
 const agentStagesNeedingReport = stages.filter(stage => layout.stages.agent.includes(stage.stage) && stage.status === "terminal" && stage.outcome !== "cancelled").map(stage => stage.invocationId);
 const index = readJson(resolve(runsDir, layout.knowledgeIndex));
 const notesList = (index?.notes ?? []) as Json[];
 const knowledgeNotes = notesList.filter(note => note.origin?.pipelineRunId === runId).length;
 const knowledgeRevisions = notesList.reduce((sum, note) => sum + ((note.revisions ?? []) as Json[]).filter(revision => revision.author?.pipelineRunId === runId).length, 0);
 const unknownRevisionAuthors = notesList.flatMap(note => note.revisions ?? []).filter(revision => !revision.author?.pipelineRunId).length;
 if (unknownRevisionAuthors) notes.push(`${unknownRevisionAuthors} knowledge revision(s) have unknown authorship`);
 const validationReports = artifacts.filter(a => a.kind === "evaluation_report").filter(a => {
  const r = readJson(a.path);
  if (!r || r.taskId !== task || r.validation?.valid !== true || !Array.isArray(r.validation.errors) || !r.metrics || !Array.isArray(r.sourceArtifacts)) return false;
  try { validateReview(r.review); return true; } catch { return false; }
 }).map(a => a.path);

 // Memory: trial records and P1's script observations, when present.
 const scripts: ScriptObservation[] = [];
 const observationRoots = [resolve(runsDir, task), solutions];
 const findObservationFiles = (root: string, depth = 0): string[] => !existsSync(root) || depth > 5 ? [] : readdirSync(root, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() && entry.name !== ".git" && entry.name !== "training" ? findObservationFiles(join(root, entry.name), depth + 1)
   : entry.isFile() && layout.scriptObservationFiles.includes(entry.name) ? [join(root, entry.name)] : []);
 for (const file of observationRoots.flatMap(root => findObservationFiles(root))) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
   let record: Json; try { record = JSON.parse(line); } catch { continue; }
   const at = typeof record.at === "number" ? record.at : Date.parse(record.at ?? record.startedAt ?? "");
   const mine = typeof record.pipelineRunId === "string" ? record.pipelineRunId === runId : Number.isFinite(at) && at >= s.startedAt && at <= endedAt + 1000;
   if (!mine) continue;
   const duration = typeof record.durationSeconds === "number" ? record.durationSeconds : typeof record.durationMs === "number" ? record.durationMs / 1000 : undefined;
   scripts.push({ command: String(record.command ?? record.argv ?? "?").slice(0, 120), durationSeconds: duration, peakMemoryBytes: peakBytes(record), source: file });
  }
 }
 const trialPeaks = trials.map(trial => trial.peakMemoryBytes).filter((value): value is number => value !== undefined);

 const dataFiles = [s.taskConfiguration?.configuration?.samples?.train, s.taskConfiguration?.configuration?.samples?.test, s.taskConfiguration?.configuration?.targets?.file].filter((name): name is string => typeof name === "string");
 const code = codeCensus({ runsDir, task, layout, window: { start: s.startedAt, end: endedAt }, dataFiles });
 if (code.changedAfterRun) notes.push(`${code.changedAfterRun} Python file(s) were changed after this run ended (a later run reused the folders); they are listed but not judged`);
 notes.push("Task folders and solutions/ are shared between runs; code is attributed by file modification time, which records only the last change");

 return {
  runsDir,
  run: { runId, taskId: s.taskId, status: s.status, reason: s.reason, startedAt: s.startedAt, endedAt, durationMs: endedAt - s.startedAt, checksumValid, ended: terminal },
  stages, stageTotals, budget, firstModellingStart, firstTrialStart,
  minutesToFirstTrial: firstModellingStart && firstTrialStart ? (firstTrialStart - firstModellingStart) / 60_000 : undefined,
  trials, referencedTrials, champion, championUnknown, sealed, sealedUnknown: sealedUnknown || (!!sealed && !sealed.inRun), handOver,
  reports: { stageReports, agentStagesNeedingReport, knowledgeNotes, knowledgeRevisions, unknownRevisionAuthors, validationReports },
  memory: { trialPeakBytes: trialPeaks.length ? Math.max(...trialPeaks) : undefined, trialsWithMemory: trialPeaks.length, scripts },
  code, notes,
 };
}
