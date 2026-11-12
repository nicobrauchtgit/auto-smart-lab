/**
 * The v2 lead (expert-team-v2.md sections 2, 4 and 5): one agent session that
 * drives a task from the first look at the data to the hand-over.
 *
 * The harness here only serves tools and guards: harness-owned trials with
 * `trial_smoke` and live observation, blocking scouts, the supervised bash,
 * trial feedback after every trial (folds, noise verdict, the Ladder holdout
 * check on a new champion), the lead's tool-call budget with its counter and
 * finish-up turn, `hand_over` with one validation scout, the budget-end
 * hand-over, PROGRESS.json for resumption and compaction, and the
 * deterministic terminal refit.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { prepareLeadPrompts } from "../prompts/lead.js";
export { taskContract } from "../prompts/lead.js";
import { HARNESS_CONFIG } from "../harness/config.js";
import { ARM_ROOT, statePath } from "../paths.js";
import { PROJECT_ROOT, resolveTask } from "../pipeline/resolve_task.js";
import type { InvocationFeedback } from "../pipeline/feedback.js";
import { guidanceBlock, type StageGuidance } from "../pipeline/guidance.js";
import type { SetupSession } from "../pipeline/setup.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";
import type { StageArtifact, StageReporter } from "../pipeline/types.js";
import type { Telemetry } from "../telemetry/runtime.js";
import { loadPromptSnapshot, type PromptSnapshot, type RenderedPrompt } from "../prompts/loader.js";
import { runConfirmation, type ConfirmationOutput } from "../confirmation/service.js";
import type { ExperimentView, Wakeable } from "../experiments/index.js";
import { readCourseResources } from "../research/resources.js";
import type { SolveWorkspace } from "../solve/workspace.js";
import { prepareTaskData } from "../solve/task_data.js";
import type { TaskData, TrialSnapshot } from "../team/contracts.js";
import { ScoutBudget } from "../team/budget.js";
import { createScouts, finalBullets, validationKind, type ScoutReport, type ScoutRequest } from "../team/scouts.js";
import { createScoutRunner } from "../team/runner.js";
import { createTrialResolver, taskTrialRoots } from "../team/trials.js";
import { stageScoutInputs } from "../team/workspace.js";
import { collectTrainingResults, createGitHistoryGuard, createHarnessTraining, ensureSolutionsRepository, type TrainingCollection } from "../training/index.js";
import { championSelection, championTag, handoverChampion } from "../training/development_selection.js";
import { readSeedPlan } from "../training/seeds.js";
import { resolveTrialSnapshot } from "../training/trial_source.js";
import { trialSupervisionDirectory } from "../training/results.js";
import { readRecord } from "../experiments/safe_files.js";
import { selectionSummary } from "../training/selection_summary.js";
import { finishFollowUp, recoverFollowUp, startFollowUp } from "../training/branches.js";
import { GIT_BLOCK_PROMPT_IDS } from "../training/git_guard.js";
import { tagMessage } from "../training/git.js";
import { readPythonEnvironment, type PythonEnvironment } from "./python_environment.js";
import { expertSandbox } from "./sandbox.js";
import { isolatedSolveTools, solvePythonEnvironmentTool, trainingSandboxCommand, type SolveSandbox } from "./solve_sandbox.js";
import { runSession } from "./session_runner.js";
import { oneLine, readProgress, renderProgress, writeProgress, type LeadHandOver, type LeadProgress } from "./lead_progress.js";

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

/** Development sample bytes plus the manifest that identifies them and their targets. */
export function datasetFingerprint(workspace: Pick<SolveWorkspace, "devZip" | "sampleManifestPath">): string {
 return createHash("sha256").update(readFileSync(workspace.devZip)).update(readFileSync(workspace.sampleManifestPath)).digest("hex");
}

/** The selected trial's primary development metric, named by the task configuration. */
export function primaryMetric(workspace: Pick<SolveWorkspace, "configuration">, metrics: Record<string, unknown> | undefined): Record<string, unknown> {
 const name = metricKey(workspace.configuration);
 return name ? { name: workspace.configuration.metric, value: metrics?.[name] } : { name: "none" };
}
const metricKey = (configuration: TaskConfiguration) => configuration.metric === "balanced_accuracy" ? "balancedAccuracy"
 : configuration.metric === "adjusted_rand_index" ? "adjustedRandIndex" : undefined;

