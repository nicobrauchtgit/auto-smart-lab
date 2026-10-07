/** Fail-fast prerequisites shared by pipeline and standalone stage execution. */
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { initializeModel } from "../model_provider.js";
import { loadPipelineConfig } from "../pipeline_config.js";
import { readPythonEnvironment } from "../run/python_environment.js";
import { resolveTask, PROJECT_ROOT } from "./resolve_task.js";
import { resolveLabelsFile } from "../solve/workspace.js";
import { parseTrainingLabels } from "../research/startup_context.js";
import { processIdentity } from "../experiments/ownership.js";
import { HARNESS_CONFIG } from "../harness/config.js";
import type { PromptSnapshot } from "../prompts/loader.js";
import { KnowledgeStore } from "../knowledge/store.js";
import { selectedKnowledge } from "../knowledge/service.js";
import { submissionSetupChecks, submissionRecoverySetupChecks } from "../submission/setup.js";

export type SetupRequirement = "model" | "python" | "task" | "training" | "evaluation" | "refit" | "web-search" | "knowledge" | "submission" | "submission-recovery" | "orchestrator";
export interface SetupCheck {
 id: string;
 phase: "local" | "remote";
 remedy: string;
 run(signal: AbortSignal): void | Promise<void>;
}
export interface SetupResult { id: string; status: "passed" | "failed" | "skipped"; remedy?: string }

/** Never record arbitrary exception text: SDK/HTTP errors can contain credentials. */
export class SetupSession {
 private passed = new Set<string>();
 async check(checks: SetupCheck[], signal: AbortSignal, record: (event: string, payload: Record<string, unknown>) => void): Promise<void> {
  const unique = [...new Map(checks.map(check => [check.id, check])).values()];
  const results: SetupResult[] = [];
  record("setup_started", { checks: unique.map(({ id, phase }) => ({ id, phase })) });
  for (const phase of ["local", "remote"] as const) {
   const blocked = results.some(result => result.status === "failed");
   for (const check of unique.filter(check => check.phase === phase)) {
    signal.throwIfAborted();
    let result: SetupResult;
    if (this.passed.has(check.id)) result = { id: check.id, status: "passed" };
    else if (blocked) result = { id: check.id, status: "skipped" };
    else {
     try {
      await check.run(signal);
      this.passed.add(check.id);
      result = { id: check.id, status: "passed" };
     } catch {
      signal.throwIfAborted();
      result = { id: check.id, status: "failed", remedy: check.remedy };
     }
    }
    results.push(result);
    record("setup_check", { ...result });
   }
  }
  const failures = results.filter(result => result.status === "failed");
  record("setup_finished", { valid: failures.length === 0, results });
  if (failures.length) throw new Error(`Setup check failed:\n${failures.map(result => `- ${result.id}: ${result.remedy}`).join("\n")}`);
 }
}

function readable(path: string): void {
 accessSync(path, constants.R_OK);
 if (!statSync(path).isFile() || statSync(path).size === 0) throw new Error("Missing or empty file");
}

