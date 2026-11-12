/**
 * Probe-only: one harness-owned trial of a minimal pipeline, so validation
 * scout probes have a measured trial snapshot. Not a stage; never promotes,
 * refits or submits.
 *
 * Usage: bun harness/finetuned/agent/team/probe_trial.ts <taskId>
 *
 * Uses (or prepares) stream B's task data, commits a minimal
 * `solutions/tasks/<task>.py` when the task has none, and starts one trial
 * through the training service under the solve sandbox boundary, exactly as a
 * solve session would. Prints the experiment ID for budget_probe.ts.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHarnessTraining } from "../training/index.js";
import { git } from "../training/git.js";
import { prepareTaskData, readTaskData } from "../workspace/task_data.js";
import { readPythonEnvironment } from "../run/python_environment.js";
import { prepareSolveSandbox, trainingSandboxCommand } from "../run/solve_sandbox.js";
import { workerEnvironment } from "../run/lead_session.js";
import { HARNESS_CONFIG } from "../harness/config.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { ARM_ROOT } from "../paths.js";
import { probeConfiguration } from "./probe_tasks.js";

const READ = `
def _texts(frame):
    import zipfile
    texts, archives = [], {}
    try:
        for descriptor in frame["input"]:
            archive = archives.get(descriptor["archive"])
            if archive is None:
                archive = archives[descriptor["archive"]] = zipfile.ZipFile(descriptor["archive"])
            texts.append(archive.read(descriptor["member"]).decode("utf-8", "replace"))
    finally:
        for archive in archives.values():
            archive.close()
    return texts
`;
const CLASSIFIER = `"""Minimal probe pipeline: hashed word counts and logistic regression.
Input: frame with id and input {archive, member}; output: 0/1 labels."""
from sklearn.feature_extraction.text import HashingVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import FunctionTransformer, Pipeline
${READ}

def build_pipeline(context=None):
    return Pipeline([
        ("text", FunctionTransformer(_texts, validate=False)),
        ("hash", HashingVectorizer(n_features=2 ** 18, alternate_sign=False)),
        ("model", LogisticRegression(max_iter=1000, class_weight="balanced")),
    ])
`;
const CLUSTERER = `"""Minimal probe pipeline: TF-IDF of PHP source tokens, agglomerative clustering.
Input: frame with id and input {archive, member}; output: one cluster ID per row."""
from sklearn.cluster import AgglomerativeClustering
from sklearn.feature_extraction.text import TfidfVectorizer
${READ}

class SourceClusters:
    def __init__(self, threshold=0.8):
        self.threshold = threshold

    def fit_predict(self, frame, y=None):
        features = TfidfVectorizer(token_pattern=r"[A-Za-z_][A-Za-z0-9_]+", max_features=20000).fit_transform(_texts(frame))
        model = AgglomerativeClustering(n_clusters=None, distance_threshold=self.threshold, metric="cosine", linkage="average")
        return model.fit_predict(features.toarray())


def build_pipeline(context=None):
    return SourceClusters()
`;

const taskId = process.argv[2];
if (!taskId) { console.error("usage: probe_trial.ts <taskId>"); process.exit(2); }
const configuration = probeConfiguration(taskId);
const data = readTaskData(taskId) ?? prepareTaskData(taskId, configuration);
const module = join(data.solutionsRoot, "tasks", `${taskId}.py`);
if (!existsSync(module)) {
 writeFileSync(module, configuration.kind === "clustering" ? CLUSTERER : CLASSIFIER);
 for (const args of [["add", `tasks/${taskId}.py`], ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", `Probe pipeline for ${taskId}`]]) {
  const result = git(data.solutionsRoot, args);
  if (result.status !== 0) throw new Error(result.stderr);
 }
}
const python = readPythonEnvironment();
const sandbox = prepareSolveSandbox(data, python);
const prompts = loadPromptSnapshot();
const runId = `probe-${randomUUID()}`;
const training = createHarnessTraining({
 root: join(data.root, "training", runId), env: workerEnvironment(python), prompts,
 record: (event, payload) => { if (/failed|refused|rejected|error/.test(event)) console.error(`[trial] ${event} ${JSON.stringify(payload).slice(0, 400)}`); },
 environmentFingerprint: python.fingerprint, pythonExecutable: python.executable, projectRoot: dirname(data.solutionsRoot),
 workerPath: join(ARM_ROOT, "agent", "training", "python", "worker.py"), lockPath: join(ARM_ROOT, "uv.lock"),
 sandboxCommand: (command, input) => trainingSandboxCommand(sandbox, command, input),
 taskId, datasetSha256: data.datasetSha256, rootSeed: HARNESS_CONFIG.solve.seed, zipPath: data.devZip, measurement: data.measurement,
 solutionsRoot: data.solutionsRoot, search: HARNESS_CONFIG.search, maxExperiments: 1,
});
try {
 await training.ready();
 const started = await training.service.start({schemaVersion: 1, hypothesis: "A minimal pipeline gives the validation scout a measured snapshot.",
  pipeline: {module: `solutions/tasks/${taskId}.py`, factory: "build_pipeline"},
  cv: {kind: "builtin", scheme: data.recommendation.scheme, folds: Math.min(3, data.recommendation.folds), repeats: 1},
  scope: {kind: "promotion"}}, "probe-trial");
 console.log(`[trial] started ${started.id} in ${started.directory}`);
 const deadline = Date.now() + 60 * 60_000;
 while (training.supervisor.status(started.id).status === "running" && Date.now() < deadline) await Bun.sleep(2_000);
 const resultPath = join(started.directory, "trial-result.json");
 const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : {status: training.supervisor.status(started.id).status};
 console.log(`[trial] ${started.id} ${result.status} ${JSON.stringify(result.metrics ?? {}).slice(0, 300)}`);
 if (result.status !== "completed") process.exitCode = 1;
} finally { await training.close(); }
