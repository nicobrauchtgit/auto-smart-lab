import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armModelsJson, checkMinimalSetup, minimalPolicy, prepareMinimalRun, withModel } from "./minimal.js";
import { harnessStatePaths, parseExperimentArgs } from "./cli.js";
import { shellEnvironment } from "../harness/minimal/agent/run/session_runner.js";

const created: string[] = [];
afterAll(() => { for (const path of created) rmSync(path, { recursive: true, force: true }); });

function fixture() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "minimal-arm-")));
	created.push(root);
	const write = (path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };
	write("harness/minimal/agent/run/solve_units.ts", "// arm code\n");
	write("harness/minimal/agent/instructions/solver.md", "solver prompt\n");
	write("harness/minimal/.pi/settings.json", "{}\n");
	write("harness/minimal/docs/EXPERIMENT_LOG.md", "earlier results\n");
	write("harness/minimal/pipeline.config.json", JSON.stringify({ defaultModel: "mythllm/m", providers: {
		mythllm: { name: "M", baseUrl: "https://example.invalid/v1", api: "openai-completions", apiKeyEnv: "MYTHLLM_API_KEY", models: [{ id: "m" }] },
		"google-vertex": { builtin: true } } }));
	write("harness/finetuned/pipeline.config.json", JSON.stringify({ defaultModel: "harness/h", providers: {
		harness: { name: "H", baseUrl: "https://harness.invalid/v1", api: "openai-completions", apiKeyEnv: "HARNESS_ONLY_KEY", models: [{ id: "h" }] } } }));
	write("units/index.json", "{}\n");
	write("units/01-spam/task/prompt.md", "the task\n");
	write("units/_vm-archive/old/prompt.md", "archived\n");
	// Everything the agent must not reach.
	write(".env", "MYTHLLM_API_KEY=secret\n");
	write("harness/finetuned/agent/prompts/solve/system.md", "harness coaching\n");
	write("runs/finetuned/solutions/tasks/spam1.py", "harness solution\n");
	write("runs/finetuned/knowledge/note.md", "harness note\n");
	write("runs/finetuned/spam1/research/research.md", "harness research\n");
	return root;
}

function inJail(root: string, script: string, env: NodeJS.ProcessEnv = {}) {
	const run = prepareMinimalRun({ projectRoot: root, stamp: `s${Math.random().toString(36).slice(2)}` });
	const policy = minimalPolicy(run, { env });
	const result = spawnSync(policy.executable, policy.args(["bash", "-c", script]), { encoding: "utf8", timeout: 20_000 });
	return { ...result, run };
}

describe("minimal arm run location", () => {
	test("holds the arm's agent code and real units, not its docs or archives", () => {
		const root = fixture();
		const run = prepareMinimalRun({ projectRoot: root, stamp: "a" });
		expect(readFileSync(join(run.root, "agent/instructions/solver.md"), "utf8")).toBe("solver prompt\n");
		expect(existsSync(join(run.root, "docs"))).toBe(false);
		expect(readFileSync(join(run.units, "01-spam/task/prompt.md"), "utf8")).toBe("the task\n");
		expect(existsSync(join(run.units, "_vm-archive"))).toBe(false);
		expect(() => prepareMinimalRun({ projectRoot: root, stamp: "a" })).toThrow("already exists");
	});

	test("provider definitions name the key variable, never its value", () => {
		const text = armModelsJson({ providers: { mythllm: { name: "M", baseUrl: "u", api: "a", apiKeyEnv: "MYTHLLM_API_KEY", models: [] }, "google-vertex": { builtin: true } } });
		expect(JSON.parse(text).providers.mythllm.apiKey).toBe("$MYTHLLM_API_KEY");
		expect(JSON.parse(text).providers["google-vertex"]).toBeUndefined();
	});

	test("model configuration comes from the arm's own file, not the harness's", () => {
		const root = fixture();
		const run = prepareMinimalRun({ projectRoot: root, stamp: "a" });
		const providers = JSON.parse(readFileSync(join(run.home, ".pi/agent/models.json"), "utf8")).providers;
		expect(Object.keys(providers)).toEqual(["mythllm"]);
		expect(checkMinimalSetup({ projectRoot: root, bwrap: "/nonexistent", env: {} }).join("\n")).toContain("MYTHLLM_API_KEY is not set");
		rmSync(join(root, "harness/minimal/pipeline.config.json"));
		expect(checkMinimalSetup({ projectRoot: root, bwrap: "/nonexistent", env: {} }).join("\n")).toContain("pipeline.config.json is missing");
	});
});

