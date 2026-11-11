import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ExperimentSupervisor, type SupervisorOptions } from "./supervisor.js";
import { HARNESS_CONFIG } from "../harness/config.js";

/** Blocking shell tool, with the same sampler/arbiter as harness trials.
 * Callers supply the owning session's delivery and reporter callbacks.
 * root must be writable and visible to that session's read tool.
 */
const durations = new Map<string, number[]>();

export function createSupervisedBashTool(cwd: string, options: SupervisorOptions) {
 const definition = createBashToolDefinition(cwd);
 return { ...definition,
  async execute(id: string, args: { command: string; timeout?: number }, signal?: AbortSignal) {
   signal?.throwIfAborted();
   mkdirSync(options.root, { recursive: true });
   const history = durations.get(cwd) ?? [];
   const projection = history.length >= 3 ? [...history].sort((a, b) => a - b)[Math.floor(history.length / 2)] : undefined;
   const root = mkdtempSync(join(options.root, "bash-"));
   const supervisor = new ExperimentSupervisor({ ...options, root });
   const view = supervisor.start({ argv: ["bash", "-c", args.command], cwd,
    hypothesis: "agent shell call", scope: "shell", projectedDurationMs: projection }, id);
   const abort = () => { void supervisor.stop(view.id, "owning session cancelled"); };
   signal?.addEventListener("abort", abort, { once: true });
   try {
    while (supervisor.status(view.id).status === "running") {
     signal?.throwIfAborted();
     await new Promise(resolve => setTimeout(resolve, HARNESS_CONFIG.supervision.sampleIntervalMs));
    }
    const final = supervisor.status(view.id);
    if (final.status === "exited") durations.set(cwd, [...history, final.elapsedSeconds * 1000].slice(-20));
    const output = supervisor.output(view.id, 0, HARNESS_CONFIG.supervision.outputCapBytes);
    const suffix = `\nexit code: ${final.exitCode ?? final.status}${final.stopReason ? `; ${final.stopReason}` : ""}\nfull output: ${final.logPath}`;
    // The complete response, including the spill pointer, fits the cap.
    const allowance = Math.max(0, HARNESS_CONFIG.supervision.outputCapBytes - Buffer.byteLength(suffix) - 3);
    return { content: [{ type: "text" as const, text: Buffer.from(output.text).subarray(0, allowance).toString("utf8") + suffix }],
     details: { ...final, spillPath: final.logPath } };
   } finally {
    signal?.removeEventListener("abort", abort);
    await supervisor.close();
   }
  },
 };
}
