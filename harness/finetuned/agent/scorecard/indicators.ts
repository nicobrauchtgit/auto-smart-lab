/**
 * The seven indicators of a good run (docs/redesign-plan.md), judged against a
 * task's targets file. Each indicator is a list of checks; an indicator fails
 * when any check fails, is "not measurable yet" when no check fails but one
 * lacks its fact, and passes otherwise.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunFacts } from "./facts.js";

export interface Targets {
 task: string;
 metric: { name: string; trialKey: string };
 reference?: Record<string, unknown>;
 simpleModel: { minCvScore: number; featurePatterns: string[]; linearEstimators: string[]; nonLinearEstimators: string[] };
 finish: { maxHandOverMinutes: number; aimHandOverMinutes?: number; maxFollowUpRounds: number; maxTrials: number };
 verify: { minPromotionTrials: number; requireSealedCheck: boolean; requireValidationChecks: boolean };
 measurements: { handOverRows: number };
 reuse: { maxLoaderImplementations: number; maxAgentPythonLinesOutsideSolutions: number; requireModuleIndex: boolean };
 cost: { maxMinutesToFirstTrial: number; maxOrchestratorRequestsWhileWaiting: number; maxScriptPeakGb: number };
 memory: { requireFewerModelRequests: boolean; requireLoaderReuse: boolean };
}

export const TARGETS_DIR = join(import.meta.dir, "targets");
export function loadTargets(task: string, path?: string): Targets {
 const file = path ?? join(TARGETS_DIR, `${task}.json`);
 if (!existsSync(file)) throw new Error(`No targets for task ${task}: write ${file} (see targets/spam1.json)`);
 return JSON.parse(readFileSync(file, "utf8")) as Targets;
}

export type Verdict = "pass" | "fail" | "not_measurable";
export interface Check { name: string; verdict: Verdict; actual: string; target: string; missing?: string; hook?: string }
export interface Indicator { id: number; title: string; verdict: Verdict; checks: Check[] }

/** What the earlier run of a comparison contributes to indicator 7. */
export interface Baseline { facts: RunFacts }

const minutes = (ms: number) => ms / 60_000;
const fmt = (value: number, digits = 1) => value.toFixed(digits);
const check = (name: string, pass: boolean, actual: string, target: string): Check => ({ name, verdict: pass ? "pass" : "fail", actual, target });
const unmeasurable = (name: string, target: string, missing: string, hook: string, actual = "not recorded"): Check => ({ name, verdict: "not_measurable", actual, target, missing, hook });
function indicator(id: number, title: string, checks: Check[]): Indicator {
 const verdict: Verdict = checks.some(c => c.verdict === "fail") ? "fail" : checks.some(c => c.verdict === "not_measurable") ? "not_measurable" : "pass";
 return { id, title, verdict, checks };
}

/** Linear model on TF-IDF-like features, read from the champion's source at the tagged commit. */
export function modelFamily(source: string | undefined, targets: Targets["simpleModel"]): { features: string[]; linear: string[]; nonLinear: string[] } {
 const found = (names: string[]) => source ? names.filter(name => new RegExp(`\\b${name}`).test(source)) : [];
 return { features: found(targets.featurePatterns), linear: found(targets.linearEstimators), nonLinear: found(targets.nonLinearEstimators) };
}