export function workerEnvironment(python: PythonEnvironment): Record<string, string> {
 const values: Record<string, string | undefined> = {
  PATH: `${join(python.prefix, "bin")}${delimiter}${process.env.PATH ?? ""}`,
  VENV_DIR: python.prefix, VIRTUAL_ENV: python.prefix, UV_PROJECT_ENVIRONMENT: python.prefix,
  UV_PYTHON: python.executable, UV_PYTHON_DOWNLOADS: "never", PYTHONNOUSERSITE: "1",
  LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
  // nix-ld runs uv's standalone Python on NixOS; absent elsewhere.
  NIX_LD: process.env.NIX_LD, NIX_LD_LIBRARY_PATH: process.env.NIX_LD_LIBRARY_PATH,
  LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TMPDIR: process.env.TMPDIR,
 };
 return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/**
 * A training root left active by an interrupted run of another invocation is
 * recovered rather than abandoned; otherwise this run gets its own root.
 */
export function recoveryTrainingRoot(parent: string, runId: string): string {
 const candidates: string[] = [];
 if (existsSync(parent)) for (const rootName of readdirSync(parent)) {
  const root = join(parent, rootName);
  if (!statSync(root).isDirectory()) continue;
  for (const id of readdirSync(root)) {
   const path = join(trialSupervisionDirectory(join(root, id)), "recovery.json");
   if (!existsSync(path)) {
    if (existsSync(join(root, id, "recovery.json"))) throw new Error(`Legacy worker-writable recovery record at ${join(root, id)}; inspect before migration.`);
    continue;
   }
   try {
    const meta = JSON.parse(readRecord(path) ?? "");
    const read = (name: string) => existsSync(join(root, id, name)) ? JSON.parse(readRecord(join(root, id, name)) ?? "") : {};
    if (meta.lifecycle === "active" && !JSON.parse(readRecord(join(trialSupervisionDirectory(join(root, id)), "supervisor-state.json")) ?? "{}").stopReason && !read("search-report.json").stopReason) candidates.push(root);
   } catch { throw new Error(`Corrupt recovery state at ${path}; restore it before restarting the lead.`); }
  }
 }
 const unique = [...new Set(candidates)];
 if (unique.length > 1) throw new Error(`Multiple interrupted training workspaces: ${unique.join(", ")}. Resume them individually before a new lead run.`);
 return unique[0] ?? join(parent, runId);
}

/**
 * Wake target of the lead: while its session runs, news (trial results,
 * supervision findings) is steered into the running turn; while it waits,
 * news queues here and wakes it. Nothing else wakes it.
 */
export class LeadInbox implements Wakeable {
 private items: string[] = [];
 private waiters: (() => void)[] = [];
 constructor(private session?: Wakeable) {}
 bind(session: Wakeable) { this.session = session; }
 get isStreaming() { return this.session?.isStreaming ?? false; }
 async steer(text: string): Promise<void> {
  if (this.session?.isStreaming) await this.session.steer(text);
  else this.push(text);
 }
 async sendCustomMessage(message: Parameters<Wakeable["sendCustomMessage"]>[0], options?: Parameters<Wakeable["sendCustomMessage"]>[1]): Promise<void> {
  if (this.session?.isStreaming) await this.session.sendCustomMessage(message, options);
  else this.push(message.content);
 }
 push(text: string) { this.items.push(text); this.notify(); }
 take(): string[] { return this.items.splice(0); }
 get size() { return this.items.length; }
 notify() { for (const wake of this.waiters.splice(0)) wake(); }
 /** Resolves on news or a state change, or after `ms` so the caller can look again. */
 wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(accept => {
   const timer = setTimeout(done, ms);
   function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); accept(); }
   this.waiters.push(done);
   signal?.addEventListener("abort", done, { once: true });
  });
 }
}

export interface LeadScouts {
 tool: ToolDefinition;
 report(request: ScoutRequest, signal?: AbortSignal, toolCallId?: string): Promise<ScoutReport>;
}
export interface LeadScoutContext {
 data: TaskData; python: PythonEnvironment; runId: string; invocationId: string;
 parentAgentRunId(): string | undefined;
}
export interface LeadRefitInput {
 taskId: string; configuration: TaskConfiguration; experimentId: string; reviewPath: string;
 model?: string; signal?: AbortSignal; report?: StageReporter;
}
export interface LeadDependencies {
 prepareData(taskId: string, configuration: TaskConfiguration, seed?: number): TaskData;
 readPython(): PythonEnvironment;
 sandbox(data: TaskData, python: PythonEnvironment): SolveSandbox;
 prepareRepository: typeof ensureSolutionsRepository;
 createTraining: typeof createHarnessTraining;
 runAgentSession: typeof runSession;
 environmentTool: typeof solvePythonEnvironmentTool;
 scouts(context: LeadScoutContext): LeadScouts;
 confirm: typeof runConfirmation;
 refit(input: LeadRefitInput): Promise<{ artifacts: StageArtifact[]; validation: { valid: boolean; errors: string[] } }>;
 collectResults: typeof collectTrainingResults;
 verifiedCandidate(repository: string, taskId: string, datasetSha256: string): Promise<TrialSnapshot>;
 /** How long to wait between looks at running trials when nothing arrives. */
 pollMs: number;
}

export interface RunLeadOptions {
 taskConfiguration: TaskConfiguration;
 model?: string;
 prompts?: PromptSnapshot;
 report?: StageReporter;
 signal?: AbortSignal;
 /** Invocation identity for a new run; a resumed run keeps the run ID its PROGRESS.json records. */
 runId?: string;
 seed?: number;
 foldPolicy?: "auto" | { folds: number; repeats: number };
 guidance?: StageGuidance;
 feedback?: InvocationFeedback;
 /** Setup checks this run already passed and the shared telemetry, for the scouts' preflight. */
 setup?: { session: SetupSession; telemetry: Telemetry };
 maxToolCalls?: number;
 /** Default: runs/finetuned/<task>/lead/PROGRESS.json. */
 progressPath?: string;
 dependencies?: Partial<LeadDependencies>;
}

export type LeadStopReason = "handed_over" | "no_champion" | "refit_failed" | "cancelled" | "validation_failed";
export interface LeadRunResult {
 progress: LeadProgress;
 stopReason: LeadStopReason;
 valid: boolean;
 errors: string[];
 collection: TrainingCollection;
 configuration: TaskConfiguration;
 trainingRoot: string;
 confirmation?: ConfirmationOutput;
 refitArtifacts: StageArtifact[];
 sessionError?: string;
 resumed: boolean;
}

const DEFAULT_DEPENDENCIES: LeadDependencies = {
 prepareData: (taskId, configuration, seed) => prepareTaskData(taskId, configuration, seed === undefined ? {} : { seed }),
 readPython: readPythonEnvironment,
 sandbox: (data, python) => expertSandbox(data, "lead", python),
 prepareRepository: ensureSolutionsRepository,
 createTraining: createHarnessTraining,
 runAgentSession: runSession,
 environmentTool: solvePythonEnvironmentTool,
 scouts: () => { throw new Error("Scouts need the stage's setup session and telemetry"); },
 confirm: runConfirmation,
 refit: async input => {
  const { refitInputs } = await import("../pipeline/stages/refit.js");
  const { runRefit } = await import("../refit/service.js");
  return runRefit({ ...refitInputs(input.taskId, input.configuration), model: input.model, reviewPath: input.reviewPath,
   expectedExperimentId: input.experimentId, ...(input.signal ? { signal: input.signal } : {}), ...(input.report ? { report: input.report } : {}) });
 },
 verifiedCandidate: async (repository, taskId, datasetSha256) => {
  const collection = await championSelection({ trials: [], valid: false, errors: [], artifacts: [] }, repository, taskId);
  if (!collection.valid || !collection.selected) throw new Error("Champion has no completed eligible measurement");
  const trial = collection.selected;
  const seedPlan = await readSeedPlan(join(trial.directory, "seed-plan.json"));
  if (seedPlan.taskId !== taskId || seedPlan.datasetSha256 !== datasetSha256) throw new Error("Champion measurement belongs to different task data");
  return resolveTrialSnapshot(dirname(trial.directory), trial.experimentId);
 },
 collectResults: collectTrainingResults,
 pollMs: 5_000,
};