export function setupChecks(requirements: readonly SetupRequirement[], options: {
 taskId: string; model?: string; configPath?: string; prompts: PromptSnapshot;
 /** Executable overrides for regression tests; production resolves them from the environment. */
 executables?: { python?: string; git?: string };
 candidateProducedUpstream?: boolean; refitTrainingRoot?: string;
 knowledgeRoot?: string;
 submissionPolicy?: import("./types.js").StageInput["submissionPolicy"];
}): SetupCheck[] {
 const checks: SetupCheck[] = [];
 const add = (id: string, phase: SetupCheck["phase"], remedy: string, run: SetupCheck["run"]) => checks.push({ id, phase, remedy, run });
 const needs = new Set(requirements);
 if (needs.has("orchestrator")) add("orchestrator-prompts", "local", "Restore the registered orchestrator system, opening and control-tool templates, and use the project Bun runtime with kernel file locking.", () => {
  options.prompts.render("orchestrator.system", {}); options.prompts.render("orchestrator.start", { task: options.taskId, context: "{}" }); options.prompts.render("orchestrator.tool", {});
  if (!processIdentity(process.pid)) throw new Error("Process identities unavailable");
  readable(join(PROJECT_ROOT, "agent/orchestrator/coordinator.ts"));
 });
 if (needs.has("submission")) checks.push(...submissionSetupChecks({ taskId: options.taskId, policy: options.submissionPolicy, candidateProducedUpstream: options.candidateProducedUpstream }));
 if (needs.has("submission-recovery")) checks.push(...submissionRecoverySetupChecks({ taskId: options.taskId, policy: options.submissionPolicy }));
 if (needs.has("knowledge")) {
  add("knowledge-skills", "local", "Restore the registered agent/prompts/knowledge skills and tool template; runtime selection requires the validated prompt snapshot.", () => {
   selectedKnowledge(options.prompts); options.prompts.render("knowledge.tool", {});
   readable(join(PROJECT_ROOT, "agent/knowledge/service.ts"));
   readable(join(PROJECT_ROOT, "agent/knowledge/verify_evidence.py"));
  });
  add("knowledge-store", "local", "Make the project knowledge/ directory (or its existing parent) readable/writable. Restore a corrupt index; inspect interrupted writers before removing .write-lock. Do not silently reset notes.", () => {
   new KnowledgeStore(options.knowledgeRoot ?? join(PROJECT_ROOT, "knowledge")).preflight();
  });
  add("knowledge-evidence-runtime", "local", "Sync the existing Devbox Python environment and native library paths; knowledge evidence checks require numpy, sklearn and smartlab_eval without fitting.", () => {
   const result = spawnSync(readPythonEnvironment().executable, ["-I", "-c", "import numpy, sklearn, smartlab_eval"], { timeout: HARNESS_CONFIG.setup.timeoutMs, stdio: "ignore" });
   if (result.error || result.status !== 0) throw new Error("Knowledge evidence imports failed");
  });
 }
 if (needs.has("task")) add(`task:${options.taskId}`, "local", "Fetch the selected unit again; its metadata, prompt, labels and train/test archives must be readable and non-empty.", () => {
  const task = resolveTask({ taskId: options.taskId });
  readable(join(task.taskDir, "meta.json"));
  readable(join(task.taskDir, "prompt.md"));
  const labels = resolveLabelsFile(options.taskId, join(task.taskDir, "data"));
  readable(labels);
  const parsed = parseTrainingLabels(readFileSync(labels));
  if (!parsed.ok || !parsed.rows.length) throw new Error("Invalid labels");
  const archives = ["train", "test"].map(kind => join(task.taskDir, "data", basename(labels).replace(/-train\.labels$/, `-${kind}.zip`)));
  archives.forEach(readable);
  const python = join(resolve(PROJECT_ROOT, process.env.VENV_DIR ?? ".venv"), "bin/python");
  const result = spawnSync(python, ["-I", "-c", "import sys, zipfile\nfor p in sys.argv[1:]:\n with zipfile.ZipFile(p) as z:\n  assert z.namelist() and z.testzip() is None", ...archives], { timeout: HARNESS_CONFIG.setup.timeoutMs, stdio: "ignore" });
  if (result.error || result.status !== 0) throw new Error("Unreadable or corrupt archives");
 });
 if (needs.has("python")) add("python-environment", "local", "Enter the project Devbox environment and run devbox run python-setup; declarations, lockfile and installed packages must agree.", () => { readPythonEnvironment(); });
 if (needs.has("evaluation")) {
  add("evaluation-diagnostics", "local", "Restore agent/evaluation/diagnostics.py and sync the Devbox Python environment; sklearn and smartlab_eval must import successfully.", () => {
   readable(join(PROJECT_ROOT, "agent/evaluation/diagnostics.py"));
   const result = spawnSync(readPythonEnvironment().executable, ["-c", "from sklearn.metrics import roc_curve, precision_recall_curve, precision_recall_fscore_support; from smartlab_eval import load_labels"], { timeout: HARNESS_CONFIG.setup.timeoutMs, stdio: "ignore" });
   if (result.error || result.status !== 0) throw new Error("Evaluation imports failed");
  });
 }
 if (needs.has("training")) {
  add("training-recovery", "local", "Run solve on Linux (/proc) or Darwin (libproc) with process birth identities and local flock support; durable worker recovery requires both. Use the project Devbox Python (fcntl is standard library).", () => {
   if (!processIdentity(process.pid)) throw new Error("Process birth identities unavailable");
   for (const name of ["runner.py", "worker.py", "smartlab_trial/recovery.py"]) accessSync(join(PROJECT_ROOT, "agent/training/python", name), constants.R_OK);
   const python = options.executables?.python ?? readPythonEnvironment().executable;
   const result = spawnSync(python, ["-c", "import fcntl, tempfile; f = tempfile.TemporaryFile(); fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)"], { timeout: HARNESS_CONFIG.setup.timeoutMs, stdio: "ignore" });
   if (result.error || result.status !== 0) throw new Error("Kernel file locking unavailable");
  });
  add("training-imports", "local", "Check the Devbox Python environment and native library paths: numpy, pandas and sklearn must import successfully.", () => {
   const python = readPythonEnvironment().executable;
   const result = spawnSync(python, ["-c", "import numpy, pandas, sklearn"], { timeout: HARNESS_CONFIG.setup.timeoutMs, stdio: "ignore" });
   if (result.error || result.status !== 0) throw new Error("Imports failed");
  });
  add("training-optuna", "local", "Sync the Devbox Python environment (devbox run python-setup); optuna is a declared dependency used for harness-owned hyperparameter search.", () => {
   const python = options.executables?.python ?? readPythonEnvironment().executable;
   const result = spawnSync(python, ["-c", "import optuna\nfrom optuna.storages.journal import JournalFileBackend"], { timeout: HARNESS_CONFIG.setup.timeoutMs, stdio: "ignore" });
   if (result.error || result.status !== 0) throw new Error("Optuna unavailable");
  });
  add("training-git", "local", "Install git in the project Devbox environment; solve versions solutions/ as a git repository and runs every trial from a worktree of its commit.", () => {
   const result = spawnSync(options.executables?.git ?? "git", ["worktree", "-h"], { timeout: HARNESS_CONFIG.setup.timeoutMs, stdio: "ignore" });
   // `git worktree -h` exits 129 after printing usage; a missing binary is a spawn error.
   if (result.error || (result.status !== 0 && result.status !== 129)) throw new Error("git unavailable");
  });
  add("training-zip-command", "local", "Install the zip command in the project Devbox environment; solve uses zip --copy to prepare development data.", () => {
   const result = spawnSync("zip", ["-v"], { timeout: HARNESS_CONFIG.setup.timeoutMs, stdio: "ignore" });
   if (result.error || result.status !== 0) throw new Error("zip unavailable");
  });
 }
 if (needs.has("refit")) {
  add("refit-runtime", "local", "Restore the terminal worker and runner, git, kernel process identities and Devbox Python dependencies (numpy, pandas, sklearn, smartlab_eval, cloudpickle, fcntl).", () => {
   readable(join(PROJECT_ROOT, "agent/refit/worker.py")); readable(join(PROJECT_ROOT, "agent/training/python/runner.py"));
   if (!processIdentity(process.pid)) throw new Error("Process identity unavailable");
   const python = options.executables?.python ?? readPythonEnvironment().executable;
   const probe = spawnSync(python, ["-c", "import numpy,pandas,sklearn,smartlab_eval,cloudpickle,fcntl"], { timeout: HARNESS_CONFIG.setup.timeoutMs, stdio: "ignore" });
   const git = spawnSync(options.executables?.git ?? "git", ["--version"], { timeout: HARNESS_CONFIG.setup.timeoutMs, stdio: "ignore" });
   if (probe.error || probe.status !== 0 || git.error || git.status !== 0) throw new Error("Refit prerequisites unavailable");
  });
  add(`refit-data:${options.taskId}`, "local", "Restore complete original training labels/train archive and the unlabelled test archive. IDs must be unique, exact, disjoint and test IDs neutral; archives must pass CRC validation.", async () => {
   const { refitInputs } = await import("./stages/refit.js");
   const inputs = refitInputs(options.taskId);
   const result = spawnSync(options.executables?.python ?? inputs.pythonExecutable, [join(PROJECT_ROOT, "agent/refit/worker.py"), "--inspect-json", JSON.stringify({ labelsPath: inputs.labelsPath, trainZip: inputs.trainZip, testZip: inputs.testZip })], { env: inputs.env, timeout: HARNESS_CONFIG.setup.timeoutMs, stdio: "ignore" });
   if (result.error || result.status !== 0) throw new Error("Original refit data invalid");
  });
  // The chain may not have selected a candidate yet. Data/runtime prerequisites
  // are always checked now; upstream selection is validated at refit invocation.
  if (!options.candidateProducedUpstream) add(`refit-candidate:${options.taskId}`, "local", "Complete a champion promotion and restore its exact measured source, data, dependencies and checksummed evidence. The chosen tag and supplied training root must agree.", async signal => {
   const { refitInputs } = await import("./stages/refit.js");
   const { prepareRefit } = await import("../refit/service.js");
   await prepareRefit({ ...refitInputs(options.taskId, options.refitTrainingRoot), signal });
  });
 }
 if (needs.has("web-search")) {
  add("TAVILY_API_KEY", "local", "Set a non-empty TAVILY_API_KEY in .env; research requires web citations.", () => {
   if (!process.env.TAVILY_API_KEY?.trim()) throw new Error("Missing key");
  });
  add("tavily-access", "remote", "Verify TAVILY_API_KEY, Tavily connectivity and remaining credits.", async signal => {
   const response = await fetch("https://api.tavily.com/usage", {
    headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}` }, redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(HARNESS_CONFIG.setup.timeoutMs)]),
   });
   if (!response.ok) throw new Error("Tavily rejected access");
   const data = await response.json() as { key?: { usage: number; limit: number | null }; account?: { plan_usage: number; plan_limit: number; paygo_usage: number; paygo_limit: number } };
   if (!data.key || typeof data.key.usage !== "number") throw new Error("Invalid usage response");
   if (data.key.limit !== null && data.key.usage >= data.key.limit) throw new Error("Key credits exhausted");
   const a = data.account;
   if (a && a.plan_usage >= a.plan_limit && a.paygo_usage >= a.paygo_limit) throw new Error("Account credits exhausted");
  });
 }
 if (needs.has("model")) {
  add("model-configuration", "local", "Check the selected provider/model in pipeline.config.json and its apiKeyEnv credential in .env (or builtin provider credentials).", async () => {
   const { config } = await loadPipelineConfig(options.configPath);
   const reference = options.model ?? config.defaultModel;
   const provider = config.providers[reference.split("/")[0]];
   if (!provider) throw new Error("Unknown provider");
   if (!("builtin" in provider) && !process.env[provider.apiKeyEnv]?.trim()) throw new Error("Missing key");
   await initializeModel({ config, model: options.model });
  });
  add("model-access", "remote", "The selected model failed a minimal request. Check its credentials, model access, quota and provider connectivity.", async signal => {
   const { modelRuntime, model } = await initializeModel({ configPath: options.configPath, model: options.model });
   const result = await modelRuntime.completeSimple(model, { messages: [{ role: "user", content: options.prompts.render("setup.model-check", {}).text, timestamp: Date.now() }] }, {
    maxTokens: HARNESS_CONFIG.setup.modelMaxTokens,
    signal: AbortSignal.any([signal, AbortSignal.timeout(HARNESS_CONFIG.setup.timeoutMs)]),
   });
   if (result.stopReason === "error" || result.stopReason === "aborted" || !result.content.length) throw new Error("Model unavailable");
  });
 }
 return checks;
}
