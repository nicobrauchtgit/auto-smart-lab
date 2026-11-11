/**
 * The scorecard of a finetuned run: plain numbers, the seven indicators of
 * a good run, and with two runs the differences indicator 7 needs.
 * Read-only; see README.md.
 */
import { resolve } from "node:path";
import { listRuns, readRunFacts, type RunFacts } from "./facts.js";
import { judge, loadTargets, type Indicator, type Targets } from "./indicators.js";
import { LAYOUT, type ScorecardLayout } from "./layout.js";

export { LAYOUT } from "./layout.js";
export type { RunFacts } from "./facts.js";
export type { Indicator, Targets, Verdict } from "./indicators.js";

export interface Comparison {
 earlier: string; later: string;
 modelRequests: [number, number]; sessions: [number, number]; toolCalls: [number, number];
 durationMinutes: [number, number]; trials: [number, number];
 stagesReached: [string[], string[]];
 /** Files the later run changed that import a module last changed before it. */
 reuse: { file: string; imports: string }[];
 loadersWrittenByLater: string[];
 caveats: string[];
}
export interface ScorecardResult { task: string; runsDir: string; targetsTask: string; runs: { facts: RunFacts; indicators: Indicator[] }[]; comparison?: Comparison }

export function compare(earlier: RunFacts, later: RunFacts): Comparison {
 const reached = (facts: RunFacts) => [...new Set(facts.stages.map(stage => stage.stage))];
 const caveats: string[] = [];
 if (reached(earlier).join() !== reached(later).join()) caveats.push(`the runs reached different stages (${reached(earlier).join(", ") || "none"} vs ${reached(later).join(", ") || "none"}); counts are not like for like`);
 if (earlier.run.status !== later.run.status || earlier.run.reason !== later.run.reason) caveats.push(`the runs ended differently ("${earlier.run.reason ?? earlier.run.status}" vs "${later.run.reason ?? later.run.status}")`);
 return {
  earlier: earlier.run.runId, later: later.run.runId,
  modelRequests: [earlier.budget.modelRequests, later.budget.modelRequests], sessions: [earlier.budget.sessions, later.budget.sessions], toolCalls: [earlier.budget.toolCalls, later.budget.toolCalls],
  durationMinutes: [earlier.run.durationMs / 60_000, later.run.durationMs / 60_000], trials: [earlier.trials.length, later.trials.length],
  stagesReached: [reached(earlier), reached(later)],
  reuse: later.code.reusedExisting,
  loadersWrittenByLater: later.code.loaderImplementations.filter(path => later.code.files.find(file => file.path === path)?.period === "during"),
  caveats,
 };
}

export function scorecard(options: { task: string; runIds?: string[]; compareWith?: string; runsDir: string; targetsPath?: string; layout?: ScorecardLayout }): ScorecardResult {
 const layout = options.layout ?? LAYOUT;
 const runsDir = resolve(options.runsDir);
 const targets: Targets = loadTargets(options.task, options.targetsPath);
 const known = listRuns(runsDir, options.task, layout);
 if (!known.length) throw new Error(`No runs for task ${options.task} under ${runsDir}`);
 const ids = options.runIds?.length ? [...options.runIds] : [known[0].runId];
 if (options.compareWith) ids.push(options.compareWith);
 const unique = [...new Set(ids)];
 if (unique.length > 2) throw new Error("Give one run, or two to compare");
 for (const id of unique) if (!known.some(run => run.runId === id)) throw new Error(`Unknown run ${id}; runs of ${options.task}: ${known.map(run => run.runId).join(", ")}`);
 const facts = unique.map(runId => readRunFacts({ runsDir, task: options.task, runId, layout, metricKey: targets.metric.trialKey }))
  .sort((a, b) => a.run.startedAt - b.run.startedAt);
 const runs = facts.map((run, index) => ({ facts: run, indicators: judge(run, targets, index > 0 ? { facts: facts[0] } : undefined) }));
 return { task: options.task, runsDir, targetsTask: targets.task, runs, comparison: facts.length === 2 ? compare(facts[0], facts[1]) : undefined };
}

/** JSON without the champion's source text. */
export function toJson(result: ScorecardResult): unknown {
 return JSON.parse(JSON.stringify(result, (key, value) => key === "source" && typeof value === "string" ? `${value.split("\n").length} lines` : value));
}
