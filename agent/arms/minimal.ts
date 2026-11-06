/**
 * Run location and filesystem boundary of the minimal experiment arm.
 *
 * Every run gets a fresh directory holding a copy of the arm's agent code, the
 * course units and its own venv. The whole arm process runs inside bubblewrap
 * with only that directory writable, so the agent's tools, its Python and the
 * arm's orchestrator cannot reach the harness, its run state or `.env`.
 * Credentials the model client needs are passed by name; the arm removes them
 * from its shell tool's environment.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSolveSandbox, executable, sandboxPolicy, type SandboxMount, type SolveSandbox } from "../run/solve_sandbox.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The Python version shared with the harness. */
const PYTHON_VERSION_FILE = ".python-version";
const CPU_TORCH_INDEX = "https://download.pytorch.org/whl/cpu";
/** Everything of the arm a run needs. Its docs and logs of earlier runs stay out of the agent's reach. */
const ARM_PATHS = ["agent", ".pi"];
const PASSED_ENV = /^(MYTHLLM_API_KEY|SAIA_API_KEY|GWDG_API_KEY|LITELLM_TOKEN|TAVILY_API_KEY|GOOGLE_CLOUD_API_KEY|GOOGLE_CLOUD_PROJECT|GOOGLE_CLOUD_LOCATION|GOOGLE_APPLICATION_CREDENTIALS|LANGFUSE_.+|LAB_.+|SMARTLAB_ACTIVATION_TOKEN.*|PI_DEBUG_HTTP|NIX_LD|NIX_LD_LIBRARY_PATH|LD_LIBRARY_PATH)$/;

export interface MinimalRun { root: string; venv: string; home: string; units: string }

/** Provider definitions for the arm, from the same configuration the harness uses. */
export function armModelsJson(pipelineConfig: { providers?: Record<string, any> }): string {
	const providers: Record<string, unknown> = {};
	for (const [id, provider] of Object.entries(pipelineConfig.providers ?? {})) {
		if (provider.builtin) continue;
		providers[id] = { name: provider.name, baseUrl: provider.baseUrl, api: provider.api, apiKey: `$${provider.apiKeyEnv}`, models: provider.models };
	}
	return `${JSON.stringify({ providers }, null, 2)}\n`;
}

/** Fresh run directory with the arm's code and links to the course units. No venv yet. */
export function prepareMinimalRun(options: { projectRoot?: string; stamp: string }): MinimalRun {
	const projectRoot = options.projectRoot ?? PROJECT_ROOT;
	const armRoot = join(projectRoot, "arms", "minimal");
	const root = join(projectRoot, "runs", "minimal", options.stamp);
	if (existsSync(root)) throw new Error(`Run location already exists: ${root}`);
	mkdirSync(root, { recursive: true });
	for (const path of ARM_PATHS) {
		cpSync(join(armRoot, path), join(root, path), { recursive: true, filter: source => !source.endsWith("__pycache__") });
	}

	const home = join(root, ".home");
	const agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	const config = JSON.parse(readFileSync(join(projectRoot, "pipeline.config.json"), "utf8"));
	writeFileSync(join(agentDir, "models.json"), armModelsJson(config));

	// Only real units. Archives and notes in units/ are not task material.
	const units = join(root, "units");
	mkdirSync(units);
	const source = join(projectRoot, "units");
	if (existsSync(source)) for (const name of readdirSync(source)) {
		if (name.startsWith("_") || name === "README.md") continue;
		const path = join(source, name);
		if (statSync(path).isDirectory()) symlinkSync(path, join(units, name));
		else if (name === "index.json") cpSync(path, join(units, name));
	}
	const modules = join(projectRoot, "node_modules");
	if (existsSync(modules)) symlinkSync(modules, join(root, "node_modules"));
	return { root, venv: join(root, ".venv"), home, units };
}

/** Per-run venv with pip, from the arm's pinned package list. */
export function createMinimalVenv(run: MinimalRun, options: { projectRoot?: string; spawnImpl?: typeof spawnSync } = {}): void {
	const projectRoot = options.projectRoot ?? PROJECT_ROOT;
	const execute = options.spawnImpl ?? spawnSync;
	const python = readFileSync(join(projectRoot, PYTHON_VERSION_FILE), "utf8").trim();
	const env = { ...process.env, VIRTUAL_ENV: run.venv, UV_PROJECT_ENVIRONMENT: run.venv };
	for (const args of [
		["venv", "--seed", "--python", python, run.venv],
		["pip", "install", "--python", join(run.venv, "bin", "python"), "--extra-index-url", CPU_TORCH_INDEX, "--index-strategy", "unsafe-best-match",
			"-r", join(projectRoot, "arms", "minimal", "requirements.txt")],
	]) {
		const result = execute("uv", args, { env, stdio: "inherit" });
		if (result.status !== 0) throw new Error(`Could not create the minimal arm's venv: uv ${args[0]} failed`);
	}
}

