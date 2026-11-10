/**
 * Every assumption the scorecard makes about where a finetuned run leaves its
 * facts. The workspace is about to change (all agents in `solutions/`; four
 * experts instead of research, solve and review): adapt this file, not the
 * readers. Paths are relative to the runs directory (`runs/finetuned/`);
 * `{task}` and `{invocation}` are substituted.
 */
export interface CodeFolder {
 /** Shown in the output. */
 label: string;
 /** Relative to the runs directory. */
 path: string;
 /** agent: written by agents; shared: the versioned solutions/ workspace; copy: a harness copy of another folder (not counted as agent code). */
 role: "agent" | "shared" | "copy";
}

export interface ScorecardLayout {
 /** One directory per run, holding `state.json`. */
 runsOfTask: string;
 stateFile: string;
 /** Stage names by role. The orchestrator's `works[].stage` is matched against these. */
 stages: { research: string[]; modelling: string[]; validation: string[]; handOver: string[]; agent: string[] };
 /** Where the harness puts a modelling stage's trials. A trial is a directory below it with `request.json`. */
 trainingDir: string;
 /** The versioned workspace with the champion tag. */
 solutionsRoot: string;
 championTag: string;
 /** Prefix of `pipeline.module` in a trial request that names the solutions repository root. */
 solutionsModulePrefix: string;
 /** Sealed-row confirmation pointer (`{ path, sha256 }`). */
 confirmationPointer: string;
 /** Hand-over directories, one per delivered candidate. */
 deliveries: string;
 handOverFile: string;
 handOverManifest: string;
 reportsDir: string;
 knowledgeIndex: string;
 /** The module index the redesign asks for; absent today. */
 moduleIndex: string;
 /** Python folders the census walks. Anything else below `{task}/` is listed as unclassified. */
 codeFolders: CodeFolder[];
 /** Below `{task}/`: harness-owned directories whose Python is never agent code (trial source snapshots, data). */
 harnessOwned: string[];
 /**
  * Files P1's "run observed" may write, one JSON line per agent script. The scorecard reads
  * any of these names found below `{task}/` or the solutions root. Fields read: see README.
  */
 scriptObservationFiles: string[];
 /** Trial files searched for a recorded peak memory. */
 trialResourceFiles: string[];
}

export const LAYOUT: ScorecardLayout = {
 runsOfTask: "{task}/pipeline",
 stateFile: "state.json",
 stages: { research: ["research"], modelling: ["solve"], validation: ["evaluate"], handOver: ["refit"], agent: ["research", "solve", "evaluate"] },
 trainingDir: "{task}/solve/training/{invocation}",
 solutionsRoot: "solutions",
 championTag: "champion/{task}",
 solutionsModulePrefix: "solutions/",
 confirmationPointer: "{task}/confirmation/latest.json",
 deliveries: "deliveries/{task}",
 handOverFile: "output.csv",
 handOverManifest: "manifest.json",
 reportsDir: "{task}/reports",
 knowledgeIndex: "knowledge/index.json",
 moduleIndex: "solutions/INDEX.md",
 codeFolders: [
  { label: "research scripts", path: "{task}/research", role: "agent" },
  { label: "solve scratch", path: "{task}/solve/agent", role: "agent" },
  { label: "solve's copy of research", path: "{task}/solve/research", role: "copy" },
  { label: "solutions", path: "solutions", role: "shared" },
 ],
 harnessOwned: ["{task}/solve/training", "{task}/solve/data", "{task}/pipeline", "{task}/confirmation", "{task}/refit"],
 scriptObservationFiles: ["processes.jsonl", "observed-processes.jsonl"],
 trialResourceFiles: ["worker-runtime.json", "worker-exit.json", "supervisor-state.json", "trial-result.json", "resources.json"],
};

export function place(template: string, values: { task: string; invocation?: string }): string {
 return template.replaceAll("{task}", values.task).replaceAll("{invocation}", values.invocation ?? "");
}