describe("minimal arm boundary", () => {
	test("the harness, its state and .env do not exist inside the jail", () => {
		const root = fixture();
		for (const path of [".env", "harness/finetuned/agent/prompts/solve/system.md", "runs/finetuned/solutions/tasks/spam1.py", "runs/finetuned/knowledge/note.md", "runs/finetuned/spam1/research/research.md", "harness/minimal/docs/EXPERIMENT_LOG.md"]) {
			const result = inJail(root, `test ! -e ${JSON.stringify(join(root, path))} && test ! -e /proc/1/root${JSON.stringify(join(root, path))}`);
			expect({ path, status: result.status }).toEqual({ path, status: 0 });
		}
	});

	test("another run's location is not visible", () => {
		const root = fixture();
		const first = prepareMinimalRun({ projectRoot: root, stamp: "first" });
		writeFileSync(join(first.root, "agent/earlier.py"), "earlier solver\n");
		expect(inJail(root, `test ! -e ${JSON.stringify(join(first.root, "agent/earlier.py"))}`).status).toBe(0);
	});

	test("the agent writes in its run location, and units stay read-only", () => {
		const root = fixture();
		const result = inJail(root, `set -e; echo ok > agent/new.py; ! echo x > units/01-spam/task/prompt.md; cat units/01-spam/task/prompt.md`);
		expect(result.stdout.trim()).toBe("the task");
		expect(result.status).toBe(0);
		expect(readFileSync(join(result.run.root, "agent/new.py"), "utf8")).toBe("ok\n");
		expect(readFileSync(join(root, "units/01-spam/task/prompt.md"), "utf8")).toBe("the task\n");
	});

	test("only named variables enter the jail, and the shell tool drops credentials", () => {
		const root = fixture();
		const env = { MYTHLLM_API_KEY: "secret-key", UNRELATED_HOST_VARIABLE: "leak" };
		const result = inJail(root, `echo "[$MYTHLLM_API_KEY][$UNRELATED_HOST_VARIABLE]"`, env);
		expect(result.stdout.trim()).toBe("[secret-key][]");
		const shell = shellEnvironment({ PATH: "/bin", MYTHLLM_API_KEY: "a", LITELLM_TOKEN: "b", LANGFUSE_SECRET_KEY: "c", LAB_USER: "d", GOOGLE_APPLICATION_CREDENTIALS: "e", TAVILY_API_KEY: "f" });
		expect(shell).toEqual({ PATH: "/bin" });
	});
});

describe("experiment switch", () => {
	test("the arm always gets a named model", () => {
		expect(withModel(["--offline"], "mythllm/m")).toEqual(["--model", "mythllm/m", "--offline"]);
		expect(withModel(["--model", "other/x", "--offline"], "mythllm/m")).toEqual(["--model", "other/x", "--offline"]);
	});

	test("requires an arm and leaves other arguments for it", () => {
		expect(() => parseExperimentArgs(["spam1"])).toThrow("--arm");
		expect(() => parseExperimentArgs(["--arm", "other"])).toThrow("--arm");
		expect(parseExperimentArgs(["--arm", "minimal", "--offline", "--only", "spam1"])).toMatchObject({ arm: "minimal", rest: ["--offline", "--only", "spam1"], reset: false });
		expect(parseExperimentArgs(["--arm", "finetuned", "--check-setup"])).toMatchObject({ arm: "finetuned", checkSetup: true, rest: [] });
	});

	test("a finetuned reset keeps minimal runs and hand-over files", () => {
		const root = fixture();
		mkdirSync(join(root, "runs/minimal/x"), { recursive: true });
		mkdirSync(join(root, "runs/finetuned/deliveries/spam1"), { recursive: true });
		const paths = harnessStatePaths(root).map(path => path.slice(root.length + 1)).sort();
		expect(paths).toEqual(["runs/finetuned/knowledge", "runs/finetuned/solutions", "runs/finetuned/spam1"]);
	});

	test("setup reports every missing prerequisite before any agent starts", () => {
		const root = fixture();
		const problems = checkMinimalSetup({ projectRoot: root, env: {} });
		expect(problems.some(problem => problem.includes("requirements.txt"))).toBe(true);
		expect(problems.some(problem => problem.includes("MYTHLLM_API_KEY"))).toBe(true);
		expect(problems.join("\n")).not.toContain("secret");
	});
});