/** Production scouts for the lead: stream C's blocking scouts on stream B's task data. */
export function productionScouts(options: { prompts: PromptSnapshot; taskId: string; configuration: TaskConfiguration; report: StageReporter;
 setup: { session: SetupSession; telemetry: Telemetry } }) {
 return (context: LeadScoutContext): LeadScouts => {
  const task = resolveTask({ taskId: options.taskId });
  const inputs = stageScoutInputs(context.data, readCourseResources(task.unitSlug));
  const runner = createScoutRunner({ prompts: options.prompts, taskId: options.taskId, taskConfiguration: options.configuration,
   telemetry: options.setup.telemetry, record: options.report.event, setup: options.setup.session,
   scoutPaths: { journal: statePath(PROJECT_ROOT, options.taskId, "findings", "journal.jsonl"),
    unitIntro: join(dirname(task.taskDir), "unit-intro.md"), task: context.data.taskPath, profile: context.data.profilePath },
   sandbox: (role, trial) => expertSandbox(context.data, role, context.python, trial), solutionsRoot: context.data.solutionsRoot,
   observe: options.report.observation(1), parentAgentRunId: () => context.parentAgentRunId() ?? context.invocationId });
  return createScouts({ prompts: options.prompts, taskId: options.taskId, task: readFileSync(context.data.taskPath, "utf8"),
   dataPaths: inputs.dataPaths, resources: inputs.resources, journalPath: statePath(PROJECT_ROOT, options.taskId, "findings", "journal.jsonl"),
   datasetSha256: context.data.datasetSha256, runId: context.runId, invocationId: context.invocationId,
   trials: createTrialResolver({ roots: () => taskTrialRoots(statePath(PROJECT_ROOT), options.taskId), solutionsRoot: context.data.solutionsRoot }),
   solutionsRoot: context.data.solutionsRoot, prepare: runner.prepare, run: runner });
 };
}

/** The task's champion as its tag records it, or undefined. */
export function championOf(solutionsRoot: string, taskId: string): { experimentId: string; commit: string; score?: number } | undefined {
 if (!existsSync(join(solutionsRoot, ".git"))) return undefined;
 const tag = tagMessage(solutionsRoot, championTag(taskId));
 if (!tag) return undefined;
 try {
  const message = JSON.parse(tag.message) as { experimentId?: unknown; balancedAccuracy?: unknown; adjustedRandIndex?: unknown };
  if (typeof message.experimentId !== "string") return undefined;
  const score = [message.balancedAccuracy, message.adjustedRandIndex].find((value): value is number => typeof value === "number");
  return { experimentId: message.experimentId, commit: tag.commit, ...(score !== undefined ? { score } : {}) };
 } catch { return undefined; }
}

/** Validation scout bullets sorted by label: fix (defects), advice, ok. */
export function validationSummary(report: ScoutReport | undefined): LeadHandOver["validation"] {
 if (!report) return { status: "not_run", fix: [], advice: [], ok: [] };
 const bullets = finalBullets(report.text, "", { labelled: true }).filter(Boolean).map(bullet => bullet.replace(/^- /, ""));
 const pick = (kind: string) => bullets.filter(bullet => validationKind(bullet) === kind);
 return { status: report.roles[0]?.status ?? "failed", fix: pick("defect"), advice: pick("idea"), ok: pick("fact") };
}

export function validationPassed(value: LeadHandOver["validation"]): boolean {
 return value.status === "completed" && value.fix.length === 0 && value.ok.length + value.advice.length > 0;
}

