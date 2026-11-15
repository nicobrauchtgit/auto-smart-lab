import { randomUUID } from "node:crypto";
import { statePath, REPO_ROOT } from "../paths.js";
import { importBoard } from "./board_migration.js";
import { createPipelineTrace } from "../pipeline/trace.js";
import { SetupSession, setupChecks } from "../pipeline/setup.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
const args = process.argv.slice(2);
if (args.some(arg => !["--apply", "--dry-run"].includes(arg)) || (args.includes("--apply") && args.includes("--dry-run"))) throw new Error("Usage: findings-import [--dry-run|--apply]");
const trace = await createPipelineTrace({taskId: "findings", pipelineRunId: randomUUID(), runsDir: statePath(REPO_ROOT)});
const report = trace.stage("findings-import", randomUUID());
try {
 await new SetupSession().check(setupChecks(["observability"], {taskId: "findings", prompts: loadPromptSnapshot(), telemetry: trace.telemetry}), new AbortController().signal, report.event);
 report.event("board_import_started", {apply: args.includes("--apply")});
 const result = await importBoard(statePath(REPO_ROOT), args.includes("--apply"));
 report.event("board_import_completed", {...result});
 console.log(JSON.stringify(result, null, 2));
 if (result.rejected.length) process.exitCode = 1;
} catch (error) {
 report.event("board_import_failed", {error_type: error instanceof Error ? error.name : "Error"});
 throw error;
} finally {await trace.close();}
