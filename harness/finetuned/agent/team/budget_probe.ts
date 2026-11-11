/**
 * Dry run of one v2 scout (expert-team-v2.md section 3), outside the pipeline.
 *
 * Usage:
 *   bun harness/finetuned/agent/team/budget_probe.ts <taskId> <data|ideas> <budget> [dataBulletsFile]
 *   bun harness/finetuned/agent/team/budget_probe.ts <taskId> validation <budget> <experimentId>
 *
 * The scout gets what production gives it: stream B's prepared TaskData
 * (task.md with the unit introduction, profile.json, development and test
 * inputs), the unit's course resources, and `expertSandbox` for its role;
 * validation gets the measured trial's verified snapshot. Probe outputs go to
 * runs/finetuned/scout-dry-run/<stamp>-<task>-<role>-<budget>/: findings
 * journal, bullets.md, summary.json. Not a registered stage: an experiment
 * only, recorded as stage "scout-probe". Never trains, refits or submits.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { loadPromptSnapshot } from "../prompts/loader.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";
import { PROJECT_ROOT, resolveTask } from "../pipeline/resolve_task.js";
import { readPythonEnvironment } from "../run/python_environment.js";
import { ARM_ROOT, statePath } from "../paths.js";
import { expertSandbox, scoutWorkspace } from "../run/sandbox.js";
import { readCourseResources } from "../research/resources.js";
import { prepareTaskData, readTaskData } from "../workspace/task_data.js";
import { SetupSession, setupChecks } from "../pipeline/setup.js";
import { createPipelineTrace } from "../pipeline/trace.js";

import { appendFindings } from "./journal.js";
import { createScouts, finalBullets, scoutOutcome } from "./scouts.js";
import { createScoutRunner } from "./runner.js";
import { scoutRequirements } from "./setup.js";
import { stageScoutInputs } from "./workspace.js";
import { createTrialResolver, taskTrialRoots } from "./trials.js";
import type { ScoutRole } from "./contracts.js";

const [taskId, role, budgetArg, extra] = process.argv.slice(2);
if (!taskId || !["data", "ideas", "validation"].includes(role) || !Number.isSafeInteger(Number(budgetArg)) || Number(budgetArg) < 1 || (role === "validation" && !extra)) {
	console.error("usage: budget_probe.ts <taskId> <data|ideas> <budget> [dataBulletsFile]\n       budget_probe.ts <taskId> validation <budget> <experimentId>");
	process.exit(2);
}
const budget = Number(budgetArg);
const scoutRole = role as ScoutRole;

/** Code2 has a probe-only declaration from its supplied task text; pipeline.config.json is unchanged. */
const CODE2_PROBE_CONFIGURATION = {
 schemaVersion: 1, kind: "clustering", samples: {source: "zip_members", train: "php-train.zip", test: "php-test.zip"},
 targets: {kind: "families", file: "php-train.labels"}, execution: "batch", holdout: "group", metric: "adjusted_rand_index",
 refit: "fit_predict_test_batch", submission: {format: "id_semicolon_prediction", predictions: "cluster_id"},
} as const;
const config = JSON.parse(readFileSync(resolve(ARM_ROOT, "pipeline.config.json"), "utf8"));
const configuration = (config.pipeline.tasks[taskId] ?? (taskId === "code2" ? CODE2_PROBE_CONFIGURATION : undefined)) as TaskConfiguration | undefined;
if (!configuration) throw new Error("Probe requires declared task configuration");
const task = resolveTask({taskId});
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const workspace = statePath(PROJECT_ROOT, "scout-dry-run", `${stamp}-${taskId}-${role}-${budget}`);
mkdirSync(workspace, {recursive: true});

/** Setup failures are already sanitized; anything else keeps only its type and first line. */
function failureReason(error: unknown): string {
 const text = error instanceof Error ? error.message : String(error);
 return text.startsWith("Setup check failed") ? text.slice(0, 2000) : `${error instanceof Error ? error.name : "Error"}: ${text.split("\n")[0].slice(0, 200)}`;
}

