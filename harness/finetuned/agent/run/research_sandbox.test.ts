import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPythonEnvironment } from "./python_environment.js";
import { prepareResearchSandbox } from "./solve_sandbox.js";
import { REPO_ROOT } from "../paths.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const base = realpathSync(mkdtempSync(join(tmpdir(), "research-jail-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const python = readPythonEnvironment(false);

function jail(script: string) {
	const workspace = join(base, "runs/spam1/research");
	const task = join(base, "units/01-spam/task");
	mkdirSync(workspace, { recursive: true });
	mkdirSync(task, { recursive: true });
	writeFileSync(join(task, "prompt.md"), "the task\n");
	mkdirSync(join(base, "units/01-spam/other"), { recursive: true });
	writeFileSync(join(base, "units/01-spam/other/prompt.md"), "another task\n");
	mkdirSync(join(base, "runs/spam1/solve"), { recursive: true });
	writeFileSync(join(base, "runs/spam1/solve/earlier.py"), "solve work\n");
	const policy = prepareResearchSandbox(workspace, task, python);
	return { ...spawnSync(policy.executable, policy.args(["bash", "-c", script]), { encoding: "utf8", timeout: 20_000 }), workspace };
}

test("research cannot see the minimal arm, harness code, .env or other work", () => {
	const hidden = [join(REPO_ROOT, "harness/minimal/agent/instructions/solver.md"), join(ROOT, "agent/prompts/research/system.md"), join(REPO_ROOT, ".env"),
		join(base, "units/01-spam/other/prompt.md"), join(base, "runs/spam1/solve/earlier.py")];
	for (const path of hidden) {
		const result = jail(`test ! -e ${JSON.stringify(path)} && test ! -e /proc/1/root${JSON.stringify(path)}`);
		expect({ path, status: result.status }).toEqual({ path, status: 0 });
	}
	if (existsSync(join(REPO_ROOT, "harness/minimal"))) expect(existsSync(hidden[0]!)).toBe(true);
});

test("research reads its task, writes only its workspace, and has Python", () => {
	const task = join(base, "units/01-spam/task/prompt.md");
	const result = jail(`set -e; mkdir -p analysis; echo ok > analysis/a.txt; ! echo x > ${JSON.stringify(task)}; cat ${JSON.stringify(task)}; python -c "import numpy; print('numpy')"`);
	expect(result.stdout.trim().split("\n")).toEqual(["the task", "numpy"]);
	expect(result.status).toBe(0);
	expect(readFileSync(join(result.workspace, "analysis/a.txt"), "utf8")).toBe("ok\n");
	expect(readFileSync(task, "utf8")).toBe("the task\n");
});
