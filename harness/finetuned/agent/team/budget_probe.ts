/**
 * Dry run of the v2 scouts (expert-team-v2.md section 3), outside the pipeline.
 *
 * Usage: bun harness/finetuned/agent/team/budget_probe.ts <taskId> <data|ideas> <budget> [dataBulletsFile]
 *
 * Writes everything to runs/finetuned/scout-dry-run/<stamp>-<task>-<role>-<budget>/:
 * task.md, profile/, resources/, bullets.md, summary.json.
 * Uses the scout runner, research sandbox and web search; does not touch any
 * task's pipeline state. Not a registered stage: an experiment only, recorded
 * as stage "scout-probe".
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { buildResearchContext, findTask, PROJECT_ROOT } from "../research/context.js";
import { buildDataProfile } from "../research/profile.js";
import { stageCourseResources } from "../research/resources.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { taskDataPaths, type TaskConfiguration } from "../pipeline/task_configuration.js";
import { readPythonEnvironment } from "../run/python_environment.js";
import { ARM_ROOT, statePath } from "../paths.js";
import { prepareResearchSandbox } from "../run/solve_sandbox.js";
import { SetupSession, setupChecks } from "../pipeline/setup.js";

import { createScouts, scoutOutcome } from "./scouts.js";
import { createScoutRunner } from "./runner.js";
import { scoutRequirements } from "./setup.js";
import { createPipelineTrace } from "../pipeline/trace.js";
const [taskId, role, budgetArg, bulletsFile] = process.argv.slice(2);
if (!taskId || !["data", "ideas"].includes(role) || (!Number.isSafeInteger(Number(budgetArg)) || Number(budgetArg) < 1)) {
	console.error("usage: budget_probe.ts <taskId> <data|ideas> <budget> [dataBulletsFile]");
	process.exit(2);
}
const budget = Number(budgetArg);
const scoutRole = role as "data" | "ideas";

const config = JSON.parse(readFileSync(resolve(ARM_ROOT, "pipeline.config.json"), "utf8"));
const configuration = (config.pipeline.tasks[taskId] ?? (taskId === "code2" ? {
 schemaVersion: 1, kind: "clustering", samples: {source: "zip_members", train: "php-train.zip", test: "php-test.zip"},
 targets: {kind: "families", file: "php-train.labels"}, execution: "batch", holdout: "group", metric: "adjusted_rand_index",
 refit: "fit_predict_test_batch", submission: {format: "id_semicolon_prediction", predictions: "cluster_id"}
} : undefined)) as TaskConfiguration | undefined;
if (!configuration) throw new Error("Probe requires declared task configuration");
const task = findTask(taskId);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const workspace = statePath(PROJECT_ROOT, "scout-dry-run", `${stamp}-${taskId}-${role}-${budget}`);
mkdirSync(join(workspace, "research"), { recursive: true });
const scoutPaths = { journal: join(workspace, "findings/journal.jsonl"), unitIntro: join(dirname(task.dir), "unit-intro.md") };

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
 trace.event("pipeline_run_start", {kind: "scout_budget_probe", role, budget, configuration, promptSnapshot: prompts.fingerprint});
 // The shared preflight checks the unit introduction and journal before anything is staged or read.
 const setup = new SetupSession();
 await setup.check(setupChecks(scoutRequirements(scoutRole), {taskId, taskConfiguration: configuration, prompts, telemetry: trace.telemetry, scoutPaths}),
  new AbortController().signal, reporter.event);
 const unitIntro = readFileSync(scoutPaths.unitIntro, "utf8");

 // Task text plus the unit introduction, as the course presented them.
 const { context, prompt, resources } = buildResearchContext(taskId, configuration);
 trace.event("scout_probe_staged", {datasetSha256: context.dataset.snapshot_sha256});
 writeFileSync(join(workspace, "task.md"), [prompt.trim(), `\n---\n\n# Unit introduction\n\n${unitIntro.trim()}`].join("\n") + "\n");
 stageCourseResources(workspace, resources);
 if (role === "data") {
  const profile = buildDataProfile({ taskId, configuration, workspace, datasetSnapshotSha256: context.dataset.snapshot_sha256 });
  console.log(`[scout] profile: ${profile.status}${profile.reason ? ` (${profile.reason})` : ""}`);
 } else {
  writeFileSync(join(workspace, "data-bullets.md"), bulletsFile ? readFileSync(bulletsFile, "utf8") : "No earlier data findings: this scout is running alone.\n");
 }
 const paths = taskDataPaths(taskId, configuration);
 const dataPaths = [paths.trainZip, paths.targetsPath, paths.testZip].filter(Boolean).map(p => `\`${p}\``).join(", ");

 const sandbox = prepareResearchSandbox(workspace, task.dir, readPythonEnvironment());
 const backend = createScoutRunner({prompts, sandbox, researchRoot: join(workspace, "research"), observe: reporter.observation(1),
  taskId, taskConfiguration: configuration, telemetry: trace.telemetry, record: reporter.event, scoutPaths, setup});
 const scope = createScouts({prompts, taskId, task: prompt, unitIntro, dataPaths,
  journalPath: scoutPaths.journal, datasetSha256: context.dataset.snapshot_sha256,
  runId, invocationId, prepare: backend.prepare, budgets: {[role]: budget},
  async run(input) {
   reporter.input({kind: "scout_request", version: 1, delivery: "initial_prompt", status: "available",
    role, budget, dataset_sha256: context.dataset.snapshot_sha256});
   try { return await backend(input); } finally {({used, attempted, blocked, turns} = input.budget);}
  }});
 console.log(`[scout] ${taskId} ${role} budget=${budget} workspace=${workspace}`);
 const report = await scope.report({role: scoutRole, question: prompts.render("team.probe-question", {}).text});
 const output = report.text;
 writeFileSync(join(workspace, "bullets.md"), `${output.trim()}\n`);
 // Failed and guard-stopped scouts are not successful probes; their error or stop line is not a bullet.
 const {outcome, bullets, reasons} = scoutOutcome(report);
 const summary = {taskId, role, budget, backend: "pi-child", status: report.roles[0]?.status, ...(reasons.length ? {reasons} : {}),
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
