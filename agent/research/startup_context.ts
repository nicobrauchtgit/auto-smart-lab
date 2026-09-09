import { createHash } from "node:crypto";
import { loadPromptSnapshot, type PromptSnapshot, type RenderedPrompt } from "../prompts/loader.js";

export interface StartupProfile {
	schema_version: 1;
	status: "available" | "unavailable";
	reason?: string;
	source?: { path: string; sha256: string };
	training_labels?: {
		rows: number;
		classes: Array<{ label: 0 | 1; count: number; fraction: number }>;
		majority_class_accuracy: number;
		constant_prediction_balanced_accuracy: number | null;
	};
	metric: "balanced_accuracy" | null;
}

// Explicit adapters for the fetched SmartLab tasks. Do not guess a label
// column or aggregate arbitrary CSVs for an unfamiliar task.
export const TRAINING_LABEL_FILES: Readonly<Record<string, string>> = {
	spam1: "spam1-train.labels",
	spam2: "spam2-train.labels",
	spam3: "webspam-train.labels",
};

export interface TrainingLabelRow {
	id: string;
	label: 0 | 1;
}

export type TrainingLabels =
	| { ok: true; rows: TrainingLabelRow[] }
	| { ok: false; error: string };

/**
 * Parse a `path;binary-label` file into rows.
 *
 * The rules are strict on purpose and shared by every consumer: one malformed or
 * repeated record invalidates the whole file rather than yielding a partial set,
 * because a silently short label list would misstate class balance and silently
 * shrink a training split.
 */
export function parseTrainingLabels(content: Buffer): TrainingLabels {
	const rows: TrainingLabelRow[] = [];
	const seen = new Set<string>();
	const lines = content.toString("utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
	for (const [index, raw] of lines.entries()) {
		const line = raw.trim();
		if (!line) continue;
		const separator = line.lastIndexOf(";");
		const id = line.slice(0, separator).trim();
		const label = line.slice(separator + 1).trim();
		if (separator < 1 || !id || !/^[01]$/.test(label) || line.includes("\uFFFD")) {
			return { ok: false, error: `Invalid path;binary-label record at line ${index + 1}; no partial counts reported.` };
		}
		if (seen.has(id)) {
			return { ok: false, error: `Repeated training path at line ${index + 1}; no partial counts reported.` };
		}
		seen.add(id);
		rows.push({ id, label: Number(label) as 0 | 1 });
	}
	if (rows.length === 0) return { ok: false, error: "The training labels file has no records." };
	return { ok: true, rows };
}

export function summarizeTrainingLabels(
	content: Buffer,
	sourcePath: string,
	metric: StartupProfile["metric"],
): StartupProfile {
	const source = {
		path: sourcePath,
		sha256: createHash("sha256").update(content).digest("hex"),
	};
	const unavailable = (reason: string): StartupProfile => ({
		schema_version: 1, status: "unavailable", source, metric, reason,
	});
	const parsed = parseTrainingLabels(content);
	if (!parsed.ok) return unavailable(parsed.error);
	const counts = [0, 0];
	for (const row of parsed.rows) counts[row.label]++;
	const rows = parsed.rows.length;
	return {
		schema_version: 1,
		status: "available",
		source,
		metric,
		training_labels: {
			rows,
			classes: ([0, 1] as const).map((label) => ({ label, count: counts[label], fraction: counts[label] / rows })),
			majority_class_accuracy: Math.max(counts[0], counts[1]) / rows,
			constant_prediction_balanced_accuracy: counts.every((count) => count > 0) ? 0.5 : null,
		},
	};
}

export function renderStartupContextPrompt(profile: StartupProfile | undefined, prompts: PromptSnapshot): RenderedPrompt | undefined {
	if (!profile) return undefined;
	const lines: string[] = [];
	if (profile.source) lines.push(`Source: ${profile.source.path}; sha256:${profile.source.sha256}.`);
	if (profile.metric === "balanced_accuracy") {
		lines.push("Task metric: balanced accuracy, as stated in task.md; each class recall has equal weight.");
	} else {
		lines.push("Task metric: not identified by this profile.");
	}
	if (profile.status !== "available" || !profile.training_labels) {
		lines.push(`Class counts unavailable: ${profile.reason ?? "No supported labels source."}`);
	} else {
		const labels = profile.training_labels;
		lines.push(`Training label records: ${labels.rows}.`);
		for (const item of labels.classes) {
			lines.push(`Class ${item.label}: ${item.count} (${(item.fraction * 100).toFixed(2)}%).`);
		}
		lines.push(`Always predicting a majority class gives ${(labels.majority_class_accuracy * 100).toFixed(2)}% ordinary accuracy on these labels.`);
		if (profile.metric === "balanced_accuracy" && labels.constant_prediction_balanced_accuracy !== null) {
			lines.push("Always predicting either class gives 0.5 balanced accuracy on these labels.");
		}
		if (labels.constant_prediction_balanced_accuracy === null) {
			lines.push("Only one class is present; a two-class balanced-accuracy baseline is unavailable.");
		}
	}
	return prompts.render("research.startup-context", { facts: lines.join("\n") });
}

export function renderStartupContext(profile: StartupProfile | undefined, prompts = loadPromptSnapshot()): string {
	return renderStartupContextPrompt(profile, prompts)?.text ?? "";
}

export function buildResearchLaunchPrompt(
	request: string,
	taskId: string,
	contextHash: string,
	profile?: StartupProfile,
	prompts = loadPromptSnapshot(),
): string {
	return prompts.render("research.launch", {
		request, taskId, contextHash, startupContext: renderStartupContext(profile, prompts),
	}).text;
}
