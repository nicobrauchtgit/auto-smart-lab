import { createAgentSession, createBashToolDefinition, defineTool, SessionManager } from "@earendil-works/pi-coding-agent";

import { SmartContextSession } from "./context/session.js";
import { initializeModel } from "./model_provider.ts";
import { observeAgentSession } from "./observability.ts";
import { loadPipelineConfig } from "./pipeline_config.ts";
import { loadPromptSnapshot } from "./prompts/loader.js";
import { createPipelineResourceLoader } from "./run/session_resources.js";
import { Telemetry } from "./telemetry/runtime.js";
import { agentEnvironment } from "./telemetry/metadata.js";

const { config, cwd, agentDir, initialPrompt } = await loadPipelineConfig();
const telemetry = new Telemetry({ pipelineRunId: crypto.randomUUID(), stage: "pi-experiment" }, "runs");
try { telemetry.checkLocal(); await telemetry.checkAccess(new AbortController().signal); }
catch { await telemetry.close(); throw new Error("Langfuse setup failed before agent construction"); }
try {
const { modelId, modelRuntime, model } = await initializeModel({ config });
const prompts = loadPromptSnapshot();
const logical = new SmartContextSession({
	prompts,
	create: async () => {
		const resourceLoader = createPipelineResourceLoader({ cwd, agentDir });
		await resourceLoader.reload();
		const { session } = await createAgentSession({ cwd, agentDir, modelRuntime, model,
   customTools: [defineTool(createBashToolDefinition(cwd, { spawnHook: context => ({ ...context, env: agentEnvironment(context.env) }) }))],
			resourceLoader, sessionManager: SessionManager.inMemory(cwd) });
		try {
			const observer = await observeAgentSession({ session, model: modelId, telemetry });
			return { session, agentRunId: observer.agentRunId, record: observer.record,
				async close() { try { await observer.close(); } finally { session.dispose(); } } };
		} catch (error) { session.dispose(); throw error; }
	},
});
const stop = () => { void logical.abort().catch(error => logical.recordError(error)); };
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
	await logical.prompt(prompts.render("context.task", { task: initialPrompt }));
} catch (error) {
	logical.recordError(error);
} finally {
	process.removeListener("SIGINT", stop);
	process.removeListener("SIGTERM", stop);
	await logical.close();
}
} finally { await telemetry.close(); }
