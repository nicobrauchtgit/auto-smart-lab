import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperimentSupervisor } from "./supervisor.js";
import { MachineProtection } from "./protection.js";
import { HARNESS_CONFIG, parseHarnessConfig } from "../harness/config.js";
import { checkSupervision } from "./setup.js";
import { sampleGroup, linuxProcesses, sampleMachine } from "./sampler.js";
import { UpdateGate } from "./updates.js";
import { DEFAULT_LIMITS, type Update } from "./types.js";
import { createSupervisedBashTool, shellCommandKey, shellProjection } from "./bash.js";
import { SetupSession, setupChecks } from "../pipeline/setup.js";
import { loadPromptSnapshot } from "../prompts/loader.js";

const until = async (predicate: () => boolean) => {
 for (let i = 0; i < 200; i++) { if (predicate()) return; await Bun.sleep(25); }
 throw new Error("condition did not become true");
};
test("Linux sampler reads live CPU, RSS, I/O and own children; setup is read-only", () => {
 checkSupervision();
 if (process.platform !== "linux") return;
 const own = linuxProcesses().find(p => p.pid === process.pid)!;
 expect(own.rssBytes).toBeGreaterThan(0);
 expect(own.cpuSeconds).toBeGreaterThan(0);
 const group = sampleGroup(own.pgid)!;
 expect(group.pids).toContain(process.pid);
 expect(group.readBytes).toBeGreaterThanOrEqual(0);
 expect(sampleMachine().availableBytes).toBeGreaterThan(0);
});
test("invalid supervision prevents configuration and preflight prevents execution", async () => {
 const config = structuredClone(HARNESS_CONFIG); config.supervision.outputCapBytes = 0;
 expect(() => parseHarnessConfig(config)).toThrow("supervision.outputCapBytes");
});
test("every agent or trial requirement runs the real process-supervision check, and its failure blocks execution", async () => {
 const prompts = loadPromptSnapshot();
 for (const requirement of ["supervision", "model", "training", "refit"] as const) {
  expect(setupChecks([requirement], { taskId: "fixture", prompts }).map(check => check.id)).toContain("process-supervision");
 }
 expect(setupChecks(["submission-recovery"], { taskId: "fixture", prompts }).map(check => check.id)).not.toContain("process-supervision");
 // The production check passes on this machine...
 const [healthy] = setupChecks(["supervision"], { taskId: "fixture", prompts });
 await new SetupSession().check([healthy], new AbortController().signal, () => {});
 // ...and an unreadable /proc stops everything before any stage runs.
 const missing = join(mkdtempSync(join(tmpdir(), "no-proc-")), "proc");
 const checks = setupChecks(["training"], { taskId: "fixture", prompts, supervisionProcRoot: missing })
  .filter(check => check.id === "process-supervision");
 const results: Record<string, unknown>[] = [];
 let executed = false;
 await expect((async () => {
  await new SetupSession().check(checks, new AbortController().signal, (event, payload) => { if (event === "setup_check") results.push(payload); });
  executed = true;
 })()).rejects.toThrow(/process-supervision: .*\/proc/);
 expect(executed).toBe(false);
 expect(results).toEqual([expect.objectContaining({ id: "process-supervision", status: "failed" })]);
});
test("time projection and flooding report once", () => {
 const gate = new UpdateGate(DEFAULT_LIMITS, 0);
 const view = { id: "fixture", status: "running" as const, scope: "trial", hypothesis: "test", elapsedSeconds: 30, linesEmitted: 0, cursor: 0, logPath: "/tmp/full.log" };
 const input = { now: 200_000, pending: [], view, projectedDurationMs: 10_000, outputBytes: 100_000 };
 expect(gate.decide(input)?.kind).toBe("flooding");
 expect(gate.decide(input)?.kind).toBe("time-wasting");
 expect(gate.decide(input)).toBeNull();
});
test("a pressure stop informs the owner, retains peak memory and allows the next trial", async () => {
 const root = mkdtempSync(join(tmpdir(), "pressure-"));
 let pressure = false;
 const updates: Update[] = [];
 const guard = new MachineProtection(HARNESS_CONFIG.supervision, () => ({ availableBytes: pressure ? 0 : 4e9, totalBytes: 16e9, swapFreeBytes: 0, swapTotalBytes: 0 }));
 const supervisor = new ExperimentSupervisor({ root, env: { PATH: process.env.PATH! }, protection: guard,
  deliver: (_, u) => { updates.push(u); }, limits: { sampleIntervalMs: 25, stopGraceMs: 25 } });
 try {
  const first = supervisor.start({ cwd: root, argv: [process.execPath, "-e", "const memory = new Uint8Array(8e6).fill(1); await Bun.sleep(60000); console.log(memory.length)"], scope: "fixture", hypothesis: "pressure" });
  await until(() => (supervisor.status(first.id).rssMb ?? 0) > 0);
  pressure = true;
  await until(() => supervisor.status(first.id).status === "stopped");
  const report = updates.find(u => u.kind === "machine-at-risk")!;
  expect(report.note).toContain("this experiment was too big for the machine");
  expect(report.note).toContain("peak memory");
  expect(report.view.rssMb).toBeGreaterThan(0);
  pressure = false;
  const next = supervisor.start({ cwd: root, argv: [process.execPath, "-e", "console.log('next trial')"], scope: "fixture", hypothesis: "continue" });
  await until(() => supervisor.status(next.id).status === "exited");
  expect(supervisor.output(next.id).text).toContain("next trial");
 } finally { await supervisor.close(); rmSync(root, { recursive: true, force: true }); }
});
test("supervised bash keeps the end of a flooding output within the cap and adds no exit or diagnostic report", async () => {
 const root = mkdtempSync(join(tmpdir(), "bash-supervision-")); const updates: Update[] = [];
 let tool: ReturnType<typeof createSupervisedBashTool> | undefined;
 try {
  tool = createSupervisedBashTool(root, { root, env: { PATH: process.env.PATH! }, deliver: (_, u) => { updates.push(u); }, limits: { sampleIntervalMs: 25, stopGraceMs: 25 } });
  const result = await tool.execute("bash-fixture", { command: "head -c 100000 /dev/zero | tr '\\0' x; echo; echo 'Traceback (most recent call last):'; echo 'ValueError: the last line'; sleep 0.2" });
  const text = result.content[0].text;
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(DEFAULT_LIMITS.outputCapBytes);
  expect(text).toContain("ValueError: the last line");
  expect(text).toMatch(/^\[\d+ earlier bytes omitted; the full output is in /);
  expect(text).toContain(`full output: ${result.details.spillPath}`);
  expect(text).toContain("exit code: 0");
  expect(result.details.status).toBe("exited");
  expect(result.details.omittedBytes).toBeGreaterThan(0);
  // The full output is in the spill file, and the shown tail is exactly its end.
  const full = readFileSync(result.details.spillPath, "utf8");
  expect(full.length).toBeGreaterThan(100_000);
  const shown = text.slice(text.indexOf("\n") + 1, text.lastIndexOf("\nexit code:"));
  expect(full.endsWith(`${shown}\n`)).toBe(true);
  await Bun.sleep(100);
  // No exit or diagnostic update on top of the tool result; flooding is reported
  // at most once, and only while the call was still running.
  expect(updates.filter(update => update.kind !== "flooding")).toEqual([]);
  expect(updates.length).toBeLessThanOrEqual(1);
 } finally { await tool?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a short shell call after quick ones of a different kind is not time-wasting", async () => {
 const root = mkdtempSync(join(tmpdir(), "bash-projection-")); const updates: Update[] = [];
 let tool: ReturnType<typeof createSupervisedBashTool> | undefined;
 try {
  tool = createSupervisedBashTool(root, { root, env: { PATH: process.env.PATH! }, deliver: (_, u) => { updates.push(u); }, limits: { sampleIntervalMs: 25, stopGraceMs: 25 } });
  for (let i = 0; i < 3; i++) await tool.execute(`quick-${i}`, { command: "true" });
  expect(shellProjection(shellCommandKey(root, "true"))).toBeDefined();
  expect(shellProjection(shellCommandKey(root, "sleep 1.2"))).toBeUndefined();
  const slow = await tool.execute("slow", { command: "sleep 1.2" });
  expect(slow.details.status).toBe("exited");
  expect(updates).toEqual([]);
 } finally { await tool?.close(); rmSync(root, { recursive: true, force: true }); }
});

test.each([
 ["stalled", "await Bun.sleep(60000)"],
 // A sustained output rhythm, then busy silence far beyond its longest gap.
 ["stale", "for (let i = 0; i < 6; i++) { console.log(`epoch ${i}`); await Bun.sleep(80); } while (true) { Math.sqrt(Math.random()); }"],
] as const)("a %s script reports once and remains running", async (kind, script) => {
 const root = mkdtempSync(join(tmpdir(), "finding-"));
 const updates: Update[] = [];
 const supervisor = new ExperimentSupervisor({ root, env: { PATH: process.env.PATH! },
  deliver: (_, update) => { updates.push(update); },
  limits: { sampleIntervalMs: 25, minStallMs: 250, importPreludeMs: 250, stopGraceMs: 25 } });
 try {
  const view = supervisor.start({ cwd: root, argv: [process.execPath, "-e", script], hypothesis: "finding fixture", scope: "fixture" });
  await until(() => updates.some(update => update.kind === kind));
  await Bun.sleep(350);
  expect(updates.filter(update => update.kind === kind)).toHaveLength(1);
  expect(supervisor.status(view.id).status).toBe("running");
  expect(updates[0].view.rssMb).toBeGreaterThan(0);
  expect(updates[0].view.cpuPercent).toBeDefined();
 } finally { await supervisor.close(); rmSync(root, { recursive: true, force: true }); }
});
