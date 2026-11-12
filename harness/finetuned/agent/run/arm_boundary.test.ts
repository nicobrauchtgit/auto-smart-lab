/** Boundary test: the finetuned agent sandbox cannot read the minimal arm, harness prompts, .env or other work. */
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPythonEnvironment } from "./python_environment.js";
import { prepareSolveSandbox } from "./solve_sandbox.js";
import type { SolveWorkspace } from "../solve/workspace.js";
import { ARM_ROOT, REPO_ROOT } from "../paths.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "arm-boundary-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const python = readPythonEnvironment(false);

function jail(script: string) {
	const root = join(base, "runs/spam1/solve"), solutionsRoot = join(base, "solutions");
	const taskPath = join(root, "task.md");
	mkdirSync(root, { recursive: true }); mkdirSync(solutionsRoot, { recursive: true });
	writeFileSync(taskPath, "the task\n");
	mkdirSync(join(base, "units/01-spam/other"), { recursive: true });
	writeFileSync(join(base, "units/01-spam/other/prompt.md"), "another task\n");
	mkdirSync(join(base, "runs/spam2/solve"), { recursive: true });
	writeFileSync(join(base, "runs/spam2/solve/earlier.py"), "other task work\n");
	const workspace = { root, solutionsRoot, taskPath, devZip: join(root, "missing-dev.zip"), testZip: join(root, "missing-test.zip"),
		sampleManifestPath: join(root, "missing-manifest.json") } as SolveWorkspace;
	const policy = prepareSolveSandbox(workspace, python);
	return { ...spawnSync(policy.executable, policy.args(["bash", "-c", script]), { encoding: "utf8", timeout: 20_000 }), solutionsRoot, taskPath };
}

test("the agent sandbox cannot see the minimal arm, harness prompts, .env or other work", () => {
	const hidden = [join(REPO_ROOT, "harness/minimal"), join(ARM_ROOT, "agent/prompts"), join(REPO_ROOT, ".env"),
		join(base, "units/01-spam/other/prompt.md"), join(base, "runs/spam2/solve/earlier.py")];
	for (const path of hidden) {
		const result = jail(`test ! -e ${JSON.stringify(path)} && test ! -e /proc/1/root${JSON.stringify(path)}`);
		expect({ path, status: result.status }).toEqual({ path, status: 0 });
	}
	if (existsSync(join(REPO_ROOT, "harness/minimal"))) expect(existsSync(hidden[0]!)).toBe(true);
});

test("the agent sandbox reads its task, writes only its workspace, and has Python", () => {
	const result = jail(`set -e; echo ok > solutions/a.txt; cat runs/spam1/solve/task.md; ! echo x > runs/spam1/solve/task.md; python -c "import numpy; print('numpy')"`);
	expect(result.stdout.trim().split("\n")).toEqual(["the task", "numpy"]);
	expect(result.status).toBe(0);
	expect(readFileSync(join(result.solutionsRoot, "a.txt"), "utf8")).toBe("ok\n");
	expect(readFileSync(result.taskPath, "utf8")).toBe("the task\n");
});