export function judge(facts: RunFacts, targets: Targets, baseline?: Baseline): Indicator[] {
 // The champion as it stood when the run ended (it may come from an earlier run).
 const champion = facts.champion && (facts.champion.taggedAt === undefined || facts.champion.taggedAt <= facts.run.endedAt + 1000) ? facts.champion : undefined;
 const handOver = facts.handOver.filter(h => h.inRun);
 const modelling = facts.stages.filter(stage => stage.role === "modelling");
 const completed = facts.trials.filter(trial => trial.status === "completed");

 // 1. A simple model is enough.
 const family = modelFamily(champion?.source, targets.simpleModel);
 const one = champion ? [
  check("champion is a linear model on TF-IDF-like features", family.features.length > 0 && family.linear.length > 0 && family.nonLinear.length === 0,
   `features: ${family.features.join(", ") || "none found"}; linear: ${family.linear.join(", ") || "none found"}; non-linear: ${family.nonLinear.join(", ") || "none"}`, "TF-IDF-like features and a linear estimator, nothing non-linear"),
  champion.score === undefined
   ? unmeasurable("champion CV score", `≥ ${targets.simpleModel.minCvScore}`, "the champion's trial-result.json", "keep the champion's training directory readable")
   : check("champion CV score", champion.score >= targets.simpleModel.minCvScore, fmt(champion.score, 4), `≥ ${targets.simpleModel.minCvScore}`),
 ] : [check("a champion exists", false, "no champion tag", "a champion/<task> tag after a completed promotion")];

 // 2. Finishes at the right time.
 const delivered = handOver.map(h => h.deliveredAt).filter((at): at is number => at !== undefined).sort()[0];
 const two = [
  delivered !== undefined
   ? check("hand-over time", minutes(delivered - facts.run.startedAt) <= targets.finish.maxHandOverMinutes, `${fmt(minutes(delivered - facts.run.startedAt))} min`,
    `≤ ${targets.finish.maxHandOverMinutes} min${targets.finish.aimHandOverMinutes ? ` (aim ${targets.finish.aimHandOverMinutes})` : ""}`)
   : check("hand-over time", false, `no hand-over (run ended after ${fmt(minutes(facts.run.durationMs))} min)`, `≤ ${targets.finish.maxHandOverMinutes} min`),
  check("follow-up rounds", Math.max(0, modelling.length - 1) <= targets.finish.maxFollowUpRounds, `${Math.max(0, modelling.length - 1)} (${modelling.length} modelling stage runs)`, `≤ ${targets.finish.maxFollowUpRounds}`),
  check("harness trials", facts.trials.length <= targets.finish.maxTrials, `${facts.trials.length} run (${facts.budget.trialsCharged} charged)`, `≤ ${targets.finish.maxTrials}`),
 ];

 // 3. Verifies well.
 const promotions = completed.filter(trial => trial.kind === "promotion").length;
 const validation = facts.stages.filter(stage => stage.role === "validation" && stage.outcome === "success");
 const three = [
  check("completed promotion trials", promotions >= targets.verify.minPromotionTrials, String(promotions), `≥ ${targets.verify.minPromotionTrials}`),
  ...(targets.verify.requireSealedCheck ? [!facts.sealed?.inRun
   ? check("sealed check ran", false, facts.sealed ? `only an earlier one (${facts.sealed.status})` : "no confirmation record", "a completed sealed-row confirmation")
   : facts.sealed.agrees === undefined
    ? unmeasurable("sealed check agrees with CV", "CV mean inside the sealed bootstrap interval", "the confirmation's interval or gap", "keep `interval` and `gap` in the confirmation result", facts.sealed.status)
    : check("sealed check agrees with CV", facts.sealed.status === "completed" && facts.sealed.agrees, `sealed ${fmt(facts.sealed.score ?? NaN, 4)}, CV ${fmt(facts.sealed.cvMean ?? NaN, 4)}, interval [${fmt(facts.sealed.interval!.lower, 4)}, ${fmt(facts.sealed.interval!.upper, 4)}]`, "CV mean inside the sealed bootstrap interval")] : []),
  ...(targets.verify.requireValidationChecks ? [check("validation checks recorded", validation.length > 0, `${validation.length} successful validation stage run(s)`, "≥ 1")] : []),
 ];

 // 4. Gives the measurements.
 const rows = handOver.map(h => h.rows).find(value => value !== undefined);
 const missingReports = facts.reports.agentStagesNeedingReport.filter(id => !facts.reports.stageReports.some(path => path.includes(id)));
 const memoryRecorded = facts.memory.trialsWithMemory > 0 || facts.memory.scripts.some(script => script.peakMemoryBytes !== undefined);
 const four = [
  check("hand-over predictions", rows === targets.measurements.handOverRows, rows === undefined ? "no hand-over files" : `${rows} rows`, `${targets.measurements.handOverRows} rows`),
  check("stage reports for every finished agent stage", missingReports.length === 0, `${facts.reports.stageReports.length} written; missing for ${missingReports.length}`, "one per finished agent stage"),
  check("harness scores and stage times recorded", completed.some(trial => trial.score !== undefined) && facts.stages.every(stage => stage.durationMs !== undefined),
   `${completed.filter(trial => trial.score !== undefined).length} scored trial(s); ${facts.stages.filter(stage => stage.durationMs !== undefined).length}/${facts.stages.length} stage times`, "≥ 1 scored trial; every stage timed"),
  memoryRecorded ? check("peak memory recorded", true, "recorded", "trials and agent scripts")
   : unmeasurable("peak memory recorded", "trials and agent scripts", "peak memory of trials and agent scripts", "P1: Linux sampler writes peakRssBytes to the trial's worker-exit.json and one line per observed script to processes.jsonl"),
 ];

 // 5. Reuses and modularises.
 const code = facts.code;
 const inSolutions = code.loaderImplementations.filter(path => code.files.find(file => file.path === path)?.role === "shared");
 const five = [
  check("data loading implemented once, in solutions/", code.loaderImplementations.length <= targets.reuse.maxLoaderImplementations && code.loaderImplementations.length === inSolutions.length && inSolutions.length > 0,
   `${code.loaderImplementations.length} implementation(s) in ${code.loaderFolders.length} folder(s): ${code.loaderFolders.join(", ") || "none"}`, `${targets.reuse.maxLoaderImplementations}, in solutions/`),
  check("agent Python outside solutions/", code.agentPythonOutsideSolutions.lines <= targets.reuse.maxAgentPythonLinesOutsideSolutions,
   `${code.agentPythonOutsideSolutions.lines} lines in ${code.agentPythonOutsideSolutions.files} files (${code.agentPythonOutsideSolutions.linesDuring} written during this run)`, `≤ ${targets.reuse.maxAgentPythonLinesOutsideSolutions} lines`),
  ...(targets.reuse.requireModuleIndex ? [code.moduleIndex.exists
   ? check("module index lists every module", code.moduleIndex.missing.length === 0, code.moduleIndex.missing.length ? `missing: ${code.moduleIndex.missing.join(", ")}` : "complete", "every solutions/ module")
   : unmeasurable("module index lists every module", "every solutions/ module", `${code.moduleIndex.path} does not exist; the workspace has no index yet`, "P6 writes the index; set `moduleIndex` in scorecard/layout.ts to its path")] : []),
 ];

 // 6. Costs little.
 const scriptPeaks = facts.memory.scripts.map(script => script.peakMemoryBytes).filter((value): value is number => value !== undefined);
 const six = [
  facts.minutesToFirstTrial !== undefined
   ? check("first harness trial after the modelling start", facts.minutesToFirstTrial <= targets.cost.maxMinutesToFirstTrial, `${fmt(facts.minutesToFirstTrial)} min`, `≤ ${targets.cost.maxMinutesToFirstTrial} min`)
   : check("first harness trial after the modelling start", false, facts.firstModellingStart ? "no harness trial" : "no modelling stage ran", `≤ ${targets.cost.maxMinutesToFirstTrial} min`),
  facts.budget.orchestratorRequestsWhileWaiting !== undefined
   ? check("orchestrator model requests while a stage runs", facts.budget.orchestratorRequestsWhileWaiting <= targets.cost.maxOrchestratorRequestsWhileWaiting, String(facts.budget.orchestratorRequestsWhileWaiting), `≤ ${targets.cost.maxOrchestratorRequestsWhileWaiting}`)
   : unmeasurable("orchestrator model requests while a stage runs", `≤ ${targets.cost.maxOrchestratorRequestsWhileWaiting}`, "which session made each charged model request",
    "coordinator.charge() adds `source: \"orchestrator\" | <stage invocation ID>` to the budget_reserved journal payload",
    `${facts.budget.modelRequestsDuringStages} requests charged while a stage ran (stage agents and orchestrator together); ${facts.budget.modelRequestsOutsideStages} outside stages (orchestrator only)`),
  scriptPeaks.length || facts.memory.trialsWithMemory
   ? check("no script above the memory limit", Math.max(0, ...scriptPeaks, facts.memory.trialPeakBytes ?? 0) <= targets.cost.maxScriptPeakGb * 1024 ** 3,
    `peak ${fmt(Math.max(0, ...scriptPeaks, facts.memory.trialPeakBytes ?? 0) / 1024 ** 3, 2)} GB`, `≤ ${targets.cost.maxScriptPeakGb} GB`)
   : unmeasurable("no script above the memory limit", `≤ ${targets.cost.maxScriptPeakGb} GB`, "peak memory of agent scripts and trials", "P1: run observed records peakRssBytes per script (processes.jsonl) and per trial"),
 ];

 // 7. Gets faster with memory.
 let seven: Check[];
 if (!baseline) seven = [unmeasurable("fewer model requests than an earlier run", "fewer", "an earlier run on the same task (or spam1 before spam2)", "pass --compare <earlier-run-id> or two --run options")];
 else {
  const before = baseline.facts;
  const ownLoaders = code.loaderImplementations.filter(path => code.files.find(file => file.path === path)?.period === "during");
  const earlierSolutionsLoader = code.files.some(file => file.role === "shared" && file.opensData && file.period === "before");
  const importsIt = code.files.filter(file => file.period === "during" && file.imports.some(path => { const target = code.files.find(f => f.path === path); return target?.role === "shared" && target.opensData && target.period === "before"; }));
  seven = [
   ...(targets.memory.requireFewerModelRequests ? [check("fewer model requests than the earlier run", facts.budget.modelRequests < before.budget.modelRequests, `${facts.budget.modelRequests} vs ${before.budget.modelRequests}`, "fewer")] : []),
   ...(targets.memory.requireLoaderReuse ? [check("imports the existing loader instead of writing one", earlierSolutionsLoader && importsIt.length > 0 && ownLoaders.length === 0,
    `existing solutions/ loader: ${earlierSolutionsLoader ? "yes" : "no"}; files importing it: ${importsIt.length}; loaders written during this run: ${ownLoaders.length}${ownLoaders.length ? ` (${ownLoaders.join(", ")})` : ""}`,
    "imports the earlier solutions/ loader, writes none")] : []),
  ];
 }

 return [
  indicator(1, "It realises a simple model is enough", one),
  indicator(2, "It finishes at the right time", two),
  indicator(3, "It verifies well", three),
  indicator(4, "It gives the measurements", four),
  indicator(5, "It reuses and modularises", five),
  indicator(6, "It costs little", six),
  indicator(7, "It gets faster with memory", seven),
 ];
}
