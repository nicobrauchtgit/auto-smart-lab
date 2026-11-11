/**
 * Dry run of the v2 scouts (expert-team-v2.md section 3), outside the pipeline.
 *
 * Usage: bun harness/finetuned/agent/team/budget_probe.ts <taskId> <data|ideas> <budget> [dataBulletsFile]
 *
 * Writes everything to runs/finetuned/scout-dry-run/<stamp>-<task>-<role>-<budget>/:
 * task.md, profile/, resources/, bullets.md, summary.json.
 * Uses the existing session runner, research sandbox and web search; does not
 * touch any task's pipeline state. Not a registered stage: an experiment only.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { buildResearchContext, findTask, PROJECT_ROOT } from "../research/context.js";
import { buildDataProfile } from "../research/profile.js";
import { stageCourseResources } from "../research/resources.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { taskDataPaths, type TaskConfiguration } from "../pipeline/task_configuration.js";
import { readPythonEnvironment } from "../run/python_environment.js";
import { ARM_ROOT, statePath } from "../paths.js";
import { runSession } from "../run/session_runner.js";
import { prepareResearchSandbox } from "../run/solve_sandbox.js";

import { createScouts } from "./scouts.js";
import { createScoutRunner } from "./runner.js";
import { createPipelineTrace } from "../pipeline/trace.js";
const [taskId, role, budgetArg, bulletsFile] = process.argv.slice(2);
if (!taskId || !["data", "ideas"].includes(role) || (!Number.isSafeInteger(Number(budgetArg)) || Number(budgetArg) < 1)) {
	console.error("usage: budget_probe.ts <taskId> <data|ideas> <budget> [dataBulletsFile]");
	process.exit(2);
}
const budget = Number(budgetArg);

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

// Task text plus the unit introduction, as the course presented them.
const { context, prompt, resources } = buildResearchContext(taskId, configuration);
const unitIntro = join(dirname(task.dir), "unit-intro.md");
writeFileSync(join(workspace, "task.md"), [prompt.trim(), existsSync(unitIntro) ? `\n---\n\n# Unit introduction\n\n${readFileSync(unitIntro, "utf8").trim()}` : ""].join("\n") + "\n");
stageCourseResources(workspace, resources);
if (role === "data") {
	const profile = buildDataProfile({ taskId, configuration, workspace, datasetSnapshotSha256: context.dataset.snapshot_sha256 });
	console.log(`[scout] profile: ${profile.status}${profile.reason ? ` (${profile.reason})` : ""}`);
} else {
	writeFileSync(join(workspace, "data-bullets.md"), bulletsFile ? readFileSync(bulletsFile, "utf8") : "No earlier data findings: this scout is running alone.\n");
}
const paths = configuration ? taskDataPaths(taskId, configuration) : undefined;
const dataPaths = paths ? [paths.trainZip, paths.targetsPath, paths.testZip].filter(Boolean).map(p => `\`${p}\``).join(", ") : `\`${join(task.dir, "data")}\``;

const prompts = loadPromptSnapshot();
const started = Date.now();
const runId = randomUUID();
const invocationId = randomUUID();
const trace = await createPipelineTrace({taskId, pipelineRunId: runId, runsDir: statePath(PROJECT_ROOT)});
const reporter = trace.stage("solve", invocationId);
let used = 0, blocked = 0;
try {
 trace.event("pipeline_run_start", {kind: "scout_budget_probe", role, budget});
 const sandbox = prepareResearchSandbox(workspace, task.dir, readPythonEnvironment());
 const backend = createScoutRunner({prompts, sandbox, researchRoot: join(workspace, "research"), observe: reporter.observation(1),
  taskId, taskConfiguration: configuration, telemetry: trace.telemetry, record: reporter.event});
 const scope = createScouts({prompts, taskId, task: prompt, unitIntro: readFileSync(unitIntro, "utf8"), dataPaths,
  journalPath: join(workspace, "findings/journal.jsonl"), datasetSha256: context.dataset.snapshot_sha256,
  runId, invocationId, prepare: backend.prepare, budgets: {[role]: budget},
  async run(input) {
   reporter.input({kind: "scout_request", version: 1, delivery: "initial_prompt", status: "available",
    role, budget, dataset_sha256: context.dataset.snapshot_sha256});
   try { return await backend(input); } finally {used = input.budget.used; blocked = input.budget.blocked;}
  }});
 console.log(`[scout] ${taskId} ${role} budget=${budget} workspace=${workspace}`);
 const output = await scope.scout({role: role as "data" | "ideas", question: prompts.render("team.probe-question", {}).text});
 writeFileSync(join(workspace, "bullets.md"), `${output.trim()}\n`);
 const summary = {taskId, role, budget, backend: "pi-child", used, blockedAfterBudget: blocked, bullets: output.split("\n").length,
  seconds: Math.round((Date.now() - started) / 1000), outputChars: output.length, workspace: basename(workspace)};
 writeFileSync(join(workspace, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
 trace.event("pipeline_run_end", {outcome: "success", summary});
 console.log(`[scout] done ${JSON.stringify(summary)}`);
} catch (error) {
 trace.event("pipeline_run_end", {outcome: "failure"});
 throw error;
} finally {await trace.close();}
