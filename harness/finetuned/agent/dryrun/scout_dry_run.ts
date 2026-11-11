/**
 * Dry run of the v2 scouts (expert-team-v2.md section 3), outside the pipeline.
 *
 * Usage: bun harness/finetuned/agent/dryrun/scout_dry_run.ts <taskId> <data|ideas> <budget> [dataBulletsFile]
 *
 * Writes everything to runs/finetuned/scout-dry-run/<stamp>-<task>-<role>-<budget>/:
 * task.md, profile/, resources/, tool-calls.jsonl, bullets.md, summary.json.
 * Uses the existing session runner, research sandbox and web search; does not
 * touch any task's pipeline state. Not a registered stage: an experiment only.
 */
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildResearchContext, findTask, PROJECT_ROOT } from "../research/context.js";
import { buildDataProfile } from "../research/profile.js";
import { stageCourseResources } from "../research/resources.js";
import { loadPromptSnapshot, type RenderedPrompt } from "../prompts/loader.js";
import { taskDataPaths, type TaskConfiguration } from "../pipeline/task_configuration.js";
import { readPythonEnvironment } from "../run/python_environment.js";
import { ARM_ROOT, statePath } from "../paths.js";
import { runSession } from "../run/session_runner.js";
import { isolatedSolveTools, prepareResearchSandbox } from "../run/solve_sandbox.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SEARCH_EXTENSION = resolve(HERE, "..", "tools", "web_search.ts");
const [taskId, role, budgetArg, bulletsFile] = process.argv.slice(2);
if (!taskId || !["data", "ideas"].includes(role) || !Number.isInteger(Number(budgetArg))) {
	console.error("usage: scout_dry_run.ts <taskId> <data|ideas> <budget> [dataBulletsFile]");
	process.exit(2);
}
const budget = Number(budgetArg);
const WEB_SEARCHES = 3;

const config = JSON.parse(readFileSync(resolve(ARM_ROOT, "pipeline.config.json"), "utf8"));
const configuration = config.pipeline.tasks[taskId] as TaskConfiguration | undefined;
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
	if (!bulletsFile || !existsSync(bulletsFile)) throw new Error("ideas scout needs the data scout's bullets file");
	copyFileSync(bulletsFile, join(workspace, "data-bullets.md"));
}
const paths = configuration ? taskDataPaths(taskId, configuration) : undefined;
const dataPaths = paths ? [paths.trainZip, paths.targetsPath, paths.testZip].filter(Boolean).map(p => `\`${p}\``).join(", ") : `\`${join(task.dir, "data")}\``;

const template = readFileSync(join(HERE, "scouts", `${role}.md`), "utf8");
const systemText = template.replaceAll("{{taskId}}", taskId).replaceAll("{{budget}}", String(budget))
	.replaceAll("{{dataPaths}}", dataPaths).replaceAll("{{webSearches}}", String(WEB_SEARCHES));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const system: RenderedPrompt = { text: systemText, reference: { id: "research.system" as never, template_sha256: sha(template), rendered_sha256: sha(systemText) } };

// Tool-call budget with a counter after every call and one finish-up turn (BATS-style).
const log = join(workspace, "tool-calls.jsonl");
let used = 0, blocked = 0;
const started = Date.now();
const pending = new Map<string, number>();
const scoutBudget = { name: "scout-budget", factory(pi: any) {
	pi.on("tool_call", (event: { toolName: string; toolCallId?: string; input: Record<string, unknown> }) => {
		if (event.toolName === "bash") {
			const requested = typeof event.input.timeout === "number" && event.input.timeout > 0 ? event.input.timeout : Infinity;
			event.input.timeout = Math.min(requested, 300);
		}
		if (used >= budget) {
			blocked++;
			appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), tool: event.toolName, blocked: true })}\n`);
			return { block: true, terminate: blocked > 2, reason: `Your ${budget} tool calls are used. Write your final bullets now as your reply, without tool calls.` };
		}
		used++;
		pending.set(event.toolCallId ?? String(used), Date.now());
		appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), n: used, tool: event.toolName, input: JSON.stringify(event.input).slice(0, 400) })}\n`);
		return undefined;
	});
	pi.on("tool_result", (event: { toolCallId?: string; toolName?: string; content: { type: string; text?: string }[]; isError?: boolean }) => {
		const t0 = pending.get(event.toolCallId ?? "");
		const text = (event.content ?? []).map(c => c.text ?? "").join("");
		appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), result: event.toolName, ms: t0 ? Date.now() - t0 : null, error: !!event.isError, chars: text.length })}\n`);
		const line = used >= budget
			? `Tool calls: ${used} of ${budget} used. That was your last one: write your final bullets now as your reply.`
			: `Tool calls: ${used} of ${budget} used.`;
		return { content: [...(event.content ?? []), { type: "text", text: line }] };
	});
} };

const python = readPythonEnvironment();
const sandbox = prepareResearchSandbox(workspace, task.dir, python);
const fileTools = isolatedSolveTools(sandbox).filter(tool => role === "data" || ["read", "grep", "find", "ls"].includes(tool.name));
const opening = role === "data"
	? `Scout the data for task ${taskId}. Start with task.md and profile/profile.json.`
	: `Find what is worth trying for task ${taskId}. Start with task.md and data-bullets.md.`;

console.log(`[scout] ${taskId} ${role} budget=${budget} workspace=${workspace}`);
const { output } = await runSession({
	prompts: loadPromptSnapshot(),
	system,
	promptReferences: [],
	prompt: opening,
	cwd: workspace,
	tools: role === "ideas" ? ["web_search"] : [],
	customTools: fileTools,
	extensionPaths: role === "ideas" ? [WEB_SEARCH_EXTENSION] : [],
	extensionFactories: [scoutBudget],
	env: { WEB_SEARCH_MAX_CALLS: String(role === "ideas" ? WEB_SEARCHES : 0), WEB_SEARCH_MAX_RESULTS: "4", WEB_SEARCH_LOG: join(workspace, "web-sources.jsonl") },
});
writeFileSync(join(workspace, "bullets.md"), `${output.trim()}\n`);
const bullets = output.split("\n").filter(line => /^\s*[-*]\s/.test(line)).length;
const summary = { taskId, role, budget, used, blockedAfterBudget: blocked, bullets, seconds: Math.round((Date.now() - started) / 1000), outputChars: output.length, workspace: basename(workspace) };
writeFileSync(join(workspace, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(`[scout] done ${JSON.stringify(summary)}`);
