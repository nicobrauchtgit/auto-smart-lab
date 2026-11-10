/** One line per run event, printed by every orchestrator run (detached runs write them to their log). */
import type { ProgressEvent } from "./coordinator.js";
export type RunProgressEvent = ProgressEvent
 | { kind: "run_started"; runId: string; taskId: string; resumed: boolean; stateDirectory: string }
 | { kind: "run_ended"; runId: string; outcome: string; reason: string };
/** The objective's first words, enough to tell stages apart in a log. */
function firstWords(text: string, words = 10): string {
 const parts = text.trim().replace(/\s+/g, " ").split(" ");
 return parts.length > words ? `${parts.slice(0, words).join(" ")} …` : parts.join(" ");
}
export function formatDuration(ms: number): string {
 const seconds = Math.max(0, Math.round(ms / 1000)), h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
 return h ? `${h}h ${String(m).padStart(2, "0")}m` : m ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}
export function formatProgress(event: RunProgressEvent, now = new Date()): string {
 const at = `[run ${now.toISOString().slice(0, 19).replace("T", " ")}Z]`;
 const short = (id: string) => id.slice(0, 8);
 switch (event.kind) {
  case "run_started": return `${at} run ${event.runId} ${event.resumed ? "resumed" : "started"} for ${event.taskId}; state in ${event.stateDirectory}`;
  case "stage_started": return `${at} stage started: ${event.stage} ${short(event.invocationId)}${event.origin === "budget_end" ? " (harness hand-over at budget end)" : ""} — "${firstWords(event.objective)}"`;
  case "stage_finished": return `${at} stage finished: ${event.stage} ${short(event.invocationId)} ${event.outcome}, ${event.valid ? "valid" : "not valid"}${event.durationMs === undefined ? "" : `, ${formatDuration(event.durationMs)}`}${event.error ? ` — ${event.error.replace(/\s+/g, " ").slice(0, 160)}` : ""}`;
  case "hand_over": return `${at} hand-over: ${event.handedOver ? "" : "none — "}${event.reason}`;
  case "run_ended": return `${at} run ${event.runId} ended: ${event.outcome} — ${event.reason}`;
 }
}
