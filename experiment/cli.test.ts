import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseExperimentArgs, taskSelection } from "./cli.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("--detach and --resume reach the finetuned arm; the task is read like the pipeline CLI reads it", () => {
	const parsed = parseExperimentArgs(["--arm", "finetuned", "spam1", "--detach", "--resume", "run-1"]);
	expect(parsed).toMatchObject({ arm: "finetuned", detach: true, rest: ["spam1", "--resume", "run-1"] });
	expect(parseExperimentArgs(["--arm", "finetuned", "spam1"]).detach).toBe(false);
	expect(taskSelection(["spam1", "--resume", "run-1"])).toEqual({ taskId: "spam1" });
	expect(taskSelection(["--model", "p/m", "unit", "1", "task", "2"])).toEqual({ unit: "1", task: "2" });
	expect(taskSelection(["--unit", "1", "3", "--echo-events"])).toEqual({ unit: "1", task: "3" });
});

test("a detached run survives its launching shell and its log shows the progress lines", async () => {
	const directory = mkdtempSync(join(tmpdir(), "detach-")), logPath = join(directory, "runs", "finetuned", "fixture", "logs", "run.log");
	// A fake pipeline command: prints the orchestrator's progress lines over about two seconds.
	const fake = join(directory, "fake_pipeline.ts");
	writeFileSync(fake, `import { formatProgress } from ${JSON.stringify(join(ROOT, "harness/finetuned/agent/orchestrator/progress.ts"))};
const say = (event: any) => console.log(formatProgress(event)); const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
say({ kind: "run_started", runId: "fake-run", taskId: "fixture", resumed: false, stateDirectory: "runs/finetuned/fixture/pipeline/fake-run" });
say({ kind: "stage_started", stage: "solve", invocationId: "solve-0001", objective: "Build the baseline pipeline" });
await sleep(1500);
say({ kind: "stage_finished", stage: "solve", invocationId: "solve-0001", outcome: "success", valid: true, durationMs: 1500 });
say({ kind: "hand_over", handedOver: true, reason: "Handed over at budget end (deadline reached): terminal refit r1" });
say({ kind: "run_ended", runId: "fake-run", outcome: "success", reason: "Handed over at budget end (deadline reached): terminal refit r1" });
`);
	const launcher = join(directory, "launcher.ts");
	writeFileSync(launcher, `import { launchDetached } from ${JSON.stringify(join(ROOT, "experiment/cli.ts"))};
const run = launchDetached({ command: [process.execPath, ${JSON.stringify(fake)}], logPath: ${JSON.stringify(logPath)}, cwd: ${JSON.stringify(directory)} });
console.log("LAUNCHED " + run.pid);
`);
	// The launching shell: its own process group, killed as a terminal's death would kill it.
	const shell = spawn("bash", ["-c", `"${process.execPath}" "${launcher}"; sleep 60`], { cwd: directory, detached: true, stdio: ["ignore", "pipe", "inherit"] });
	const pid = await new Promise<number>((resolvePid, reject) => {
		let output = "";
		shell.stdout!.on("data", chunk => { output += chunk; const match = /LAUNCHED (\d+)/.exec(output); if (match) resolvePid(Number(match[1])); });
		shell.on("exit", () => reject(new Error(`launcher exited early: ${output}`)));
	});
	process.kill(-shell.pid!, "SIGHUP"); process.kill(-shell.pid!, "SIGKILL");
	await new Promise(r => shell.once("exit", r));
	expect(alive(shell.pid!)).toBe(false);
	expect(alive(pid)).toBe(true);
	// The detached run is a session leader of its own, outside the shell's group.
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
	expect(Number(stat[3])).toBe(pid); expect(Number(stat[2])).toBe(pid);
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline && !(existsSync(logPath) && readFileSync(logPath, "utf8").includes("ended:"))) await new Promise(r => setTimeout(r, 100));
	const log = readFileSync(logPath, "utf8");
	expect(log).toMatch(/^\[experiment\] .* detached: /);
	for (const pattern of [/run fake-run started for fixture/, /stage started: solve solve-00 — "Build the baseline pipeline"/, /stage finished: solve solve-00 success, valid, 2s/, /hand-over: Handed over at budget end/, /run fake-run ended: success/])
		expect(log).toMatch(pattern);
	console.log(`[measure] detached run ${pid} outlived its killed shell ${shell.pid}; log lines:\n${log.trim()}`);
}, 30_000);