export async function runLeadSession(taskId: string, options: RunLeadOptions): Promise<LeadRunResult> {
 const deps: LeadDependencies = { ...DEFAULT_DEPENDENCIES, ...options.dependencies };
 const prompts = options.prompts ?? loadPromptSnapshot();
 const report = options.report;
 const record = (type: string, payload: Record<string, unknown>) => report?.event(type, payload);
 const identity = report?.agentIdentity(1);
 const configuration = options.taskConfiguration;
 const data = deps.prepareData(taskId, configuration, options.seed);
 const progressPath = options.progressPath ?? statePath(PROJECT_ROOT, taskId, "lead", "PROGRESS.json");
 const prior = readProgress(progressPath);
 if (prior && prior.taskId !== taskId) throw new Error("Lead progress belongs to another task");
 if (prior?.datasetSha256 && prior.datasetSha256 !== data.datasetSha256) throw new Error("Lead progress dataset changed; restore its task state before resuming");
 const resumed = prior && (prior.status === "running" || prior.status === "handing_over") ? prior : undefined;
 const invocationId = identity?.stageInvocationId ?? options.runId ?? randomUUID();
 const runId = resumed?.runId ?? options.runId ?? invocationId;
 const limit = resumed?.budget.limit ?? options.maxToolCalls ?? HARNESS_CONFIG.team.lead.maxToolCalls;
 const trainingRoot = resumed?.trainingRoot ?? recoveryTrainingRoot(join(data.root, "training"), runId);
 const now = () => new Date().toISOString();
 const progress: LeadProgress = resumed ?? { schemaVersion: 1, taskId, datasetSha256: data.datasetSha256, runId, trainingRoot, status: "running", startedAt: now(), sessions: [],
  trials: [], holdout: [], budget: { limit, used: 0 }, scoutCalls: 0 };
 progress.sessions.push({ startedAt: now(), invocationId });
 progress.budget.limit = limit;
 const save = () => writeProgress(progressPath, progress);
 save();
 record("lead_run_started", { run_id: runId, resumed: !!resumed, progress_path: progressPath, training_root: trainingRoot,
  budget: progress.budget, trials: progress.trials.length, prior_status: prior?.status });

 const foldPolicy = options.foldPolicy ?? HARNESS_CONFIG.solve.foldPolicy;
 const shape = foldPolicy !== "auto" ? foldPolicy : { folds: data.recommendation.folds, repeats: data.recommendation.repeats };
 const python = deps.readPython();
 const sandbox = deps.sandbox(data, python);
 const agentRoot = join(data.root, "agent");
 mkdirSync(agentRoot, { recursive: true });
 const boundaryFingerprint = sha256(JSON.stringify({ version: 1, mechanism: "bubblewrap_mount_pid_user_namespaces",
  executable: sandbox.executable, cwd: sandbox.cwd, mounts: sandbox.mounts, environment: sandbox.env,
  sandbox_script_sha256: sha256(readFileSync(join(ARM_ROOT, "agent/run/solve_sandbox.ts"))),
  sandbox_scratch_sha256: sha256(readFileSync(join(ARM_ROOT, "agent/run/sandbox_scratch.py"))),
  tool_worker_sha256: sha256(readFileSync(join(ARM_ROOT, "agent/run/solve_tool_worker.ts"))) }));
 const fingerprint = datasetFingerprint(data);
 const repository = deps.prepareRepository(data.solutionsRoot);
 // A follow-up run starts against the task's existing champion.
 const initialChampion = progress.champion ? undefined : championOf(data.solutionsRoot, taskId);
 if (initialChampion) { progress.champion = initialChampion; save(); }
 report?.input({ kind: "task_prompt", version: 1, delivery: "initial_prompt", status: "available", artifact: data.taskPath, content_sha256: sha256(readFileSync(data.taskPath)) });
 report?.input({ kind: "training_dataset", version: 1, delivery: "tool", status: "available", artifact: data.devZip, dataset_sha256: fingerprint,
  sample_manifest: data.sampleManifestPath, measurement: data.measurement, task_kind: configuration.kind, holdout: data.split.scheme,
  rows: data.rowCount, sealed_rows: data.split.sealedIds.length });
 report?.input({ kind: "python_environment", version: 1, delivery: "tool", status: "available", artifact: join(ARM_ROOT, "uv.lock"),
  content_sha256: python.fingerprint, python_version: python.python_version, executable: python.executable });
 report?.input({ kind: "solutions_repository", version: 1, delivery: "workspace_file", status: "available", artifact: data.solutionsRoot,
  initialized: repository.initialized, head_commit: repository.head, branch: repository.branch });
 report?.input({ kind: "solve_filesystem_boundary", version: 1, delivery: "tool", status: "available", artifact: agentRoot,
  content_sha256: boundaryFingerprint, mechanism: "bubblewrap_mount_pid_user_namespaces",
  read_only: sandbox.mounts.filter(mount => !mount.writable).map(mount => mount.source), writable: sandbox.mounts.filter(mount => mount.writable).map(mount => mount.source) });
 report?.input({ kind: "lead_progress", version: 1, delivery: resumed ? "initial_prompt" : "none", status: "available", artifact: progressPath, resumed: !!resumed });
 record("harness_configuration", { version: 1, defaults: HARNESS_CONFIG, lead: { maxToolCalls: limit }, foldRecommendation: shape });

 const budget = new ScoutBudget(limit, prompts, { freeTools: ["hand_over"], maxTurns: limit * 20 + 20, finishPrompt: "team.lead-finish", used: progress.budget.used, onCharge: used => { progress.budget.used = used; save(); } });
 const inbox = new LeadInbox();
 progress.phase ??= progress.baseline ? "improvement" : "baseline";
 progress.validationReceipts ??= {};
 let confirmation: ConfirmationOutput | undefined;
 let leadAgentRunId: string | undefined;
 let composing = 0, idleStreak = 0;
 let streak = 0;
 for (const trial of progress.trials) streak = trial.becameChampion ? 0 : trial.status === "completed" ? streak + 1 : streak;
 let handOver: LeadHandOver | undefined = resumed?.status === "handing_over" ? resumed.handOver : undefined;

 // ---- trials, feedback and the Ladder holdout check ----
 let training: ReturnType<typeof createHarnessTraining> | undefined;
 const runningTrials = () => (training?.supervisor?.list?.() ?? []).filter(view => view.status === "running");
 const holdoutDone = (experimentId: string) => progress.holdout.some(row => row.experimentId === experimentId);
 const holdoutText = (row: LeadProgress["holdout"][number]) => row.status === "completed"
  ? prompts.render("team.lead-holdout-result", { verdict: row.verdict ?? "no verdict", queries: String(row.queryCount ?? 0),
   detail: row.score !== undefined ? `: score ${row.score.toFixed(4)}` : "" }).text
  : prompts.render("team.lead-holdout-skipped", { reason: row.reason ?? row.status }).text;
 /** One counted Ladder query on the current champion; the withheld labels stay in the controller. */
 const runHoldout = async (experimentId: string): Promise<string> => {
  const existing = progress.holdout.find(row => row.experimentId === experimentId);
  if (existing) return holdoutText(existing);
  let row: LeadProgress["holdout"][number];
  if (!data.holdoutSeedPlan || !data.split.sealedIds.length) row = { experimentId, status: "skipped", reason: data.split.confirmation?.reason ?? "this task has no withheld rows" };
  else try {
   const output = await deps.confirm({ workspace: data, pythonExecutable: python.executable, environmentFingerprint: python.fingerprint,
    env: workerEnvironment(python), report, ...(options.signal ? { signal: options.signal } : {}),
    sandboxCommand: (command, input) => trainingSandboxCommand(sandbox, command, input) });
   confirmation = output;
   const summary = output.summary as { status?: string; verdict?: string; score?: number; queryCount?: number; reason?: string };
   row = summary.status === "completed"
    ? { experimentId, status: "completed", verdict: summary.verdict, queryCount: summary.queryCount, ...(typeof summary.score === "number" ? { score: summary.score } : {}) }
    : { experimentId, status: "skipped", reason: summary.reason ?? "confirmation skipped" };
  } catch (error) {
   options.signal?.throwIfAborted();
   row = { experimentId, status: "failed", reason: (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 200) };
  }
  progress.holdout.push(row);
  save();
  record("lead_holdout_check", { ...row });
  return holdoutText(row);
 };
 const folds = (described: Record<string, any>) => {
  const key = metricKey(configuration);
  const scores: number[] = (described.foldScores ?? []).map((row: any) => row?.metrics?.[key ?? ""]).filter((value: unknown): value is number => typeof value === "number");
  if (!scores.length) return "no completed folds";
  const mean = scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const sd = Math.sqrt(scores.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, scores.length - 1));
  return `${scores.map(value => value.toFixed(4)).join(", ")}; mean ${mean.toFixed(4)}, sd ${sd.toFixed(4)} (${configuration.metric})`;
 };
 let feedbackChain: Promise<unknown> = Promise.resolve();
 const trialFinished = (id: string, view: ExperimentView) => {
  composing++;
  const work = feedbackChain.then(async () => {
   const described = (training?.service.describe(id) ?? {}) as Record<string, any>;
   const prior = progress.trials.find(row => row.experimentId === id);
   // Completion feedback is durable. Replay only the interruption gap; the
   // authoritative champion is reconciled separately even for known results.
   if (prior?.feedbackRecorded && prior.status === String(described.status ?? view.status)) return;
   const before = progress.champion?.experimentId;
   const champion = championOf(data.solutionsRoot, taskId);
   const key = metricKey(configuration);
   let trial = progress.trials.find(row => row.experimentId === id);
   if (!trial) progress.trials.push(trial = { experimentId: id, hypothesis: oneLine(String(described.hypothesis ?? view.hypothesis ?? "")), status: "running", startedAt: now() });
   trial.status = String(described.status ?? view.status);
   trial.finishedAt = now();
   const score = key ? described[key] : undefined;
   if (typeof score === "number") trial.score = score;
   const comparison = described.championComparison as { status?: string } | undefined;
   if (comparison?.status === "completed") trial.verdict = String(described.noiseVerdict);
   const isNew = champion?.experimentId === id && before !== id;
   trial.becameChampion = trial.becameChampion || isNew;
   if (champion) progress.champion = { experimentId: champion.experimentId, commit: champion.commit, ...(champion.score !== undefined ? { score: champion.score } : {}) };
   streak = isNew ? 0 : trial.status === "completed" ? streak + 1 : streak;
   let holdout = prompts.render("team.lead-holdout-none", {}).text;
   if (champion && !holdoutDone(champion.experimentId)) {
    if (runningTrials().length) holdout = isNew ? prompts.render("team.lead-holdout-deferred", {}).text : holdout;
    else holdout = `${isNew ? "" : `champion ${champion.experimentId}: `}${await runHoldout(champion.experimentId)}`;
   }
   const verdict = comparison?.status === "completed" ? String(described.noiseVerdict)
    : before ? String(described.noiseVerdict ?? "no completed paired comparison") : "no earlier champion to compare with";
   const cost = `${Math.round(view.elapsedSeconds)} s${view.peakRssMb ? `, peak memory ${Math.round(view.peakRssMb)} MiB` : ""}`;
   const status = [trial.status, described.error ? `error: ${String(described.error.message ?? described.error).split("\n")[0].slice(0, 300)}` : "",
    described.promotionIneligibleReason ? `not eligible for promotion: ${String(described.promotionIneligibleReason).slice(0, 200)}` : "",
    view.stopReason ? `stopped: ${view.stopReason.slice(0, 200)}` : ""].filter(Boolean).join("; ");
   const text = prompts.render("team.lead-trial", { experiment: id, status, hypothesis: trial.hypothesis || "(none)", folds: folds(described), verdict,
    champion: champion ? `${champion.experimentId}${isNew ? " (this trial, new)" : ""}${champion.score !== undefined ? `, ${champion.score.toFixed(4)}` : ""}` : "none yet",
    holdout, cost, streak: String(streak), budget: `${budget.used} of ${budget.limit} used` }).text;
   trial.feedbackRecorded = true;
   save();
   record("lead_trial_feedback", { experiment_id: id, status: trial.status, score: trial.score, became_champion: isNew, champion: champion?.experimentId, streak, text });
   await inbox.steer(text);
  }).catch(error => record("lead_trial_feedback_failed", { experiment_id: id, message: error instanceof Error ? error.message : String(error) }))
   .finally(() => { composing--; inbox.notify(); });
  feedbackChain = work;
  return work;
 };

 training = deps.createTraining({
  root: trainingRoot, env: workerEnvironment(python), record: (type, payload) => record(type, payload),
  environmentFingerprint: python.fingerprint, pipelineRunId: identity?.pipelineRunId ?? undefined, stageInvocationId: identity?.stageInvocationId ?? undefined,
  pythonExecutable: python.executable, projectRoot: dirname(data.solutionsRoot),
  workerPath: join(ARM_ROOT, "agent", "training", "python", "worker.py"), lockPath: join(ARM_ROOT, "uv.lock"),
  sandboxCommand: (command, input) => trainingSandboxCommand(sandbox, command, input), executionBoundaryFingerprint: boundaryFingerprint,
  taskId, datasetSha256: fingerprint, rootSeed: options.seed ?? HARNESS_CONFIG.solve.seed, zipPath: data.devZip, measurement: data.measurement,
  solutionsRoot: data.solutionsRoot, search: HARNESS_CONFIG.search,
  onTrialStarted: trial => {
   report?.input({ kind: "training_source", version: 1, delivery: "tool", status: "available", artifact: trial.worktrees[0] ?? data.solutionsRoot,
    experiment_id: trial.id, commit: trial.source?.commit, tree: trial.source?.tree, search: trial.request.search !== undefined, scope: trial.request.scope.kind });
   if (!progress.trials.some(row => row.experimentId === trial.id))
    progress.trials.push({ experimentId: trial.id, hypothesis: oneLine(trial.request.hypothesis), status: "running", startedAt: now() });
   if (!progress.firstTrialAt) {
    progress.firstTrialAt = now();
    record("lead_first_trial", { experiment_id: trial.id, seconds_since_start: (Date.parse(progress.firstTrialAt) - Date.parse(progress.startedAt)) / 1000 });
   }
   save();
  },
  onTrialFinished: trialFinished, deliverExits: false,
  maxExperiments: limit, prompts, ...(options.signal ? { signal: options.signal } : {}),
 });
 try {
  await training.ready?.();
  await feedbackChain;
  // The current tag wins over stale PROGRESS after recovered finalization.
  progress.champion = championOf(data.solutionsRoot, taskId);
  save();
 }
 catch (error) { await training.close(); throw error; }

 // ---- hand-over ----
 const reviewPath = join(dirname(progressPath), runId, "hand-over-review.json");
 let scouts: LeadScouts | undefined;
 const scoutContext: LeadScoutContext = { data, python, runId, invocationId, parentAgentRunId: () => leadAgentRunId };
 const getScouts = () => scouts ??= deps.scouts(scoutContext);
 const checkIdentity = () => {
  const root = join(data.solutionsRoot, "checks", taskId);
  if (existsSync(root) && realpathSync(root) !== join(realpathSync(data.solutionsRoot), "checks", taskId)) throw new Error("Unsafe validation checks folder");
  const walk = (folder: string): unknown[] => existsSync(folder) ? readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).filter(entry => entry.name !== "__pycache__").map(entry => {
   const path = join(folder, entry.name);
   if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) throw new Error("Unsafe validation check identity");
   return [entry.name, entry.isDirectory() ? walk(path) : sha256(readFileSync(path))];
  }) : [];
  return sha256(JSON.stringify(walk(root)));
 };
 const validate = async (experimentId: string, reason: string, signal?: AbortSignal, toolCallId?: string) => {
  let snapshot: TrialSnapshot;
  try {
   snapshot = await deps.verifiedCandidate(data.solutionsRoot, taskId, fingerprint);
   if (snapshot.experimentId !== experimentId || snapshot.commit !== championOf(data.solutionsRoot, taskId)?.commit) throw new Error("Champion identity changed");
  } catch (error) {
   record("lead_validation_unavailable", { experiment_id: experimentId, message: String(error) });
   return { status: "unavailable", fix: [], advice: [], ok: [] };
  }
  const receiptKey = () => sha256(JSON.stringify({ experimentId, commit: snapshot.commit, tree: snapshot.tree, dataset: fingerprint,
   checks: checkIdentity(), prompts: prompts.fingerprint, boundary: boundaryFingerprint }));
  let key: string;
  try { key = receiptKey(); } catch {
   return { status: "unavailable", fix: [], advice: [], ok: [] };
  }
  const cached = progress.validationReceipts![key];
  if (cached) { record("lead_validation_reused", { experiment_id: experimentId, commit: snapshot.commit, receipt_key: key }); return cached.validation; }
  let result: ScoutReport | undefined;
  try {
   result = await getScouts().report({ role: "validation", question: prompts.render("team.lead-handover-question", { experiment: experimentId, reason }).text,
    refs: [{ experiment: experimentId }] }, signal, toolCallId);
  } catch (error) {
   signal?.throwIfAborted();
   record("lead_validation_failed", { experiment_id: experimentId, message: error instanceof Error ? error.message : String(error) });
  }
  const summary = validationSummary(result);
  // Unavailable/failed checks may be transient. Completed verdicts are receipts,
  // including defects, and expire when the immutable source or check identity changes.
  if (summary.status === "completed" && summary.fix.length + summary.ok.length + summary.advice.length > 0) {
   let completedKey: string;
   try { completedKey = receiptKey(); } catch {
    return { status: "unavailable", fix: [], advice: [], ok: [] };
   }
   progress.validationReceipts![completedKey] = { experimentId, commit: snapshot.commit, validation: summary, at: now() };
   if (validationPassed(summary) && !progress.baseline) {
    progress.baseline = { experimentId, commit: snapshot.commit, receiptKey: completedKey, at: now() };
    progress.phase = "improvement";
    record("lead_baseline_validated", { ...progress.baseline, phase: progress.phase });
   }
   save();
  }
  record("lead_validation", { experiment_id: experimentId, ...summary });
  return summary;
 };
 const accept = (by: LeadHandOver["by"], reason: string, experimentId: string, validation: LeadHandOver["validation"]) => {
  handOver = { by, reason: reason.slice(0, 1000), experimentId, validation, at: now() };
  progress.handOver = handOver;
  progress.status = "handing_over";
  mkdirSync(dirname(reviewPath), { recursive: true });
  writeFileSync(reviewPath, `${JSON.stringify({ experimentId, validation: { valid: validation.fix.length === 0 },
   review: { status: validation.fix.length ? "fix" : validation.status === "completed" ? "ok" : validation.status,
    readinessRationale: `${by === "lead" ? "Lead" : "Harness"} hand-over: ${handOver.reason}`, concerns: validation.fix, recommendations: validation.advice } }, null, 2)}\n`);
  save();
  record("lead_hand_over", { ...handOver, seconds_since_start: (Date.parse(handOver.at) - Date.parse(progress.startedAt)) / 1000,
   holdout_queries: Math.max(0, ...progress.holdout.map(row => row.queryCount ?? 0)) });
 };
 const settle = async (signal?: AbortSignal) => {
  while (!signal?.aborted && composing > 0) await inbox.wait(deps.pollMs, signal);
  await feedbackChain;
 };
 const holdoutUsed = () => `${Math.max(0, ...progress.holdout.map(row => row.queryCount ?? 0))}`;
 const handOverTool = defineTool({ executionMode: "sequential", name: "hand_over", label: "Hand over", description: prompts.render("team.lead-handover-tool", {}).text,
  parameters: Type.Object({ reason: Type.String({ minLength: 1, maxLength: 1000 }), finalize: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  async execute(toolCallId, args, signal) {
   const reply = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
   if (handOver) return reply(prompts.render("team.lead-handover-accepted", { experiment: handOver.experimentId, holdout: holdoutUsed(), validation: handOver.validation.status }).text);
   const running = runningTrials();
   if (running.length) return reply(prompts.render("team.lead-handover-running", { running: running.map(view => view.id).join(", ") }).text);
   await settle(signal);
   const champion = championOf(data.solutionsRoot, taskId);
   if (!champion) { record("lead_hand_over_refused", { reason: "no_champion" }); return reply(prompts.render("team.lead-handover-no-champion", {}).text); }
   const validation = await validate(champion.experimentId, args.reason, signal, toolCallId);
   if (!validationPassed(validation)) return reply(prompts.render("team.lead-handover-fix", { experiment: champion.experimentId, bullets: validation.fix.length ? validation.fix.map(row => `- ${row}`).join("\n") : `status: ${validation.status}; labelled findings: ${validation.ok.length + validation.advice.length}` }).text);
   if (!args.finalize) return reply(prompts.render("team.lead-checkpoint", { progress: renderProgress(prompts, progress).text }).text);
   accept("lead", args.reason, champion.experimentId, validation);
   budget.end();
   return reply(prompts.render("team.lead-handover-accepted", { experiment: champion.experimentId, holdout: holdoutUsed(),
    validation: validation.fix.length ? `${validation.fix.length} open defect(s) recorded` : validation.status }).text);
  } });

 // ---- the lead session ----
 const progressExtension: InlineExtension = { name: "lead-progress", factory: pi => {
  pi.on("tool_execution_end", event => {
   idleStreak = 0;
   if (event.toolName === "scout") progress.scoutCalls++;
   progress.budget.used = budget.used;
   save();
  });
 } };
 let sessionError: string | undefined;
 let endReason = "lead_finished";
 let followUp: ReturnType<typeof startFollowUp>;
 try {
  const recovered = recoverFollowUp(data.solutionsRoot);
  if (recovered.recovered || recovered.error) record("follow_up_branch_recovered", { branch: recovered.recovered?.branch, ...(recovered.error ? { error: recovered.error } : {}) });
  if (recovered.error) throw new Error(`Earlier follow-up round could not be closed: ${recovered.error}`);
  followUp = handOver ? undefined : startFollowUp(data.solutionsRoot, taskId, runId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 12));
 } catch (error) {
  record("follow_up_branch_failed", { message: error instanceof Error ? error.message : String(error) });
  await training.close(); throw error;
 }
 if (followUp) record("follow_up_branch_started", { branch: followUp.branch, champion_commit: followUp.champion, previous: followUp.previous });

 if (!handOver) {
  const scoutTool = getScouts().tool;
  const environmentToolPrompt = prompts.render("solve.python-environment-tool", {});
  const pythonSessionId = randomUUID();
  const environmentTool = deps.environmentTool(python, environmentToolPrompt.text, PROJECT_ROOT, {
   pipelineRunId: identity?.pipelineRunId ?? runId, stageInvocationId: identity?.stageInvocationId ?? runId, attempt: 1, sessionId: pythonSessionId });
  const shared = prompts.render("team.shared", {});
  const isolation = prompts.render("solve.isolation", { workspace: agentRoot });
  const followUpNote = followUp ? prompts.render("team.lead-follow-up", { branch: followUp.branch, champion: followUp.champion.slice(0, 12), previous: followUp.previous }) : undefined;
  const resume = resumed ? prompts.render("team.lead-resume", { progress: renderProgress(prompts, progress).text }) : undefined;
  const opening = prepareLeadPrompts(prompts, { taskId, configuration, workspace: agentRoot,
   evidencePath: join(agentRoot, "evidence.json"), task: readFileSync(data.taskPath, "utf8").trim(),
   datasetPaths: data.datasetPaths, targets: data.targets, rowCount: data.rowCount, targetSummary: data.targetSummary,
   foldRecommendation: `${shape.folds}-fold ${data.recommendation.scheme}, ${shape.repeats} repeat(s)`, budget: limit,
   resources: "", followUp: followUpNote?.text, resume: resume?.text, guidance: options.guidance });
  const system = opening.system;
  const promptReferences = [...opening.promptReferences, shared.reference, isolation.reference, environmentToolPrompt.reference,
   ...(followUpNote ? [followUpNote.reference] : []), ...(resume ? [resume.reference] : []),
   prompts.render("team.lead-checkpoint", { progress: renderProgress(prompts, progress).text }).reference, ...training.toolPrompts, ...GIT_BLOCK_PROMPT_IDS.map(id => prompts.render(id, {}).reference)];
  let generations = 0;
  const continueWhenIdle = async (signal?: AbortSignal): Promise<RenderedPrompt | undefined> => {
   for (;;) {
    if (signal?.aborted || handOver) return undefined;
    if (budget.exhausted) { endReason = "budget"; return undefined; }
    const news = inbox.take();
    if (news.length) return prompts.render("team.lead-news", { news: news.join("\n\n") });
    if (!runningTrials().length && composing === 0) {
     if (++idleStreak > 2) { endReason = "lead_idle"; record("lead_idle_end", { idle_prompts: idleStreak - 1 }); return undefined; }
     const champion = championOf(data.solutionsRoot, taskId);
     return prompts.render("team.lead-idle", { champion: champion ? `${champion.experimentId}${champion.score !== undefined ? `, ${champion.score.toFixed(4)}` : ""}` : "none yet" });
    }
    record("lead_waiting", { running: runningTrials().map(view => view.id), composing });
    await inbox.wait(deps.pollMs, signal);
   }
  };
  record("agent_attempt_start", { attempt: 1, reason: resumed ? "lead_resumed" : "lead", model: options.model ?? "pipeline-default",
   prompt_snapshot_sha256: prompts.fingerprint, prompts: promptReferences });
  try {
   const { agentRunId } = await deps.runAgentSession({
    prompts, system, prompt: [opening.prompt, shared.text, isolation.text].join("\n\n"), promptReferences,
    feedback: options.feedback, reportInput: report ? input => report.input(input) : undefined, model: options.model,
    cwd: PROJECT_ROOT, env: { SOLVE_WORKSPACE: agentRoot }, pythonSessionId, tools: [],
    customTools: [...training.tools, ...isolatedSolveTools(sandbox, { root: join(data.root, "shell-calls") }), environmentTool, scoutTool, handOverTool],
    wakeTarget: session => { inbox.bind(session); return inbox; },
    onSessionReady: (session, ids) => { training!.bindSession(session); if (ids.agentRunId) leadAgentRunId = ids.agentRunId; },
    // A replacement session after a context handoff starts from the harness's record.
    sessionContext: () => generations++ ? renderProgress(prompts, progress).text : "",
    continueWhenIdle,
    extensionFactories: [budget.extension(), progressExtension, createGitHistoryGuard(prompts, (type, payload) => record(type, payload))],
    ...(options.signal ? { signal: options.signal } : {}),
    ...(report ? { observe: report.observation(1) } : {}),
   });
   record("agent_attempt_end", { attempt: 1, agent_run_id: agentRunId, end_reason: handOver ? "handed_over" : endReason, budget_used: budget.used, budget_stopped: budget.stopped });
  } catch (error) {
   sessionError = error instanceof Error ? error.message : String(error);
   endReason = "agent_failed";
   record("agent_attempt_error", { attempt: 1, message: sessionError });
  }
  progress.budget.used = budget.used;
  save();
 }

 const cancelled = () => options.signal?.aborted === true;
 let stopReason: LeadStopReason = "handed_over";
 const errors: string[] = [];
 let refitArtifacts: StageArtifact[] = [];
 try {
  // Budget end, an idle or failed lead: the harness hands over the champion itself, once running trials have reported.
  if (!handOver && !cancelled()) {
   record("lead_harness_hand_over_started", { reason: endReason, running: runningTrials().map(view => view.id) });
   while (!cancelled() && runningTrials().length) await inbox.wait(deps.pollMs, options.signal);
   await settle(options.signal);
   const champion = championOf(data.solutionsRoot, taskId);
   if (champion && !cancelled()) {
    if (!holdoutDone(champion.experimentId)) await runHoldout(champion.experimentId);
    const validation = await validate(champion.experimentId, `harness hand-over at ${endReason}`, options.signal);
    if (validationPassed(validation)) accept("harness", endReason, champion.experimentId, validation);
    else { stopReason = "validation_failed"; errors.push("Champion validation failed or returned no labelled evidence"); progress.status = "failed"; progress.error = errors[0]; }
   }
  }
 } finally {
  await training.close();
  if (followUp) record("follow_up_branch_finished", { branch: followUp.branch, previous: followUp.previous, ...finishFollowUp(data.solutionsRoot, followUp) });
 }

 if (cancelled()) stopReason = "cancelled";
 else if (!handOver && stopReason !== "validation_failed") {
  stopReason = "no_champion";
  errors.push("No trial became champion; nothing to hand over");
  progress.status = "failed"; progress.error = errors[0];
 } else if (handOver) {
  try {
   const refit = await deps.refit({ taskId, configuration, experimentId: handOver.experimentId, reviewPath, model: options.model,
    ...(options.signal ? { signal: options.signal } : {}), ...(report ? { report } : {}) });
   refitArtifacts = refit.artifacts;
   if (!refit.validation.valid) throw new Error(refit.validation.errors.join("; ") || "refit invalid");
   progress.status = "handed_over";
   progress.delivery = refit.artifacts.find(artifact => artifact.kind === "final_delivery")?.path;
  } catch (error) {
   if (cancelled()) stopReason = "cancelled";
   else {
    stopReason = "refit_failed";
    errors.push(error instanceof Error ? error.message : String(error));
    progress.status = "failed"; progress.error = errors.at(-1);
   }
  }
 }
 save();
 let collection = await championSelection(await deps.collectResults(trainingRoot), data.solutionsRoot, taskId);
 // Terminal freezing closes development selection; retain the validated handover evidence.
 if (progress.status === "handed_over") {
  const selected = await handoverChampion(data.solutionsRoot, taskId);
  if (selected) collection = { ...collection, valid: true, errors: [], selected,
   artifacts: [...new Map([...collection.artifacts, ...selected.artifacts].map(artifact => [artifact.path, artifact])).values()] };
 }
 record("lead_run_finished", { stop_reason: stopReason, status: progress.status, phase: progress.phase, baseline: progress.baseline, champion: progress.champion, hand_over: progress.handOver,
  first_trial_seconds: progress.firstTrialAt ? (Date.parse(progress.firstTrialAt) - Date.parse(progress.startedAt)) / 1000 : null,
  hand_over_seconds: progress.handOver ? (Date.parse(progress.handOver.at) - Date.parse(progress.startedAt)) / 1000 : null,
  trials: progress.trials.length, holdout_queries: holdoutUsed(), budget: progress.budget, scout_calls: progress.scoutCalls,
  selected_selection: selectionSummary(collection.selected?.result), errors });
 return { progress, stopReason, valid: stopReason === "handed_over", errors, collection, configuration, trainingRoot,
  ...(confirmation ? { confirmation } : {}), refitArtifacts, ...(sessionError ? { sessionError } : {}), resumed: !!resumed };
}

