import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExperimentSupervisor } from "./supervisor.js";
import { MachineProtection } from "./protection.js";
import { HARNESS_CONFIG, parseHarnessConfig } from "../harness/config.js";
import { checkSupervision } from "./setup.js";
import { sampleGroup, linuxProcesses, sampleMachine } from "./sampler.js";
import { UpdateGate } from "./updates.js";
import { DEFAULT_LIMITS, type Update } from "./types.js";
import { createSupervisedBashTool } from "./bash.js";
import { SetupSession } from "../pipeline/setup.js";

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
 let executed = false;
 await expect((async () => {
  await new SetupSession().check([{ id: "process-supervision", phase: "local", remedy: "restore proc", run() { throw new Error("no sampler"); } }], new AbortController().signal, () => {});
  executed = true;
 })()).rejects.toThrow("restore proc");
 expect(executed).toBe(false);
});
test("time projection and flooding report once", () => {
 const gate = new UpdateGate(DEFAULT_LIMITS, 0);
 const view = { id: "fixture", status: "running" as const, scope: "trial", hypothesis: "test", elapsedSeconds: 30, linesEmitted: 0, cursor: 0, logPath: "/tmp/full.log" };
 const input = { now: 30000, pending: [], view, projectedDurationMs: 10000, outputBytes: 100000 };
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
test("supervised bash caps the response and keeps the spill, without killing flooding work", async () => {
 const root = mkdtempSync(join(tmpdir(), "bash-supervision-")); const updates: Update[] = [];
 try {
  const tool = createSupervisedBashTool(root, { root, env: { PATH: process.env.PATH! }, deliver: (_, u) => { updates.push(u); }, limits: { sampleIntervalMs: 25, stopGraceMs: 25 } });
  const result = await tool.execute("bash-fixture", { command: "head -c 100000 /dev/zero | tr '\\0' x; sleep 0.2" });
  expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(51200);
  expect(result.content[0].text).toContain("full output:");
  expect(result.details.status).toBe("exited");
  expect(updates.filter(u => u.kind === "flooding")).toHaveLength(1);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test.each([
 ["stalled", "await Bun.sleep(60000)"],
 ["stale", "while (true) { Math.sqrt(Math.random()); }"],
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