export function minimalPolicy(run: MinimalRun, options: { env?: NodeJS.ProcessEnv; bwrap?: string; commit?: { commit: string; branch: string; dirty: string } } = {}): SolveSandbox {
	const source = options.env ?? process.env;
	const tools = ["bash", "git", "rg", "fd", "uv"].map(name => dirname(executable(name)));
	const mounts: SandboxMount[] = [
		{ source: run.root, writable: true },
		{ source: dirname(realpathSync(process.execPath)) },
		...tools.map(path => ({ source: path })),
	];
	const add = (path: string) => { if (existsSync(path)) mounts.push({ source: path }); };
	for (const name of readdirSync(run.units)) {
		const link = join(run.units, name);
		if (statSync(link).isDirectory()) add(realpathSync(link));
	}
	const modules = join(run.root, "node_modules");
	if (existsSync(modules)) { add(realpathSync(modules)); }
	const interpreter = join(run.venv, "bin", "python");
	if (existsSync(interpreter)) add(dirname(dirname(dirname(realpathSync(interpreter)))));
	if (source.GOOGLE_APPLICATION_CREDENTIALS) add(source.GOOGLE_APPLICATION_CREDENTIALS);

	const env: Record<string, string> = {
		HOME: run.home,
		PI_CODING_AGENT_DIR: join(run.home, ".pi", "agent"),
		VIRTUAL_ENV: run.venv,
		PYTHONNOUSERSITE: "1",
		PATH: [join(run.venv, "bin"), ...tools, "/run/current-system/sw/bin", "/usr/bin", "/bin"].join(":"),
		...(options.commit ? { SMARTLAB_ARM_COMMIT: options.commit.commit, SMARTLAB_ARM_BRANCH: options.commit.branch, SMARTLAB_ARM_DIRTY: options.commit.dirty } : {}),
	};
	for (const [name, value] of Object.entries(source)) {
		if (value !== undefined && PASSED_ENV.test(name)) env[name] = value;
	}
	return sandboxPolicy({ mounts, cwd: run.root, env, bwrap: options.bwrap });
}

export function repositoryState(projectRoot = PROJECT_ROOT): { commit: string; branch: string; dirty: string } {
	const git = (...args: string[]) => spawnSync("git", args, { cwd: projectRoot, encoding: "utf8" }).stdout?.trimEnd() ?? "";
	return { commit: git("rev-parse", "--short=10", "HEAD") || "unknown", branch: git("rev-parse", "--abbrev-ref", "HEAD") || "unknown",
		dirty: git("status", "--porcelain", "--untracked-files=no").split("\n").filter(line => line.length > 3).map(line => line.slice(3)).join("\n") };
}

/** Every missing prerequisite at once, with what to do about it. */
export function checkMinimalSetup(options: { projectRoot?: string; env?: NodeJS.ProcessEnv; bwrap?: string; model?: string } = {}): string[] {
	const projectRoot = options.projectRoot ?? PROJECT_ROOT;
	const env = options.env ?? process.env;
	const problems: string[] = [];
	try { checkSolveSandbox(options.bwrap); } catch (error) { problems.push(`Filesystem boundary: ${error instanceof Error ? error.message : String(error)}`); }
	try { executable("uv"); } catch { problems.push("uv is missing: run commands through ./dev and run ./dev setup"); }
	for (const path of ["arms/minimal/agent/run/solve_units.ts", "arms/minimal/requirements.txt", "node_modules/@earendil-works/pi-coding-agent", "node_modules/@langfuse/pi-observability-plugin"]) {
		if (!existsSync(join(projectRoot, path))) problems.push(`${path} is missing: run ./dev setup`);
	}
	if (!existsSync(join(projectRoot, "units", "index.json"))) problems.push("units/index.json is missing: prepare the course units first");
	const config = JSON.parse(readFileSync(join(projectRoot, "pipeline.config.json"), "utf8"));
	const model = options.model ?? config.defaultModel;
	const provider = config.providers?.[String(model).split("/")[0] ?? ""];
	if (provider?.apiKeyEnv && !env[provider.apiKeyEnv]) problems.push(`${provider.apiKeyEnv} is not set: add it to .env (needed by ${model})`);
	return problems;
}

/** Always name the model: without one, pi picks its own default, which may not be the configured one. */
export function withModel(args: readonly string[], defaultModel: string): string[] {
	return args.includes("--model") ? [...args] : ["--model", defaultModel, ...args];
}

/** Run the arm's batch driver inside the boundary. Resolves with its exit code. */
export function runMinimal(run: MinimalRun, args: readonly string[], options: { projectRoot?: string } = {}): Promise<number> {
	const policy = minimalPolicy(run, { commit: repositoryState() });
	const config = JSON.parse(readFileSync(join(options.projectRoot ?? PROJECT_ROOT, "pipeline.config.json"), "utf8"));
	const command = [realpathSync(process.execPath), "agent/run/solve_units.ts", ...withModel(args, config.defaultModel)];
	return new Promise((accept, reject) => {
		const child = spawn(policy.executable, policy.args(command), { stdio: "inherit" });
		child.on("error", reject);
		child.on("close", code => accept(code ?? 1));
	});
}
