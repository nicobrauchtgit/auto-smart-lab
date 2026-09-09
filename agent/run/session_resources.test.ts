import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createPipelineResourceLoader } from "./session_resources.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { preparePythonEnvironment } from "./python_environment.js";

async function assertGuidanceExcluded(instructions: string) {
	const root = mkdtempSync(join(tmpdir(), "pipeline-context-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const marker = "DEVELOPMENT_GUIDANCE_MUST_NOT_ENTER_RUNTIME";
	for (const path of [join(root, "AGENTS.md"), join(cwd, "AGENTS.md"), join(cwd, "CLAUDE.md"), join(agentDir, "AGENTS.md")]) {
		writeFileSync(path, marker);
	}
	let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
	try {
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = createPipelineResourceLoader({
			cwd, agentDir, settingsManager, systemPrompt: instructions,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
			// A caller cannot accidentally re-enable developer context.
			noContextFiles: false,
			agentsFilesOverride: () => ({ agentsFiles: [{ path: "injected", content: marker }] }),
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getAgentsFiles(), { agentsFiles: [] });
		({ session } = await createAgentSession({
			cwd, agentDir, settingsManager, resourceLoader, tools: [],
			sessionManager: SessionManager.inMemory(cwd),
		}));
		assert.ok(session.systemPrompt.includes(instructions));
		assert.ok(!session.systemPrompt.includes(marker));
	} finally {
		session?.dispose();
		rmSync(root, { recursive: true, force: true });
	}
}

test("assembled research system prompt excludes local and ancestor development guidance", async () => {
	await assertGuidanceExcluded(loadPromptSnapshot().render("research.system", {}).text);
});

test("assembled solve system prompt excludes local and ancestor development guidance", async () => {
	await assertGuidanceExcluded(loadPromptSnapshot().render("solve.system", { taskId: "spam1" }).text);
});

test("shared Python guidance joins module instructions without loading development context", async () => {
	const prompts = loadPromptSnapshot();
	const python = preparePythonEnvironment(prompts, {
		schema_version: 1, python_version: "3.13.5", healthy: true,
		lock_current: true, environment_matches_lock: true, dependency_errors: "",
		project_sha256: "b".repeat(64), lock_sha256: "c".repeat(64),
		executable: "/project/.venv/bin/python", prefix: "/project/.venv", packages: [],
		declared_dependencies: ["demo>=1,<3"], fingerprint: "a".repeat(64),
	});
	for (const system of [prompts.render("research.system", {}).text,
		prompts.render("solve.system", { taskId: "spam1" }).text]) {
		await assertGuidanceExcluded(`${system}\n\n${python.prompt.text}`);
	}
});
