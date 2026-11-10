import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dataReads } from "./code.js";
import { judge, loadTargets } from "./indicators.js";
import { parseArguments } from "../scorecard_cli.js";
import { formatScorecard } from "./format.js";
import { scorecard, toJson, type Indicator } from "./index.js";

const T0 = Date.UTC(2026, 10, 1, 10, 0, 0);
const MIN = 60_000;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function write(path: string, content: string | object, at?: number) {
 mkdirSync(dirname(path), { recursive: true });
 writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
 if (at !== undefined) utimesSync(path, at / 1000, at / 1000);
}
function git(repository: string, args: string[], at: number) {
 const date = `@${Math.floor(at / 1000)} +0000`;
 const result = spawnSync("git", ["-C", repository, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args],
  { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
 if (result.status !== 0) throw new Error(result.stderr);
 return result.stdout.trim();
}

interface RunSpec {
 runId: string; start: number;
 /** [stage, invocationId, startOffsetMin, endOffsetMin, outcome] */
 stages: [string, string, number, number, string][];
 end: number; status?: string; reason?: string;
 /** Model requests as [offsetMin, source?]. */
 requests?: [number, string?][];
 counters?: Record<string, number>;
 artifacts?: object[];
}
function writeRun(runs: string, spec: RunSpec) {
 const journal: object[] = [];
 let revision = 0;
 const push = (at: number, kind: string, payload: object) => journal.push({ revision: kind === "budget_reserved" ? revision : ++revision, at, kind, payload });
 const events: [number, string, object][] = [];
 for (const [, id, from, to, outcome] of spec.stages) { events.push([spec.start + from * MIN, "stage_dispatched", { invocationId: id }]); if (outcome !== "interrupted") events.push([spec.start + to * MIN, "stage_completed", { invocationId: id }]); else events.push([spec.start + to * MIN + 5 * MIN, "agent_invocation_interrupted", { invocationId: id }]); }
 for (const [offset, source] of spec.requests ?? []) events.push([spec.start + offset * MIN, "budget_reserved", { counter: "modelRequests", ...(source ? { source } : {}) }]);
 events.push([spec.end, spec.status === "finished" ? "pipeline_finished" : "pipeline_cancelled", {}]);
 for (const [at, kind, payload] of events.sort((a, b) => a[0] - b[0])) push(at, kind, payload);
 const works = spec.stages.map(([stage, id, from, to, outcome]) => ({ id, stage, actionId: `a-${id}`, status: outcome === "interrupted" ? "interrupted" : "terminal",
  summary: { outcome }, ...(outcome === "interrupted" ? {} : { result: { stage, invocationId: id, startedAt: new Date(spec.start + from * MIN).toISOString(), finishedAt: new Date(spec.start + to * MIN).toISOString(), outcome } }) }));
 const state = { schemaVersion: 1, runId: spec.runId, taskId: "spam1", startedAt: spec.start, status: spec.status ?? "finished", reason: spec.reason, works, artifacts: spec.artifacts ?? [], journal,
  counters: { sessions: 3, modelRequests: spec.requests?.length ?? 0, toolCalls: 40, stages: spec.stages.length, trials: 2, retries: 0, ...spec.counters },
  taskConfiguration: { configuration: { samples: { train: "spam1-train.zip", test: "spam1-test.zip" }, targets: { file: "spam1-train.labels" } } } };
 write(join(runs, "spam1", "pipeline", spec.runId, "state.json"), { sha256: hash(state), state });
}
function writeTrial(runs: string, invocation: string, id: string, options: { kind: "pilot" | "promotion" | "search"; at: number; score?: number; peak?: number }) {
 const directory = join(runs, "spam1", "solve", "training", invocation, id);
 write(join(directory, "request.json"), { schemaVersion: 2, hypothesis: "h", pipeline: { module: "solutions/tasks/spam1.py", factory: "build_pipeline" }, cv: { kind: "builtin" },
  scope: { kind: options.kind === "promotion" ? "promotion" : "pilot" }, ...(options.kind === "search" ? { search: { space: {} } } : {}) }, options.at);
 write(join(directory, "events.jsonl"), `${JSON.stringify({ timestamp: options.at / 1000, type: "action_completed" })}\n`);
 write(join(directory, "worker-runtime.json"), { seconds: 42 });
 write(join(directory, "worker-exit.json"), { exitCode: options.score === undefined ? -15 : 0, ...(options.peak ? { peakRssBytes: options.peak } : {}) });
 if (options.score !== undefined) write(join(directory, "trial-result.json"), { status: "completed", metrics: { balancedAccuracy: options.score }, diagnostics: { fitSeconds: 12 } });
 return directory;
}

const LOADER = "import zipfile\n\ndef load(path):\n    with zipfile.ZipFile('spam1-train.zip') as archive:\n        return archive.namelist()\n";
const LINEAR = "from sklearn.feature_extraction.text import TfidfVectorizer\nfrom sklearn.svm import LinearSVC\nfrom sklearn.pipeline import make_pipeline\nfrom data.loader import load\n\ndef build_pipeline():\n    return make_pipeline(TfidfVectorizer(binary=True), LinearSVC())\n";

/** A run that meets every target: 25 minutes, one loader in solutions/, a linear champion, sealed check, hand-over. */
function goodRun(): { runs: string; targets: string } {
 const runs = mkdtempSync(join(tmpdir(), "scorecard-good-")); roots.push(runs);
 const start = T0, solve = "11111111-aaaa", review = "22222222-bbbb", refit = "33333333-cccc", research = "00000000-dddd";
 writeRun(runs, { runId: "run-good", start, end: start + 25 * MIN, stages: [["research", research, 1, 6, "success"], ["solve", solve, 7, 15, "success"], ["evaluate", review, 16, 18, "success"], ["refit", refit, 19, 22, "success"]],
  requests: [[0.5, "orchestrator"], [2, research], [8, solve], [9, solve], [17, review], [18.5, "orchestrator"]] });
 writeTrial(runs, solve, "pilot-1", { kind: "pilot", at: start + 10 * MIN, score: 0.993, peak: 400 * 1024 ** 2 });
 const promotion = writeTrial(runs, solve, "promo-1", { kind: "promotion", at: start + 12 * MIN, score: 0.9952, peak: 500 * 1024 ** 2 });
 // solutions/ with the loader, the entrypoint, an index and the champion tag.
 const solutions = join(runs, "solutions");
 write(join(solutions, "data", "loader.py"), LOADER, start + 8 * MIN);
 write(join(solutions, "data", "__init__.py"), "", start + 8 * MIN);
 write(join(solutions, "tasks", "spam1.py"), LINEAR, start + 9 * MIN);
 write(join(solutions, "INDEX.md"), "- data/loader.py: reads archives\n- tasks/spam1.py: entrypoint\n", start + 9 * MIN);
 git(solutions, ["init", "-q"], start); git(solutions, ["add", "-A"], start + 13 * MIN); git(solutions, ["commit", "-qm", "champion"], start + 13 * MIN);
 git(solutions, ["tag", "-a", "-m", JSON.stringify({ experimentId: "promo-1", trainingRoot: dirname(promotion), pipeline: { module: "solutions/tasks/spam1.py" } }), "champion/spam1"], start + 14 * MIN);
 // Preserve selected and validation artifacts as real runs do.
 const statePath = join(runs, "spam1", "pipeline", "run-good", "state.json");
 const state = JSON.parse(readFileSync(statePath, "utf8")).state;
 const evaluation = join(promotion, "evaluation", review, "review.json");
 write(evaluation, { taskId: "spam1", metrics: {}, sourceArtifacts: [], validation: { valid: true, errors: [] }, review: { readinessScore: 4, status: "reviewed", readinessRationale: "checked", assessment: "reviewed evidence", concerns: [], limitations: ["synthetic fixture"], recommendations: [] } });
 state.artifacts.push({ kind: "training_selected_result", path: join(promotion, "trial-result.json") }, { kind: "evaluation_report", path: evaluation });
 write(join(promotion, "invocation.json"), { source: { commit: git(solutions, ["rev-parse", "HEAD"], start) } });
 write(statePath, { state, sha256: hash(state) });
 // Sealed check, hand-over, reports, knowledge, observed scripts.
 const record = join(runs, "spam1", "confirmation", "c1", "result.json");
 write(record, { status: "completed", metrics: { balancedAccuracy: 0.9948 }, gap: 0.0004, interval: { lower: 0.991, upper: 0.997 } }, start + 21 * MIN);
 write(join(runs, "spam1", "confirmation", "latest.json"), { path: record, sha256: "x" });
 write(join(runs, "deliveries", "spam1", "abc", "output.csv"), "a;1\nb;0\nc;1\n");
 write(join(runs, "deliveries", "spam1", "abc", "manifest.json"), { deliveredAt: new Date(start + 22 * MIN).toISOString() });
 for (const id of [research, solve, review]) write(join(runs, "spam1", "reports", `x-${id}.md`), "# report\n");
 write(join(runs, "knowledge", "index.json"), { notes: [{ origin: { pipelineRunId: "run-good" }, revisions: [{ author: { pipelineRunId: "run-good" } }] }, { origin: { pipelineRunId: "other" }, revisions: [{}] }] });
 write(join(runs, "spam1", "workspace", ".harness", "processes.jsonl"), `${JSON.stringify({ pipelineRunId: "run-good", command: "python probe.py", durationSeconds: 3, peakRssBytes: 300 * 1024 ** 2 })}\n`);
 const targets = join(runs, "targets.json");
 const spam1 = JSON.parse(readFileSync(join(import.meta.dir, "targets", "spam1.json"), "utf8"));
 write(targets, { ...spam1, measurements: { handOverRows: 3 } });
 return { runs, targets };
}

/** A run like the 2026-11-09 one: research scripts with their own loaders, 40 minutes to the first trial, no hand-over. */
function badRun(): { runs: string; targets: string } {
 const runs = mkdtempSync(join(tmpdir(), "scorecard-bad-")); roots.push(runs);
 const start = T0, solve = "44444444-eeee";
 writeRun(runs, { runId: "run-bad", start, end: start + 120 * MIN, status: "cancelled", reason: "budget", stages: [["research", "55555555-ffff", 1, 35, "success"], ["solve", solve, 36, 90, "interrupted"], ["solve", "66666666-0000", 96, 104, "failure"]],
  requests: [[0.5], [10], [40], [50], [97]], counters: { trials: 12 } });
 writeTrial(runs, solve, "pilot-1", { kind: "pilot", at: start + 76 * MIN, score: 0.9949 });
 writeTrial(runs, solve, "search-1", { kind: "search", at: start + 80 * MIN });
 write(join(runs, "spam1", "research", "analysis", "_common.py"), LOADER, start + 5 * MIN);
 write(join(runs, "spam1", "research", "analysis", "cv.py"), "from _common import load\nprint(load('x'))\n", start + 6 * MIN);
 write(join(runs, "spam1", "research", "analysis", "stats.py"), "import zipfile\nz = zipfile.ZipFile('spam1-train.zip')\n", start + 7 * MIN);
 write(join(runs, "spam1", "solve", "agent", "scratch", "probe.py"), "import numpy as np\ndocs = np.load('docs.npy')\n", start + 50 * MIN);
 write(join(runs, "spam1", "solve", "research", "analysis", "_common.py"), LOADER, start + 37 * MIN);
 write(join(runs, "spam1", "solve", "training", solve, "pilot-1", "source", "tasks", "spam1.py"), LOADER, start + 76 * MIN);
 write(join(runs, "spam1", "research", "analysis", "later.py"), LOADER, start + 300 * MIN);
 write(join(runs, "solutions", "tasks", "spam1.py"), "import zipfile\nopen('spam1-train.labels')\n", start + 70 * MIN);
 return { runs, targets: join(import.meta.dir, "targets", "spam1.json") };
}

const byId = (indicators: Indicator[], id: number) => indicators.find(item => item.id === id)!;
const verdicts = (indicators: Indicator[]) => Object.fromEntries(indicators.map(item => [item.id, item.verdict]));
function tree(root: string): string {
 const lines: string[] = [];
 const visit = (path: string) => { for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  const child = join(path, entry.name); const stat = statSync(child);
  lines.push(`${child} ${stat.mtimeMs} ${stat.size}`); if (entry.isDirectory()) visit(child); } };
 visit(root); return createHash("sha256").update(lines.join("\n")).digest("hex");
}

describe("scorecard numbers", () => {
 test("reads stage times, trials, champion, sealed check, hand-over, reports and memory", () => {
  const { runs, targets } = goodRun();
  const facts = scorecard({ task: "spam1", runsDir: runs, targetsPath: targets }).runs[0].facts;
  expect(facts.run).toMatchObject({ runId: "run-good", status: "finished", durationMs: 25 * MIN, checksumValid: true, ended: true });
  expect(facts.stages.map(stage => [stage.stage, stage.durationMs])).toEqual([["research", 5 * MIN], ["solve", 8 * MIN], ["evaluate", 2 * MIN], ["refit", 3 * MIN]]);
  expect(facts.stageTotals.find(total => total.stage === "solve")).toEqual({ stage: "solve", runs: 1, totalMs: 8 * MIN });
  expect(facts.minutesToFirstTrial).toBeCloseTo(3, 5);
  expect(facts.budget).toMatchObject({ modelRequests: 6, modelRequestsDuringStages: 4, modelRequestsOutsideStages: 2, orchestratorRequestsWhileWaiting: 0 });
  expect(facts.trials.map(trial => [trial.kind, trial.status, trial.score])).toEqual([["pilot", "completed", 0.993], ["promotion", "completed", 0.9952]]);
  expect(facts.champion).toMatchObject({ experimentId: "promo-1", inRun: true, score: 0.9952, trialFound: true });
  expect(facts.sealed).toMatchObject({ status: "completed", score: 0.9948, agrees: true, inRun: true });
  expect(facts.sealed!.cvMean).toBeCloseTo(0.9952, 10);
  expect(facts.handOver).toEqual([expect.objectContaining({ rows: 3, inRun: true })]);
  expect(facts.reports).toMatchObject({ knowledgeNotes: 1, knowledgeRevisions: 1 });
  expect(facts.reports.stageReports).toHaveLength(3);
  expect(facts.memory.trialPeakBytes).toBe(500 * 1024 ** 2);
  expect(facts.memory.scripts).toEqual([expect.objectContaining({ command: "python probe.py", durationSeconds: 3, peakMemoryBytes: 300 * 1024 ** 2 })]);
 });

 test("counts agent Python per folder, attributes it to the run window and finds data loading", () => {
  const { runs, targets } = badRun();
  const facts = scorecard({ task: "spam1", runsDir: runs, targetsPath: targets }).runs[0].facts;
  const folders = Object.fromEntries(facts.code.folders.map(folder => [folder.folder, folder]));
  expect(folders["research scripts"]).toMatchObject({ files: 4, lines: 14, filesDuring: 3, filesAfter: 1 });
  expect(folders["solve scratch"]).toMatchObject({ files: 1, lines: 2 });
  expect(folders["solve's copy of research"]).toMatchObject({ role: "copy", files: 1 });
  // Trial source snapshots are harness-owned and never counted.
  expect(facts.code.files.some(file => file.path.includes("training"))).toBe(false);
  expect(facts.code.loaderImplementations.sort()).toEqual(["solutions/tasks/spam1.py", "spam1/research/analysis/_common.py", "spam1/research/analysis/stats.py"]);
  expect(facts.code.loaderFolders.sort()).toEqual(["research scripts", "solutions"]);
  expect(facts.code.loaderImporters).toEqual(["spam1/research/analysis/cv.py"]);
  expect(facts.code.cacheReaders).toEqual(["spam1/solve/agent/scratch/probe.py"]);
  expect(facts.code.agentPythonOutsideSolutions).toEqual({ files: 4, lines: 11, linesDuring: 11 });
  expect(facts.code.changedAfterRun).toBe(1);
  // The interrupted solve ends at its last activity; trials charged and run are reported apart.
  expect(facts.stages[1]).toMatchObject({ outcome: "interrupted", endEstimated: true, durationMs: 14 * MIN });
  expect(facts.budget.trialsCharged).toBe(12);
  expect(facts.trials.map(trial => [trial.kind, trial.status, trial.exitCode])).toEqual([["pilot", "completed", 0], ["search", "unfinished", -15]]);
  expect(facts.minutesToFirstTrial).toBeCloseTo(40, 5);
  expect(facts.budget.orchestratorRequestsWhileWaiting).toBeUndefined();
  expect(facts.champion).toBeUndefined();
 });
});

describe("scorecard indicators", () => {
 test("a good run passes indicators 1 to 6 and needs a second run for 7", () => {
  const { runs, targets } = goodRun();
  const [run] = scorecard({ task: "spam1", runsDir: runs, targetsPath: targets }).runs;
  expect(verdicts(run.indicators)).toEqual({ 1: "pass", 2: "pass", 3: "pass", 4: "pass", 5: "pass", 6: "pass", 7: "not_measurable" });
  expect(byId(run.indicators, 7).checks[0].hook).toContain("--compare");
 });

 test("a run like the 2026-11-09 one fails what it missed and names the hooks it lacks", () => {
  const { runs, targets } = badRun();
  const [run] = scorecard({ task: "spam1", runsDir: runs, targetsPath: targets }).runs;
  expect(verdicts(run.indicators)).toEqual({ 1: "fail", 2: "fail", 3: "fail", 4: "fail", 5: "fail", 6: "fail", 7: "not_measurable" });
  const checks = run.indicators.flatMap(item => item.checks);
  const named = (name: string) => checks.find(item => item.name.startsWith(name))!;
  expect(named("a champion exists").verdict).toBe("fail");
  expect(named("hand-over time").actual).toContain("no hand-over");
  expect(named("follow-up rounds").verdict).toBe("pass");
  expect(named("harness trials").actual).toBe("2 run (12 charged)");
  expect(named("hand-over predictions").actual).toBe("no hand-over files");
  expect(named("data loading").verdict).toBe("fail");
  expect(named("first harness trial").actual).toBe("40.0 min");
  expect(named("orchestrator model requests")).toMatchObject({ verdict: "not_measurable", hook: expect.stringContaining("budget_reserved") });
  expect(named("no script above")).toMatchObject({ verdict: "not_measurable", hook: expect.stringContaining("P1") });
  expect(named("peak memory recorded").verdict).toBe("not_measurable");
  expect(named("module index")).toMatchObject({ verdict: "not_measurable", missing: expect.stringContaining("INDEX.md") });
 });

 test("individual failures in an otherwise good run", () => {
  const { runs, targets } = goodRun();
  // A forest champion, a sealed score outside the interval, a short hand-over, an unlisted module, a 3 GB script.
  const solutions = join(runs, "solutions");
  write(join(solutions, "tasks", "spam1.py"), LINEAR.replace("LinearSVC())", "LinearSVC())\nfrom sklearn.ensemble import RandomForestClassifier\n"), T0 + 9 * MIN);
  write(join(solutions, "extra.py"), "x = 1\n", T0 + 9 * MIN);
  git(solutions, ["add", "-A"], T0 + 13 * MIN); git(solutions, ["commit", "-qm", "forest"], T0 + 13 * MIN);
  git(solutions, ["tag", "-f", "-a", "-m", JSON.stringify({ experimentId: "promo-1", pipeline: { module: "solutions/tasks/spam1.py" } }), "champion/spam1"], T0 + 14 * MIN);
  const record = join(runs, "spam1", "confirmation", "c1", "result.json");
  write(record, { status: "completed", metrics: { balancedAccuracy: 0.98 }, gap: 0.0152, interval: { lower: 0.975, upper: 0.985 } }, T0 + 21 * MIN);
  write(join(runs, "deliveries", "spam1", "abc", "output.csv"), "a;1\n");
  write(join(runs, "spam1", "workspace", ".harness", "processes.jsonl"), `${JSON.stringify({ pipelineRunId: "run-good", command: "python big.py", peakRssBytes: 3 * 1024 ** 3 })}\n`);
  const [run] = scorecard({ task: "spam1", runsDir: runs, targetsPath: targets }).runs;
  expect(verdicts(run.indicators)).toMatchObject({ 1: "pass", 2: "pass", 3: "fail", 4: "fail", 5: "fail", 6: "fail" });
  expect(byId(run.indicators, 1).checks[0].actual).toBe("0.9952");
  expect(byId(run.indicators, 5).checks.find(item => item.name.startsWith("module index"))!.actual).toContain("extra.py");
  expect(byId(run.indicators, 6).checks.find(item => item.name.startsWith("no script"))!.actual).toBe("peak 3.00 GB");
 });

 test("a hand-over after 45 minutes and too many trials fail indicator 2", () => {
  const { runs, targets } = goodRun();
  write(join(runs, "deliveries", "spam1", "abc", "manifest.json"), { deliveredAt: new Date(T0 + 50 * MIN).toISOString() });
  for (let i = 0; i < 8; i++) writeTrial(runs, "11111111-aaaa", `extra-${i}`, { kind: "pilot", at: T0 + 11 * MIN, score: 0.99 });
  // The hand-over now falls outside the run window: it is no longer this run's.
  const [run] = scorecard({ task: "spam1", runsDir: runs, targetsPath: targets }).runs;
  expect(byId(run.indicators, 2).checks.map(item => item.verdict)).toEqual(["fail", "pass", "fail"]);
  expect(byId(run.indicators, 2).checks[2].actual).toBe("10 run (2 charged)");
 });
});

describe("scorecard comparison", () => {
 function secondRun(runs: string, writesOwnLoader: boolean, requests: number) {
  const start = T0 + 60 * MIN, solve = "77777777-1111";
  writeRun(runs, { runId: "run-later", start, end: start + 20 * MIN, stages: [["solve", solve, 1, 10, "success"]], requests: Array.from({ length: requests }, (_, i) => [1 + i * 0.1, solve] as [number, string]) });
  write(join(runs, "solutions", "tasks", "spam2.py"), writesOwnLoader ? LOADER : "from data.loader import load\n", start + 5 * MIN);
 }

 test("a later run that imports the existing loader with fewer requests passes indicator 7", () => {
  const { runs, targets } = goodRun();
  secondRun(runs, false, 3);
  const result = scorecard({ task: "spam1", runsDir: runs, targetsPath: targets, runIds: ["run-later"], compareWith: "run-good" });
  expect(result.runs.map(run => run.facts.run.runId)).toEqual(["run-good", "run-later"]);
  expect(byId(result.runs[1].indicators, 7).verdict).toBe("pass");
  expect(result.comparison).toMatchObject({ earlier: "run-good", later: "run-later", modelRequests: [6, 3], trials: [2, 0], loadersWrittenByLater: [] });
  expect(result.comparison!.reuse).toEqual([{ file: "solutions/tasks/spam2.py", imports: "solutions/data/loader.py" }]);
  expect(result.comparison!.caveats[0]).toContain("different stages");
  expect(formatScorecard(result)).toContain("Comparison: run-good (earlier) → run-late (later)");
 });

 test("a later run that writes its own loader or needs more requests fails indicator 7", () => {
  const { runs, targets } = goodRun();
  secondRun(runs, true, 9);
  const result = scorecard({ task: "spam1", runsDir: runs, targetsPath: targets, runIds: ["run-good", "run-later"] });
  expect(byId(result.runs[1].indicators, 7).checks.map(item => item.verdict)).toEqual(["fail", "fail"]);
  expect(result.comparison!.loadersWrittenByLater).toEqual(["solutions/tasks/spam2.py"]);
 });
});

describe("scorecard command", () => {
 test("parses its arguments", () => {
  expect(parseArguments(["spam1", "--run", "a", "--compare", "b", "--runs", "/x", "--json"])).toMatchObject({ task: "spam1", runIds: ["a"], compareWith: "b", runsDir: "/x", json: true });
  expect(() => parseArguments([])).toThrow("Usage");
  expect(() => parseArguments(["spam1", "--run"])).toThrow("needs a value");
  expect(() => parseArguments(["spam1", "--bogus"])).toThrow("Unexpected");
 });

 test("never writes into the runs directory, and rejects unknown runs", () => {
  const { runs, targets } = goodRun();
  const before = tree(runs);
  const result = scorecard({ task: "spam1", runsDir: runs, targetsPath: targets });
  formatScorecard(result);
  const json = toJson(result) as { runs: { facts: { champion: { source: string } } }[] };
  expect(json.runs[0].facts.champion.source).toMatch(/^\d+ lines$/);
  expect(tree(runs)).toBe(before);
  expect(() => scorecard({ task: "spam1", runsDir: runs, targetsPath: targets, runIds: ["nope"] })).toThrow("Unknown run nope");
  expect(() => scorecard({ task: "spam9", runsDir: runs })).toThrow("No targets for task spam9");
 });

 test("the CLI prints text and JSON", () => {
  const { runs, targets } = goodRun();
  const cli = join(import.meta.dir, "..", "scorecard_cli.ts");
  const text = spawnSync(process.execPath, [cli, "spam1", "--runs", runs, "--targets", targets], { encoding: "utf8" });
  expect(text.status).toBe(0);
  expect(text.stdout).toContain("1. It meets the task score and compute targets: PASS");
  const json = spawnSync(process.execPath, [cli, "spam1", "--runs", runs, "--targets", targets, "--json"], { encoding: "utf8" });
  expect(JSON.parse(json.stdout).runs[0].indicators).toHaveLength(7);
 });
});

function changeState(runs: string, runId: string, mutate: (state: any) => void) {
 const path = join(runs, "spam1", "pipeline", runId, "state.json");
 const state = JSON.parse(readFileSync(path, "utf8")).state;
 mutate(state); write(path, { state, sha256: hash(state) });
}
function scored(runs: string, targets: string, runId = "run-good") {
 return scorecard({ task: "spam1", runsDir: runs, targetsPath: targets, runIds: [runId] }).runs[0];
}
function named(run: ReturnType<typeof scored>, name: string) { return run.indicators.flatMap(i => i.checks).find(c => c.name === name)!; }

describe("review regressions", () => {
 test("1: referenced champion trials do not count as executed trials or promotions", () => {
  const { runs, targets } = goodRun();
  const old = join(runs, "spam1", "solve", "training", "11111111-aaaa", "promo-1", "trial-result.json");
  writeRun(runs, { runId: "reuse", start: T0 + 60 * MIN, end: T0 + 80 * MIN, stages: [["solve", "new-solve", 1, 12, "success"]], artifacts: [{ kind: "training_selected_result", path: old }] });
  writeTrial(runs, "new-solve", "new-pilot", { kind: "pilot", at: T0 + 70 * MIN, score: .99 });
  const run = scored(runs, targets, "reuse");
  expect(run.facts.trials).toHaveLength(1); expect(run.facts.referencedTrials).toHaveLength(1);
  expect(run.facts.minutesToFirstTrial).toBe(9);
  expect(named(run, "completed promotion trials").actual).toBe("0");
 });
 test("2: immutable selection and confirmation survive replacement of mutable pointers", () => {
  const { runs, targets } = goodRun();
  const record = join(runs, "spam1", "confirmation", "c1", "result.json");
  changeState(runs, "run-good", s => s.artifacts.push({ kind: "holdout_confirmation", path: record }));
  git(join(runs, "solutions"), ["tag", "-f", "-a", "-m", JSON.stringify({ experimentId: "later" }), "champion/spam1"], T0 + 100 * MIN);
  write(join(runs, "spam1", "confirmation", "latest.json"), { path: "/missing/later" });
  let run = scored(runs, targets);
  expect(run.facts.champion?.experimentId).toBe("promo-1"); expect(run.facts.sealed?.inRun).toBe(true);
  changeState(runs, "run-good", s => s.artifacts = s.artifacts.filter((a: any) => a.kind !== "training_selected_result"));
  rmSync(record); run = scored(runs, targets);
  expect(named(run, "a champion exists").verdict).toBe("not_measurable");
  expect(named(run, "sealed check ran").verdict).toBe("not_measurable");
 });
 test("3: memory requires script and trial coverage but an excessive observed peak fails", () => {
  const { runs, targets } = goodRun();
  rmSync(join(runs, "spam1", "workspace", ".harness", "processes.jsonl"));
  let run = scored(runs, targets);
  expect(named(run, "peak memory recorded").verdict).toBe("not_measurable");
  expect(named(run, "no script above the memory limit").verdict).toBe("not_measurable");
  write(join(runs, "spam1", "solve", "training", "11111111-aaaa", "promo-1", "worker-exit.json"), { peakRssBytes: 3 * 1024 ** 3 });
  expect(named(scored(runs, targets), "no script above the memory limit").verdict).toBe("fail");
  const facts = run.facts; facts.memory.scripts = [{ command: "x", source: "fixture", peakMemoryBytes: 1 }]; facts.memory.trialsWithMemory = 1;
  expect(judge(facts, loadTargets("spam1"))[3].checks.at(-1)?.verdict).toBe("not_measurable");
 });
 test("4: comments, unused imports and task model families never determine verdicts", () => {
  const { runs, targets } = goodRun(); const run = scored(runs, targets); const t = loadTargets("spam1");
  for (const source of ["DummyClassifier() # TfidfVectorizer LinearSVC", "import RandomForestClassifier\nLinearSVC()", "KMeans()", "ImageAnomalyDetector()"] ) {
   run.facts.champion!.source = source;
   expect(judge(run.facts, t)[0].verdict).toBe("pass");
  }
  run.facts.champion!.fitSeconds = 43; expect(judge(run.facts, t)[0].verdict).toBe("fail");
  run.facts.champion!.fitSeconds = undefined; expect(judge(run.facts, t)[0].verdict).toBe("not_measurable");
  run.facts.champion!.score = .1; expect(judge(run.facts, t)[0].verdict).toBe("fail");
 });
 test("5: only read operations count; configured and unknown paths remain uncertain", () => {
  expect(dataReads("import zipfile; from data.loader import load", ["train.zip"])).toEqual({ confirmed: false, uncertain: false });
  expect(dataReads("# ZipFile('train.zip')\nname = 'train.zip'", ["train.zip"]).confirmed).toBe(false);
  for (const source of ["zipfile.ZipFile('train.zip')", "pd.read_csv('train.csv')", "Image.open('train.png')", "open('train.bin', 'rb')", "np.fromfile('train.bin')", "np.load('train.npy')", "tarfile.open('train.tar')"]) {
   expect(dataReads(source, ["train.zip", "train.csv", "train.png", "train.bin", "train.npy", "train.tar"]).confirmed).toBe(true);
  }
  expect(dataReads("pd.read_csv(config.samples.train)", ["train.csv"]).uncertain).toBe(true);
  const { runs, targets } = goodRun(); write(join(runs, "solutions", "dynamic.py"), "pd.read_csv(config.samples.train)", T0 + 10 * MIN);
  expect(named(scored(runs, targets), "data loading implemented once, in solutions/").verdict).toBe("not_measurable");
 });
 test("6: a successful evaluate work needs a readable structured report", () => {
  const { runs, targets } = goodRun(); const report = scored(runs, targets).facts.reports.validationReports[0];
  for (const value of ["invalid JSON", {}, { validation: { valid: true } }]) {
   write(report, value); expect(named(scored(runs, targets), "validation checks recorded").verdict).toBe("not_measurable");
  }
  rmSync(report); expect(named(scored(runs, targets), "validation checks recorded").verdict).toBe("not_measurable");
 });
 test("7: revisions use their author, never the note creator or legacy origin", () => {
  const { runs, targets } = goodRun();
  write(join(runs, "knowledge", "index.json"), { notes: [{ origin: { pipelineRunId: "A" }, revisions: [{ author: { pipelineRunId: "A" } }, { author: { pipelineRunId: "B" } }, { origin: { pipelineRunId: "A" } }] }] });
  for (const id of ["A", "B"]) {
   writeRun(runs, { runId: id, start: T0, end: T0 + MIN, stages: [] });
   expect(scored(runs, targets, id).facts.reports).toMatchObject({ knowledgeRevisions: 1, unknownRevisionAuthors: 1 });
  }
 });
 test("8: recovery retries are separate from follow-ups after completed rounds", () => {
  const { runs, targets } = goodRun();
  writeRun(runs, { runId: "rounds", start: T0, end: T0 + 20 * MIN, stages: [["solve", "a", 1, 2, "interrupted"], ["solve", "b", 3, 4, "failure"], ["solve", "c", 5, 6, "success"], ["solve", "d", 7, 8, "success"]] });
  expect(named(scored(runs, targets, "rounds"), "follow-up rounds")).toMatchObject({ verdict: "pass", actual: "1 (2 retries; 4 modelling stage runs)" });
 });
 test("9: clustering and label-free anomaly targets have no implicit score goal", () => {
  const { runs, targets } = goodRun(); const run = scored(runs, targets);
  for (const task of ["code2", "attacks1"]) {
   const t = loadTargets(task); expect(t.simpleModel.minCvScore).toBeNull();
   const checks = judge(run.facts, t)[0].checks;
   expect(checks.every(c => c.verdict === "not_measurable" && c.target === "no target set")).toBe(true);
  }
 });
});

test("10: README documents task targets, uncertain evidence and historical attribution", () => {
 const readme = readFileSync(join(import.meta.dir, "README.md"), "utf8");
 for (const contract of ["no target set", "diagnostics.fitSeconds", "revision.author.pipelineRunId", "uncertain candidates", "recovery retries", "training_selected_result", "evaluation_report", "script coverage"]) expect(readme).toContain(contract);
});
