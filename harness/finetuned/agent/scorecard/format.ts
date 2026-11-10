/** Human-readable scorecard. */
import { relative } from "node:path";
import type { RunFacts } from "./facts.js";
import type { Indicator } from "./indicators.js";
import type { Comparison, ScorecardResult } from "./index.js";

const iso = (ms?: number) => ms === undefined ? "—" : new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
export function duration(ms?: number): string {
 if (ms === undefined) return "—";
 const seconds = Math.round(ms / 1000), h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
 return h ? `${h}h ${String(m).padStart(2, "0")}m` : m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
const gb = (bytes?: number) => bytes === undefined ? "not recorded" : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const MARK = { pass: "PASS", fail: "FAIL", not_measurable: "NOT MEASURABLE YET" } as const;

function numbers(f: RunFacts): string[] {
 const out: string[] = [];
 const rel = (path: string) => relative(f.runsDir, path);
 out.push(`Run ${f.run.runId} (${f.run.taskId})`);
 out.push(`  outcome            ${f.run.status}${f.run.reason ? ` — ${f.run.reason}` : ""}`);
 out.push(`  started / ended    ${iso(f.run.startedAt)} / ${iso(f.run.endedAt)}${f.run.ended ? "" : " (last journal entry)"}`);
 out.push(`  total time         ${duration(f.run.durationMs)}`);
 out.push("  stages:");
 for (const stage of f.stages) out.push(`    ${stage.stage.padEnd(9)} ${stage.invocationId.slice(0, 8)}  ${iso(stage.startedAt)}  ${duration(stage.durationMs).padStart(8)}${stage.endEstimated ? " (to last activity)" : ""}  ${stage.outcome ?? stage.status}${stage.error ? ` — ${stage.error.slice(0, 100)}` : ""}`);
 if (!f.stages.length) out.push("    none");
 out.push(`  per stage          ${f.stageTotals.map(t => `${t.stage} ${t.runs}× ${duration(t.totalMs)}`).join("; ") || "—"}`);
 out.push(`  modelling start → first harness trial  ${f.minutesToFirstTrial === undefined ? (f.firstModellingStart ? "no trial" : "no modelling stage") : `${f.minutesToFirstTrial.toFixed(1)} min (${iso(f.firstModellingStart)} → ${iso(f.firstTrialStart)})`}`);
 out.push(`  model requests     ${f.budget.modelRequests} (${f.budget.modelRequestsDuringStages} while a stage ran, ${f.budget.modelRequestsOutsideStages} outside stages)${f.budget.orchestratorRequestsWhileWaiting !== undefined ? `; orchestrator while waiting: ${f.budget.orchestratorRequestsWhileWaiting}` : ""}`);
 out.push(`  sessions / tools   ${f.budget.sessions} sessions, ${f.budget.toolCalls} tool calls, ${f.budget.retries} retries`);
 const kinds = ["pilot", "promotion", "search", "unknown"].map(kind => [kind, f.trials.filter(t => t.kind === kind)] as const).filter(([, list]) => list.length);
 out.push(`  harness trials     ${f.trials.length} started, ${f.trials.filter(t => t.status === "completed").length} completed (${f.budget.trialsCharged} charged to the budget)${kinds.length ? `; ${kinds.map(([kind, list]) => `${kind} ${list.filter(t => t.status === "completed").length}/${list.length}`).join(", ")}` : ""}`);
 for (const t of f.trials) out.push(`    ${t.kind.padEnd(9)} ${t.experimentId.slice(0, 8)}  ${iso(t.startedAt)}  ${t.status}${t.score !== undefined ? `  score ${t.score.toFixed(4)}` : ""}${t.durationSeconds !== undefined ? `  ${duration(t.durationSeconds * 1000)}` : ""}${t.exitCode !== undefined ? `  exit ${t.exitCode}` : ""}  memory ${gb(t.peakMemoryBytes)}`);
 const c = f.champion;
 out.push(`  champion           ${c ? `${c.experimentId.slice(0, 8)} @ ${c.commit.slice(0, 10)}${c.score !== undefined ? `, CV ${c.score.toFixed(4)}` : ""}${c.inRun ? " (tagged in this run)" : ` (tagged ${iso(c.taggedAt)}, not in this run)`}` : f.championUnknown ? "not measurable (historical evidence unavailable)" : "none"}`);
 const s = f.sealed;
 out.push(`  sealed check       ${s ? `${s.status}${s.score !== undefined ? `, sealed ${s.score.toFixed(4)}` : ""}${s.agrees !== undefined ? `, agrees with CV: ${s.agrees ? "yes" : "no"}` : ""}${s.inRun ? "" : " (not from this run)"}` : f.sealedUnknown ? "not measurable (historical evidence unavailable)" : "did not run"}`);
 const handOver = f.handOver.filter(h => h.inRun);
 out.push(`  hand-over          ${handOver.length ? handOver.map(h => `${rel(h.directory)}: ${h.files.join(", ")}; ${h.rows ?? "?"} rows`).join("; ") : "none"}${f.handOver.length > handOver.length ? ` (${f.handOver.length - handOver.length} from other runs)` : ""}`);
 out.push(`  stage reports      ${f.reports.stageReports.length}${f.reports.stageReports.length ? ` (${f.reports.stageReports.map(rel).join(", ")})` : ""}`);
 out.push(`  knowledge notes    ${f.reports.knowledgeNotes} new, ${f.reports.knowledgeRevisions} revisions by this run; ${f.reports.unknownRevisionAuthors} revisions with unknown authorship`);
 out.push(`  peak memory        trials: ${gb(f.memory.trialPeakBytes)}; agent scripts: ${f.memory.scripts.length ? f.memory.scripts.map(x => `${x.command.slice(0, 40)} ${gb(x.peakMemoryBytes)} ${x.durationSeconds?.toFixed(0) ?? "?"}s`).join("; ") : "not recorded"}`);
 out.push("  agent-written Python (lines; written during this run; files changed after it):");
 for (const folder of f.code.folders) out.push(`    ${folder.folder.padEnd(26)} ${String(folder.lines).padStart(5)} lines in ${String(folder.files).padStart(2)} files; during ${folder.linesDuring} lines/${folder.filesDuring} files${folder.filesAfter ? `; ${folder.filesAfter} changed after` : ""}${folder.role === "copy" ? "  [harness copy, not counted]" : ""}`);
 if (!f.code.folders.length) out.push("    none");
 out.push(`  outside solutions/ ${f.code.agentPythonOutsideSolutions.lines} lines in ${f.code.agentPythonOutsideSolutions.files} files`);
 out.push(`  data loading       ${f.code.loaderImplementations.length} confirmed implementation(s) in ${f.code.loaderFolders.length} folder(s)`);
 if (f.code.uncertainLoaders.length) out.push(`    uncertain read candidates: ${f.code.uncertainLoaders.join(", ")}`);
 for (const path of f.code.loaderImplementations) out.push(`    opens the task data: ${path}`);
 if (f.code.loaderImporters.length) out.push(`    import one of them: ${f.code.loaderImporters.length} file(s)`);
 if (f.code.cacheReaders.length) out.push(`    read a saved copy of the data instead: ${f.code.cacheReaders.join(", ")}`);
 for (const note of f.notes) out.push(`  note: ${note}`);
 return out;
}

function indicators(list: Indicator[]): string[] {
 const out = ["  Indicators:"];
 for (const item of list) {
  out.push(`  ${item.id}. ${item.title}: ${MARK[item.verdict]}`);
  for (const c of item.checks) {
   out.push(`     [${MARK[c.verdict].toLowerCase()}] ${c.name}: ${c.actual} (target ${c.target})`);
   if (c.verdict === "not_measurable") out.push(`        missing: ${c.missing}\n        hook: ${c.hook}`);
  }
 }
 return out;
}

function comparison(c: Comparison): string[] {
 const pair = (label: string, [a, b]: [number, number], digits = 0) => `  ${label.padEnd(16)} ${a.toFixed(digits)} → ${b.toFixed(digits)} (${b - a >= 0 ? "+" : ""}${(b - a).toFixed(digits)})`;
 return [`Comparison: ${c.earlier.slice(0, 8)} (earlier) → ${c.later.slice(0, 8)} (later)`,
  pair("model requests", c.modelRequests), pair("sessions", c.sessions), pair("tool calls", c.toolCalls), pair("minutes", c.durationMinutes, 1), pair("harness trials", c.trials),
  `  stages reached   ${c.stagesReached[0].join(", ") || "none"} → ${c.stagesReached[1].join(", ") || "none"}`,
  `  reuse            ${c.reuse.length} import(s) of modules that existed before the later run${c.reuse.length ? `: ${c.reuse.map(r => `${r.file} → ${r.imports}`).join("; ")}` : ""}`,
  `  new loaders      ${c.loadersWrittenByLater.length ? c.loadersWrittenByLater.join(", ") : "none"}`,
  ...c.caveats.map(caveat => `  caveat: ${caveat}`)];
}

export function formatScorecard(result: ScorecardResult): string {
 const out: string[] = [`Scorecard for ${result.task} (targets: targets/${result.targetsTask}.json; runs: ${result.runsDir})`, ""];
 for (const run of result.runs) out.push(...numbers(run.facts), "", ...indicators(run.indicators), "");
 if (result.comparison) out.push(...comparison(result.comparison), "");
 return out.join("\n");
}
