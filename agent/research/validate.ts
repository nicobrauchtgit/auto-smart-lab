import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

import { researchContextHash, type ResearchContext } from "./context.js";

export interface ResearchValidationResult {
	valid: boolean;
	errors: string[];
}

interface DatasetEvidenceRecord {
	scope: "full" | "sampled";
	population: number;
	method: string;
	values: unknown;
}

interface DatasetEvidenceArtifact {
	dataset_snapshot_sha256?: string;
	evidence?: Record<string, DatasetEvidenceRecord>;
}

const REQUIRED_HEADINGS = [
	"## Scope",
	"## Evidence-backed findings",
	"## Guidance for the solver",
	"## Risks and unknowns",
	"## Sources",
	"## Revision log",
];

function idsIn(text: string, prefix: "D" | "S"): Set<string> {
	return new Set(text.match(new RegExp(`\\b${prefix}\\d{3}\\b`, "g")) ?? []);
}

function section(document: string, start: string, end: string): string {
	const startIndex = document.indexOf(start);
	if (startIndex < 0) return "";
	const endIndex = document.indexOf(end, startIndex + start.length);
	return document.slice(startIndex, endIndex < 0 ? undefined : endIndex);
}

export function validateResearchDocument(
	document: string,
	context: ResearchContext,
): ResearchValidationResult {
	const errors: string[] = [];
	const byteLength = Buffer.byteLength(document, "utf8");
	if (byteLength > context.limits.max_report_bytes) {
		errors.push(`research.md is ${byteLength} bytes; limit is ${context.limits.max_report_bytes}`);
	}

	if (!/^# Research: .+$/m.test(document)) errors.push("missing '# Research: <task title>' heading");
	if (/^Pending(?: grounded analysis)?\.?$/mi.test(document)) errors.push("document still contains placeholder content");
	const expectedHash = researchContextHash(context);
	if (!document.includes(`Context snapshot: \`sha256:${expectedHash}\``)) {
		errors.push("Scope does not identify the current context snapshot hash");
	}

	for (const heading of REQUIRED_HEADINGS) {
		const matches = document.match(new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "gm"));
		if (!matches) errors.push(`missing '${heading}' heading`);
		else if (matches.length > 1) errors.push(`duplicate '${heading}' heading`);
	}
	const actualHeadings = document.match(/^## .+$/gm) ?? [];
	for (const heading of actualHeadings) {
		if (!REQUIRED_HEADINGS.includes(heading)) errors.push(`unexpected top-level section '${heading}'`);
	}
	const expectedOrder = REQUIRED_HEADINGS.map((heading) => document.indexOf(heading));
	if (expectedOrder.every((index) => index >= 0)) {
		for (let index = 1; index < expectedOrder.length; index++) {
			if (expectedOrder[index] <= expectedOrder[index - 1]) {
				errors.push("required sections are out of order");
				break;
			}
		}
	}

	if (/\[(?:E|M)\d{3}\]/.test(document)) {
		errors.push("legacy controller-generated [E###]/[M###] citations are not allowed");
	}
	const datasetIds = idsIn(document, "D");
	const sourceIds = idsIn(document, "S");
	if (datasetIds.size === 0) errors.push("document contains no dataset-analysis citations");
	if (sourceIds.size === 0) errors.push("document contains no web-source citations");

	for (const [blockNumber, block] of document.split(/\r?\n\s*\r?\n/).entries()) {
		if (/\b(?:Measured|Sampled)\b/i.test(block) && !/\[D\d{3}\]/.test(block)) {
			errors.push(`paragraph ${blockNumber + 1} labels a dataset claim without a [D###] citation`);
		}
	}

	const guidance = section(document, "## Guidance for the solver", "## Risks and unknowns");
	const recommendations: string[] = [];
	let currentRecommendation = "";
	for (const line of guidance.split(/\r?\n/)) {
		if (/^\s*(?:\d+\.|[-*])\s/.test(line)) {
			if (currentRecommendation) recommendations.push(currentRecommendation);
			currentRecommendation = line;
		} else if (currentRecommendation && /^\s+\S/.test(line)) {
			currentRecommendation += `\n${line}`;
		}
	}
	if (currentRecommendation) recommendations.push(currentRecommendation);
	if (recommendations.length > context.limits.max_feature_recommendations) {
		errors.push(`report has ${recommendations.length} feature recommendations; limit is ${context.limits.max_feature_recommendations}`);
	}
	for (const recommendation of recommendations) {
		if (!/\[(?:D|S)\d{3}\]/.test(recommendation)) {
			errors.push("a solver recommendation has no [D###] or [S###] citation");
		}
	}

	const sources = section(document, "## Sources", "## Revision log");
	for (const id of datasetIds) {
		const definition = new RegExp(`\\[${id}\\][^\\n]*script:\\s*\\\`([^\\\`]+)\\\`[^\\n]*artifact:\\s*\\\`([^\\\`]+)\\\``, "i").exec(sources);
		if (!definition) errors.push(`[${id}] is not defined with script and artifact paths in Sources`);
	}
	for (const id of sourceIds) {
		const definition = new RegExp(`\\[${id}\\][^\\n]*https?://\\S+`, "i");
		if (!definition.test(sources)) errors.push(`[${id}] is not defined with a URL in Sources`);
	}

	const revision = section(document, "## Revision log", "\u0000");
	const revisionDates = revision.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
	if (revisionDates.length === 0) errors.push("Revision log has no dated entry");
	if (revisionDates.at(-1) !== context.run_date) errors.push(`latest revision date must be ${context.run_date}`);
	if (revisionDates.some((date) => date > context.run_date)) errors.push("Revision log contains a future date");

	for (const pattern of [
		/SAIA_API_KEY\s*=/i,
		/TAVILY_API_KEY\s*=/i,
		/LAB_PASS\s*=/i,
		/SMARTLAB_SSH_PASSWORD\s*=/i,
	]) {
		if (pattern.test(document)) errors.push(`document contains forbidden credential-like text: ${pattern.source}`);
	}

	return { valid: errors.length === 0, errors };
}

export function validateResearchFile(
	path: string,
	context: ResearchContext,
): ResearchValidationResult {
	if (!existsSync(path)) return { valid: false, errors: ["research.md was not created"] };
	const document = readFileSync(path, "utf8");
	const result = validateResearchDocument(document, context);
	const sources = section(document, "## Sources", "## Revision log");
	const evidenceRecords = new Map<string, DatasetEvidenceRecord>();
	const parsedArtifacts = new Map<string, DatasetEvidenceArtifact>();
	const workspace = resolve(dirname(path));
	for (const id of idsIn(document, "D")) {
		const match = new RegExp(`\\[${id}\\][^\\n]*script:\\s*\\\`([^\\\`]+)\\\`[^\\n]*artifact:\\s*\\\`([^\\\`]+)\\\``, "i").exec(sources);
		if (!match) continue;
		const script = resolve(workspace, match[1]);
		const artifact = resolve(workspace, match[2]);
		if (script !== workspace && !script.startsWith(`${workspace}${sep}`)) {
			result.errors.push(`[${id}] script escapes the research workspace`);
		} else if (!existsSync(script)) {
			result.errors.push(`[${id}] script does not exist: ${match[1]}`);
		}
		if (artifact !== workspace && !artifact.startsWith(`${workspace}${sep}`)) {
			result.errors.push(`[${id}] artifact escapes the research workspace`);
		} else if (!existsSync(artifact)) {
			result.errors.push(`[${id}] artifact does not exist: ${match[2]}`);
		} else if (statSync(artifact).size > context.limits.max_analysis_artifact_bytes) {
			result.errors.push(`[${id}] artifact exceeds ${context.limits.max_analysis_artifact_bytes} bytes: ${match[2]}`);
		} else if (artifact.endsWith(".json")) {
			try {
				let parsed = parsedArtifacts.get(artifact);
				if (!parsed) {
					parsed = JSON.parse(readFileSync(artifact, "utf8")) as DatasetEvidenceArtifact;
					parsedArtifacts.set(artifact, parsed);
				}
				if (parsed.dataset_snapshot_sha256 !== context.dataset.snapshot_sha256) {
					result.errors.push(`[${id}] artifact does not identify the current dataset snapshot`);
				}
				const record = parsed.evidence?.[id];
				if (!record) {
					result.errors.push(`[${id}] has no matching record in artifact: ${match[2]}`);
				} else if (
					!(["full", "sampled"] as const).includes(record.scope)
					|| !Number.isInteger(record.population)
					|| record.population < 1
					|| typeof record.method !== "string"
					|| record.method.trim().length === 0
					|| !("values" in record)
				) {
					result.errors.push(`[${id}] artifact record must contain scope, population, method, and values`);
				} else {
					evidenceRecords.set(id, record);
				}
			} catch {
				result.errors.push(`[${id}] artifact is not valid JSON: ${match[2]}`);
			}
		}
	}
	for (const [blockNumber, block] of document.split(/\r?\n\s*\r?\n/).entries()) {
		const citedRecords = [...idsIn(block, "D")]
			.map((id) => evidenceRecords.get(id))
			.filter((record): record is DatasetEvidenceRecord => record !== undefined);
		if (/\bMeasured\b/i.test(block) && !citedRecords.some((record) => record.scope === "full")) {
			result.errors.push(`paragraph ${blockNumber + 1} labels a claim Measured without citing full-scope evidence`);
		}
		if (/\bSampled\b/i.test(block) && !citedRecords.some((record) => record.scope === "sampled")) {
			result.errors.push(`paragraph ${blockNumber + 1} labels a claim Sampled without citing sampled evidence`);
		}
	}
	const analysisDir = resolve(workspace, "analysis");
	if (existsSync(analysisDir)) {
		for (const entry of readdirSync(analysisDir, { withFileTypes: true })) {
			if (!entry.isFile() || !/\.(?:py|js|ts|sh)$/.test(entry.name)) continue;
			const script = readFileSync(resolve(analysisDir, entry.name), "utf8");
			if (/\/(?:Users|home)\/[^/]+\//.test(script)) {
				result.errors.push(`analysis script contains a machine-specific absolute path: analysis/${entry.name}`);
			}
		}
	}
	result.valid = result.errors.length === 0;
	return result;
}
