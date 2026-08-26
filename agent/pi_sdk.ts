import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

import { initializeModel } from "./model_provider.ts";
import { observeAgentSession } from "./observability.ts";
import { loadPipelineConfig } from "./pipeline_config.ts";

const { config, cwd, agentDir, initialPrompt } = await loadPipelineConfig();
const { modelId, modelRuntime, model } = await initializeModel({ config });
const { session } = await createAgentSession({
	cwd,
	agentDir,
	modelRuntime,
	model,
	sessionManager: SessionManager.inMemory(cwd),
});
const observability = await observeAgentSession({ session, model: modelId });

let shuttingDown = false;
async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	if (session.isStreaming) await session.abort();
	await observability.close();
	session.dispose();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

try {
	await session.prompt(initialPrompt);
} catch (error) {
	observability.recordError(error);
} finally {
	await shutdown();
}
