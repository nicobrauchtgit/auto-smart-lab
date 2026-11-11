/**
 * The seven indicators of a good run, judged against a
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
 simpleModel: { minCvScore: number | null; maxFitSeconds: number | null; familyHint?: boolean; featurePatterns?: string[]; linearEstimators?: string[]; nonLinearEstimators?: string[] };
 finish: { maxHandOverMinutes: number; aimHandOverMinutes?: number; maxFollowUpRounds: number; maxTrials: number };
 verify: { minPromotionTrials: number; requireSealedCheck: boolean; requireValidationChecks: boolean };
 measurements: { handOverRows: number | null };
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
 const found = (names: string[] = []) => source ? names.filter(name => new RegExp(`\\b${name}`).test(source)) : [];
 return { features: found(targets.featurePatterns), linear: found(targets.linearEstimators), nonLinear: found(targets.nonLinearEstimators) };
}

export function judge(facts: RunFacts, targets: Targets, baseline?: Baseline): Indicator[] {
 // The champion as it stood when the run ended (it may come from an earlier run).
 const champion = facts.champion && (facts.champion.taggedAt === undefined || facts.champion.taggedAt <= facts.run.endedAt + 1000) ? facts.champion : undefined;
 const handOver = facts.handOver.filter(h => h.inRun);
 const modelling = facts.stages.filter(stage => stage.role === "modelling");
 const completed = facts.trials.filter(trial => trial.status === "completed");

 // Model design is task-owned. Only recorded performance and cost affect verdicts.
 const one: Check[] = champion ? [
  targets.simpleModel.minCvScore === null
   ? unmeasurable("champion score", "no target set", "no target set", "set simpleModel.minCvScore in the task targets")
   : champion.score === undefined
    ? unmeasurable("champion score", `≥ ${targets.simpleModel.minCvScore}`, "champion score", "retain the selected trial result")
    : check("champion score", champion.score >= targets.simpleModel.minCvScore, fmt(champion.score, 4), `≥ ${targets.simpleModel.minCvScore}`),
  targets.simpleModel.maxFitSeconds === null
   ? unmeasurable("champion fit time", "no target set", "no target set", "set simpleModel.maxFitSeconds relative to the task reference")
   : champion.fitSeconds === undefined
    ? unmeasurable("champion fit time", `≤ ${targets.simpleModel.maxFitSeconds} s`, "recorded fit time", "retain diagnostics.fitSeconds in the selected trial result")
    : check("champion fit time", champion.fitSeconds <= targets.simpleModel.maxFitSeconds, `${fmt(champion.fitSeconds)} s`, `≤ ${targets.simpleModel.maxFitSeconds} s`),
 ] : [facts.championUnknown
  ? unmeasurable("a champion exists", "a recorded selection", "historical selection evidence", "retain training_selected_result and its invocation")
  : check("a champion exists", false, "no champion", "a recorded selection after a completed promotion")];
 // A lexical hint is explicitly optional and never contributes a verdict.
 if (targets.simpleModel.familyHint && champion) {
  const family = modelFamily(champion.source, targets.simpleModel);
  one[0].actual += `; optional lexical family hint (not verified): ${JSON.stringify(family)}`;
 }
 const rounds = modelling.reduce((counts, stage, i) => {
  if (i) { if (modelling[i - 1].outcome === "success") counts.followUps++; else counts.retries++; }
  return counts;
 }, { followUps: 0, retries: 0 });
 const memoryCovered = facts.trials.length > 0 && facts.memory.trialsWithMemory === facts.trials.length
  && facts.memory.scripts.length > 0 && facts.memory.scripts.every(script => script.peakMemoryBytes !== undefined);

 // 2. Finishes at the right time.
 const delivered = handOver.map(h => h.deliveredAt).filter((at): at is number => at !== undefined).sort()[0];
 const two = [
  delivered !== undefined
   ? check("hand-over time", minutes(delivered - facts.run.startedAt) <= targets.finish.maxHandOverMinutes, `${fmt(minutes(delivered - facts.run.startedAt))} min`,
    `≤ ${targets.finish.maxHandOverMinutes} min${targets.finish.aimHandOverMinutes ? ` (aim ${targets.finish.aimHandOverMinutes})` : ""}`)
   : check("hand-over time", false, `no hand-over (run ended after ${fmt(minutes(facts.run.durationMs))} min)`, `≤ ${targets.finish.maxHandOverMinutes} min`),
  check("follow-up rounds", rounds.followUps <= targets.finish.maxFollowUpRounds, `${rounds.followUps} (${rounds.retries} retries; ${modelling.length} modelling stage runs)`, `≤ ${targets.finish.maxFollowUpRounds}`),
  check("harness trials", facts.trials.length <= targets.finish.maxTrials, `${facts.trials.length} run (${facts.budget.trialsCharged} charged)`, `≤ ${targets.finish.maxTrials}`),
 ];

 // 3. Verifies well.
 const promotions = completed.filter(trial => trial.kind === "promotion").length;

 const three = [
  check("completed promotion trials", promotions >= targets.verify.minPromotionTrials, String(promotions), `≥ ${targets.verify.minPromotionTrials}`),
  ...(targets.verify.requireSealedCheck ? [!facts.sealed?.inRun
   ? facts.sealedUnknown ? unmeasurable("sealed check ran", "a completed sealed-row confirmation", "historical confirmation record", "retain this run’s holdout_confirmation artifact") : check("sealed check ran", false, facts.sealed ? `only an earlier one (${facts.sealed.status})` : "no confirmation record", "a completed sealed-row confirmation")
   : facts.sealed.agrees === undefined
    ? unmeasurable("sealed check agrees with CV", "CV mean inside the sealed bootstrap interval", "the confirmation's interval or gap", "keep `interval` and `gap` in the confirmation result", facts.sealed.status)
    : check("sealed check agrees with CV", facts.sealed.status === "completed" && facts.sealed.agrees, `sealed ${fmt(facts.sealed.score ?? NaN, 4)}, CV ${fmt(facts.sealed.cvMean ?? NaN, 4)}, interval [${fmt(facts.sealed.interval!.lower, 4)}, ${fmt(facts.sealed.interval!.upper, 4)}]`, "CV mean inside the sealed bootstrap interval")] : []),
  ...(targets.verify.requireValidationChecks ? [facts.reports.validationReports.length > 0 ? check("validation checks recorded", true, `${facts.reports.validationReports.length} readable structured report(s)`, "≥ 1") : unmeasurable("validation checks recorded", "≥ 1 readable structured report", "evaluation report with validation, review and metrics fields", "retain the evaluation_report artifact")] : []),
 ];

 // 4. Gives the measurements.
 const rows = handOver.map(h => h.rows).find(value => value !== undefined);
 const missingReports = facts.reports.agentStagesNeedingReport.filter(id => !facts.reports.stageReports.some(path => path.includes(id)));

 const four = [
  targets.measurements.handOverRows === null ? unmeasurable("hand-over predictions", "no target set", "no target set", "set measurements.handOverRows") : check("hand-over predictions", rows === targets.measurements.handOverRows, rows === undefined ? "no hand-over files" : `${rows} rows`, `${targets.measurements.handOverRows} rows`),
  check("stage reports for every finished agent stage", missingReports.length === 0, `${facts.reports.stageReports.length} written; missing for ${missingReports.length}`, "one per finished agent stage"),
  check("harness scores and stage times recorded", completed.some(trial => trial.score !== undefined) && facts.stages.every(stage => stage.durationMs !== undefined),
   `${completed.filter(trial => trial.score !== undefined).length} scored trial(s); ${facts.stages.filter(stage => stage.durationMs !== undefined).length}/${facts.stages.length} stage times`, "≥ 1 scored trial; every stage timed"),
  memoryCovered ? check("peak memory recorded", true, "recorded", "trials and agent scripts")
   : unmeasurable("peak memory recorded", "trials and agent scripts", "peak memory of trials and agent scripts", "P1: Linux sampler writes peakRssBytes to the trial's worker-exit.json and one line per observed script to processes.jsonl"),
 ];

 // 5. Reuses and modularises.
 const code = facts.code;
 const inSolutions = code.loaderImplementations.filter(path => code.files.find(file => file.path === path)?.role === "shared");
 const five = [
  ...(code.uncertainLoaders.length && code.loaderImplementations.length <= targets.reuse.maxLoaderImplementations ? [unmeasurable("data loading implemented once, in solutions/", "one confirmed implementation", "uncertain read operations: " + code.uncertainLoaders.join(", "), "inspect path provenance or record loader calls")] : [check("data loading implemented once, in solutions/", code.loaderImplementations.length <= targets.reuse.maxLoaderImplementations && code.loaderImplementations.length === inSolutions.length && inSolutions.length > 0,
   `${code.loaderImplementations.length} confirmed implementation(s) in ${code.loaderFolders.length} folder(s): ${code.loaderFolders.join(", ") || "none"}`, `${targets.reuse.maxLoaderImplementations}, in solutions/`)]),
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
  (memoryCovered || Math.max(0, ...scriptPeaks, facts.memory.trialPeakBytes ?? 0) > targets.cost.maxScriptPeakGb * 1024 ** 3)
   ? check("no script above the memory limit", Math.max(0, ...scriptPeaks, facts.memory.trialPeakBytes ?? 0) <= targets.cost.maxScriptPeakGb * 1024 ** 3,
    `peak ${fmt(Math.max(0, ...scriptPeaks, facts.memory.trialPeakBytes ?? 0) / 1024 ** 3, 2)} GB`, `≤ ${targets.cost.maxScriptPeakGb} GB`)
   : unmeasurable("no script above the memory limit", `≤ ${targets.cost.maxScriptPeakGb} GB`, "peak memory of agent scripts and trials", "P1: run observed records peakRssBytes per script (processes.jsonl) and per trial"),
 ];

 // 7. Gets faster with memory.
 let seven: Check[];
 if (!baseline) seven = [unmeasurable("fewer model requests than an earlier run", "fewer", "an earlier comparable run", "pass --compare <earlier-run-id> or two --run options")];
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
  indicator(1, "It meets the task score and compute targets", one),
  indicator(2, "It finishes at the right time", two),
  indicator(3, "It verifies well", three),
  indicator(4, "It gives the measurements", four),
  indicator(5, "It reuses and modularises", five),
  indicator(6, "It costs little", six),
  indicator(7, "It gets faster with memory", seven),
 ];
}
