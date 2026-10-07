/** Process-local immutable defaults. Restart the runner after editing harness.config.json. */
import { createHash } from "node:crypto";
import document from "../../harness.config.json";

const fields = {
	orchestrator: ["maxSessions", "maxModelRequests", "maxToolCalls", "maxStages", "maxTrials", "maxRetries", "maxWallMs", "maxSummaryBytes", "maxDetailBytes", "maxNotifications", "maxWaitMs"],
	setup: ["timeoutMs", "modelMaxTokens"],
	session: ["timeoutMs"], context: ["handoffTokens", "maxHandoffBytes"],
	research: ["injectStartupContext", "maxAttempts", "webSearchCalls", "webSearchResults", "maxReportBytes", "maxAnalysisArtifactBytes", "maxFeatureRecommendations"],
	solve: ["maxIterations", "sealedFraction", "seed", "foldPolicy", "experimentUpdateIntervalSeconds"],
	search: ["confirmAboveSeconds", "overrunFactor", "maxSeconds", "validationTimeoutSeconds"],
	supervisor: ["updateIntervalMs", "linesPerUpdate", "minStallMs", "stallGapMultiple", "importPreludeMs", "idleCpuPercent", "sampleIntervalMs", "maxConcurrent", "stopGraceMs"],
	subagents: ["turnTimeoutMs", "waitTimeoutMs", "maxWaitTimeoutMs", "limits"],
};
function object(value: unknown, keys: readonly string[], name: string): Record<string, any> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
	if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
		throw new Error(`${name} has missing or unexpected settings`);
	}
	return value as Record<string, any>;
}
function positive(value: unknown, name: string): void {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`${name} must be a positive integer`);
}
function freeze<T>(value: T): T {
	if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
	return value;
}
export type HarnessConfig = Omit<typeof document, "solve"> & {
	solve: Omit<typeof document.solve, "foldPolicy"> & { foldPolicy: "auto" | { folds: number; repeats: number } };
};
export function parseHarnessConfig(raw: unknown): HarnessConfig {
	const value = object(raw, ["version", ...Object.keys(fields), "foldRecommendations"], "harness");
	if (value.version !== 1) throw new Error("Unsupported harness version");
	for (const [section, keys] of Object.entries(fields)) {
		const block = object(value[section], keys, section);
		for (const key of keys) {
			if (["injectStartupContext", "sealedFraction", "seed", "foldPolicy", "limits", "overrunFactor"].includes(key)) continue;
			positive(block[key], `${section}.${key}`);
		}
	}
	if (typeof value.research.injectStartupContext !== "boolean") throw new Error("Invalid startup context setting");
	if (!(typeof value.solve.sealedFraction === "number" && value.solve.sealedFraction > 0 && value.solve.sealedFraction < 0.5)) throw new Error("Invalid sealed fraction");
	if (!Number.isSafeInteger(value.solve.seed)) throw new Error("Invalid root seed");
	if (!(typeof value.search.overrunFactor === "number" && value.search.overrunFactor > 1 && value.search.overrunFactor <= 10)) {
		throw new Error("search.overrunFactor must be a number above 1 and at most 10");
	}
	if (value.search.confirmAboveSeconds > value.search.maxSeconds) throw new Error("search.confirmAboveSeconds exceeds search.maxSeconds");
	if (value.solve.foldPolicy !== "auto") {
		const policy = object(value.solve.foldPolicy, ["folds", "repeats"], "solve.foldPolicy");
		positive(policy.folds, "folds"); positive(policy.repeats, "repeats");
		if (policy.folds < 2) throw new Error("folds must be >= 2");
	}
	const limits = object(value.subagents.limits, ["maxConcurrent", "maxChildren", "maxQueuedMessages", "maxMessageBytes", "maxResultBytes"], "subagents.limits");
	for (const [key, count] of Object.entries(limits)) positive(count, key);
	if (value.orchestrator.maxWaitMs > 60000 || value.orchestrator.maxWallMs > 2_147_483_647) throw new Error("Invalid orchestrator timer bound");
	if (value.subagents.waitTimeoutMs > value.subagents.maxWaitTimeoutMs) throw new Error("Wait timeout exceeds maximum");
	for (const timeout of [value.setup.timeoutMs, value.session.timeoutMs, value.subagents.turnTimeoutMs, value.subagents.maxWaitTimeoutMs]) {
		if (timeout > 2_147_483_647) throw new Error("Timeout exceeds timer range");
	}
	if (!Array.isArray(value.foldRecommendations) || !value.foldRecommendations.length) throw new Error("Missing fold recommendations");
	let last = 0;
	value.foldRecommendations.forEach((entry: unknown, index: number) => {
		const row = object(entry, ["belowRows", "folds", "repeats"], "fold recommendation");
		positive(row.folds, "folds"); positive(row.repeats, "repeats");
		if (row.folds < 2) throw new Error("folds must be >= 2");
		if (index === value.foldRecommendations.length - 1) {
			if (row.belowRows !== null) throw new Error("Last fold recommendation must cover all remaining rows");
		} else {
			positive(row.belowRows, "belowRows");
			if (row.belowRows <= last) throw new Error("Fold thresholds must increase");
			last = row.belowRows;
		}
	});
	return freeze(structuredClone(value)) as HarnessConfig;
}
export const HARNESS_CONFIG = parseHarnessConfig(document);
export const HARNESS_CONFIG_SHA256 = createHash("sha256").update(JSON.stringify(HARNESS_CONFIG)).digest("hex");