const prompts = loadPromptSnapshot();
const started = Date.now();
const runId = randomUUID();
const invocationId = randomUUID();
const trace = await createPipelineTrace({taskId, pipelineRunId: runId, runsDir: statePath(PROJECT_ROOT)});
const reporter = trace.stage("scout-probe", invocationId);
let used = 0, attempted = 0, blocked = 0, turns = 0;
try {
 trace.event("pipeline_run_start", {kind: "scout_budget_probe", role, budget, configuration, promptSnapshot: prompts.fingerprint, ...(role === "validation" ? {experiment_id: extra} : {})});
 // Stream B's sealed task data: resumes the stored split, never redraws it.
 const data = readTaskData(taskId) ?? prepareTaskData(taskId, configuration);
 const scoutPaths = {journal: join(workspace, "findings/journal.jsonl"), unitIntro: join(dirname(task.taskDir), "unit-intro.md"), task: data.taskPath, profile: data.profilePath};
 // The shared preflight checks task.md, the unit introduction and the journal before anything is staged.
 const setup = new SetupSession();
 await setup.check(setupChecks(scoutRequirements(scoutRole), {taskId, taskConfiguration: configuration, prompts, telemetry: trace.telemetry, scoutPaths}),
  new AbortController().signal, reporter.event);
 // Earlier probes' research would be prior work for this one: keep it with this probe's outputs instead.
 const research = join(scoutWorkspace(data), "research");
 if (scoutRole !== "validation" && existsSync(research)) renameSync(research, join(workspace, "earlier-research"));
 const inputs = stageScoutInputs(data, readCourseResources(task.unitSlug));
 trace.event("scout_probe_staged", {datasetSha256: data.datasetSha256, scout_root: inputs.root});
 if (role === "ideas" && extra) {
  // Data bullets from an earlier probe reach ideas the way they do in a run: as earlier journal findings.
  await appendFindings(scoutPaths.journal, finalBullets(readFileSync(extra, "utf8"), "").filter(Boolean).map(bullet => ({kind: "fact" as const,
   author: {role: "data" as const, runId, invocationId}, title: bullet.slice(2, 102), text: bullet.slice(2, 802).replace(/\s*\n\s*/g, " "), refs: [], datasetSha256: data.datasetSha256})));
 }
 const python = readPythonEnvironment();
 const trials = createTrialResolver({roots: () => taskTrialRoots(statePath(PROJECT_ROOT), taskId), solutionsRoot: data.solutionsRoot});
 const backend = createScoutRunner({prompts, sandbox: (scout, trial) => expertSandbox(data, scout, python, trial), solutionsRoot: data.solutionsRoot,
  observe: reporter.observation(1), taskId, taskConfiguration: configuration, telemetry: trace.telemetry, record: reporter.event, scoutPaths, setup});
 const scope = createScouts({prompts, taskId, task: readFileSync(data.taskPath, "utf8"), dataPaths: inputs.dataPaths, resources: inputs.resources,
  journalPath: scoutPaths.journal, datasetSha256: data.datasetSha256, trials, solutionsRoot: data.solutionsRoot,
  runId, invocationId, prepare: backend.prepare, budgets: {[role]: budget},
  async run(input) {
   reporter.input({kind: "scout_request", version: 1, delivery: "initial_prompt", status: "available",
    role, budget, dataset_sha256: data.datasetSha256, ...(input.trial ? {experiment_id: input.trial.experimentId, commit: input.trial.commit} : {})});
   try { return await backend(input); } finally {({used, attempted, blocked, turns} = input.budget);}
  }});
 console.log(`[scout] ${taskId} ${role} budget=${budget} workspace=${workspace}`);
 const report = await scope.report(scoutRole === "validation"
  ? {role: scoutRole, question: prompts.render("team.probe-validation", {}).text, refs: [{experiment: extra}]}
  : {role: scoutRole, question: prompts.render("team.probe-question", {}).text});
 const output = report.text;
 writeFileSync(join(workspace, "bullets.md"), `${output.trim()}\n`);
 // Failed and guard-stopped scouts are not successful probes; their error or stop line is not a bullet.
 const {outcome, bullets, reasons} = scoutOutcome(report);
 const summary = {taskId, role, budget, backend: "pi-child", status: report.roles[0]?.status, ...(reasons.length ? {reasons} : {}),
  ...(role === "validation" ? {experiment: extra} : {}),
  used, attempted, blockedAfterBudget: blocked, turns, bullets,
  seconds: Math.round((Date.now() - started) / 1000), outputChars: output.length, workspace: basename(workspace)};
 writeFileSync(join(workspace, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
 trace.event("pipeline_run_end", {outcome, summary});
 if (outcome === "success") console.log(`[scout] done ${JSON.stringify(summary)}`);
 else { console.error(`[scout] ${outcome}: ${JSON.stringify(summary)}`); process.exitCode = 1; }
} catch (error) {
 const reason = failureReason(error);
 trace.event("pipeline_run_end", {outcome: "failure", reason});
 console.error(`[scout] failed: ${reason}`);
 process.exitCode = 1;
} finally {await trace.close();}
