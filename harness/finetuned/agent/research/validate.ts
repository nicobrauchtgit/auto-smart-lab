/**
 * Solution-brief validation.
 *
 * The brief names one recommended pipeline, a few alternates and atomic next
 * improvements. The limit that matters is the number of routes, not bytes.
 * Sources are checked mechanically rather than by instruction: every source must
 * resolve, numbers in dataset facts must appear in the cited data, and URLs
 * must have been returned by this workspace's web searches. The same checks are
 * available to the agent as a self-check tool before it stops.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";

import { researchContextHash, type ResearchContext } from "./context.js";
import { DATA_PROFILE_PATH } from "./profile.js";

export interface ResearchValidationResult {
	valid: boolean;
	errors: string[];
}

export const BRIEF_SECTIONS = [
	"## Dataset facts",
	"## Recommended pipeline",
	"## Alternates",
	"## Next improvements",
	"## Leakage and risks",
	"## Sources",
] as const;

/** Workspace-relative log of URLs returned by `web_search`, appended by the tool. */
export const WEB_SOURCES_LOG = ".harness/web_sources.jsonl";

const CREDENTIAL_PATTERNS = [/SAIA_API_KEY\s*=/i, /TAVILY_API_KEY\s*=/i, /MYTHLLM_API_KEY\s*=/i, /LAB_PASS\s*=/i, /SMARTLAB_SSH_PASSWORD\s*=/i];

export type Source =
	| { kind: "profile"; text: string; key: string }
	| { kind: "artifact"; text: string; path: string; key?: string }
	| { kind: "url"; text: string; url: string };

interface Section { heading: string; body: string }

function sections(document: string): Section[] {
	const result: Section[] = [];
	const headings = [...document.matchAll(/^## .+$/gm)];
	headings.forEach((match, index) => {
		const start = match.index! + match[0].length;
		const end = index + 1 < headings.length ? headings[index + 1].index! : document.length;
		result.push({ heading: match[0].trim(), body: document.slice(start, end) });
	});
	return result;
}

/** Top-level list items, each with its indented continuation lines. */
export function listItems(body: string): string[] {
	const items: string[] = [];
	for (const line of body.split(/\r?\n/)) {
		if (/^(?:[-*]|\d+[.)])\s+\S/.test(line)) items.push(line);
		else if (items.length && /^\s+\S/.test(line)) items[items.length - 1] += `\n${line}`;
	}
	return items;
}

function normalizeUrl(url: string): string {
	try {
		const parsed = new URL(url.replace(/[).,;]+$/, ""));
		parsed.hash = "";
		return parsed.toString().replace(/\/$/, "");
	} catch { return url; }
}

/**
 * Sources are written in square brackets, several separated by `;` or `,`:
 * `[profile:training.sizes]`, `[analysis/tokens.json#top_terms]`,
 * `[analysis/tokens.json]` or `[https://…]`. Markdown links count as URLs.
 * Brackets that contain none of these forms are ordinary text.
 */
export function extractSources(text: string): Source[] {
	const found: Source[] = [];
	for (const match of text.matchAll(/\[([^\]\n]+)\](?:\((https?:\/\/[^)\s]+)\))?/g)) {
		if (match[2]) { found.push({ kind: "url", text: match[2], url: normalizeUrl(match[2]) }); continue; }
		for (const raw of match[1].split(/\s*[;,]\s*/)) {
			const part = raw.trim().replace(/^`|`$/g, "");
			if (/^https?:\/\//i.test(part)) found.push({ kind: "url", text: part, url: normalizeUrl(part) });
			else if (/^profile:\S+$/.test(part)) found.push({ kind: "profile", text: part, key: part.slice("profile:".length) });
			else if (/^[\w.-]+(?:\/[\w.-]+)*\.\w+(?:#\S+)?$/.test(part) && part.includes("/")) {
				const [path, key] = part.split("#", 2);
				found.push({ kind: "artifact", text: part, path, ...(key ? { key } : {}) });
			}
		}
	}
	return found;
}

/** Numbers stated in prose: code spans, brackets and link targets are not claims. */
export function statedNumbers(text: string): { value: number; decimals: number; percent: boolean; scale: number; text: string }[] {
	const prose = text.replace(/`[^`]*`/g, " ").replace(/\[[^\]]*\](?:\([^)]*\))?/g, " ");
	const numbers = [];
	for (const match of prose.matchAll(/(?<![\w.\-/])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:\s?(%|percent\b|KiB|KB|kB|MiB|MB|k\b))?(?![\w.]*\w)/g)) {
		const value = Number(`${match[1].replace(/,/g, "")}${match[2] ? `.${match[2]}` : ""}`);
		const unit = match[3];
		// Small integers are labels, ordinals and fold counts far more often than measurements.
		if (!match[2] && !unit && value <= 10) continue;
		const scale = unit === "KiB" ? 1024 : unit === "KB" || unit === "kB" || unit === "k" ? 1000 : unit === "MiB" ? 1024 ** 2 : unit === "MB" ? 1e6 : 1;
		numbers.push({ value, decimals: match[2]?.length ?? 0, percent: unit === "%" || unit === "percent", scale, text: match[0] });
	}
	return numbers;
}

function numbersIn(value: unknown, into: number[] = []): number[] {
	if (typeof value === "number" && Number.isFinite(value)) into.push(value);
	else if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value.trim())) into.push(Number(value));
	else if (Array.isArray(value)) value.forEach(item => numbersIn(item, into));
	else if (value && typeof value === "object") Object.values(value).forEach(item => numbersIn(item, into));
	return into;
}

function supports(stated: ReturnType<typeof statedNumbers>[number], values: number[]): boolean {
	const tolerance = 0.5 * 10 ** -stated.decimals + 1e-9;
	return values.some(value => {
		const candidates = stated.scale !== 1 ? [value / stated.scale] : stated.percent ? [value * 100, value] : [value, value * 100];
		return candidates.some(candidate => Math.abs(candidate - stated.value) <= tolerance);
	});
}

function readJson(path: string): unknown {
	try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function lookup(document: unknown, key: string): unknown {
	const evidence = (document as { evidence?: Record<string, unknown> } | undefined)?.evidence;
	if (evidence && key in evidence) return evidence[key];
	let current: unknown = document;
	for (const part of key.split(".")) {
		if (!current || typeof current !== "object" || !(part in current)) return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

function webSources(workspace: string): Set<string> {
	const path = join(workspace, WEB_SOURCES_LOG);
	const urls = new Set<string>();
	if (!existsSync(path)) return urls;
	for (const line of readFileSync(path, "utf8").split("\n")) {
		try { for (const url of (JSON.parse(line) as { urls?: string[] }).urls ?? []) urls.add(normalizeUrl(url)); } catch { /* partial line */ }
	}
	return urls;
}

export interface ResolvedSource { source: Source; error?: string; values?: number[] }

/** Resolve one source against the workspace; `values` are the numbers it can support. */
export function resolveSource(source: Source, workspace: string, context: ResearchContext, urls = webSources(workspace)): ResolvedSource {
	if (source.kind === "url") {
		return urls.has(source.url) ? { source } : { source, error: `[${source.text}] was not returned by web_search in this workspace; cite a URL from your search results` };
	}
	const relativePath = source.kind === "profile" ? DATA_PROFILE_PATH : source.path;
	const path = resolve(workspace, relativePath);
	if (path !== workspace && !path.startsWith(`${workspace}${sep}`)) return { source, error: `[${source.text}] points outside the research workspace` };
	if (!existsSync(path) || !statSync(path).isFile()) {
		return { source, error: source.kind === "profile" ? `[${source.text}]: the data profile is unavailable in this run` : `[${source.text}]: file does not exist` };
	}
	if (statSync(path).size > context.limits.max_analysis_artifact_bytes) {
		return { source, error: `[${source.text}]: artifact exceeds ${context.limits.max_analysis_artifact_bytes} bytes; store compact aggregates` };
	}
	if (source.kind === "artifact" && source.path.startsWith("resources/")) {
		const resource = context.resources?.find(item => item.path === source.path);
		if (!resource || resource.media_type !== "text/plain" || source.key
			|| createHash("sha256").update(readFileSync(path)).digest("hex") !== resource.sha256) {
			return { source, error: `[${source.text}]: cite an unchanged text resource declared in context.json, without a key` };
		}
		return { source, values: [] };
	}
	if (!path.endsWith(".json")) return source.kind === "artifact" && source.key ? { source, error: `[${source.text}]: keys can only be cited in JSON artifacts` } : { source, values: [] };
	const document = readJson(path);
	if (document === undefined) return { source, error: `[${source.text}]: not valid JSON` };
	if (source.kind === "profile" && (document as { dataset_snapshot_sha256?: string }).dataset_snapshot_sha256 !== context.dataset.snapshot_sha256) {
		return { source, error: `[${source.text}]: the data profile belongs to another dataset snapshot` };
	}
	const key = source.kind === "profile" ? source.key : source.key;
	if (key === undefined) return { source, values: numbersIn(document) };
	const value = lookup(document, key);
	if (value === undefined) return { source, error: `[${source.text}]: no key '${key}' in ${relativePath}` };
	return { source, values: numbersIn(value) };
}

export function validateBrief(document: string, workspace: string, context: ResearchContext): ResearchValidationResult {
	const errors: string[] = [];
	const limits = context.limits;
	const bytes = Buffer.byteLength(document, "utf8");
	if (bytes > limits.max_report_bytes) errors.push(`research.md is ${bytes} bytes; the safety limit is ${limits.max_report_bytes}. Condense it`);
	if (!/^# Brief: .+$/m.test(document)) errors.push("missing '# Brief: <task title>' heading");
	if (/^\s*(?:[-*]\s+)?Pending\.?\s*$/mi.test(document)) errors.push("document still contains placeholder content");
	if (!document.includes(`Context snapshot: \`sha256:${researchContextHash(context)}\``)) {
		errors.push("the brief does not state the current context snapshot hash (Context snapshot: `sha256:<hash>`)");
	}
	const found = sections(document);
	const headings = found.map(section => section.heading);
	for (const heading of BRIEF_SECTIONS) {
		const count = headings.filter(value => value === heading).length;
		if (count === 0) errors.push(`missing '${heading}' section`);
		if (count > 1) errors.push(`duplicate '${heading}' section`);
	}
	for (const heading of headings) if (!(BRIEF_SECTIONS as readonly string[]).includes(heading)) errors.push(`unexpected section '${heading}'`);
	const order = BRIEF_SECTIONS.map(heading => headings.indexOf(heading)).filter(index => index >= 0);
	if (order.some((index, position) => position > 0 && index < order[position - 1])) errors.push("sections are out of order");
	const body = (heading: string) => found.find(section => section.heading === heading)?.body ?? "";

	const counted = (heading: string, max: number, min: number, noun: string) => {
		const items = listItems(body(heading));
		if (items.length > max) errors.push(`${heading.slice(3)} has ${items.length} ${noun}; at most ${max}. Keep only the strongest`);
		if (items.length < min) errors.push(`${heading.slice(3)} needs at least ${min} ${noun} as a list`);
		return items;
	};
	const facts = counted("## Dataset facts", limits.max_facts, 1, "facts");
	counted("## Alternates", limits.max_alternates, 0, "alternates");
	counted("## Next improvements", limits.max_improvements, 1, "improvements");
	if (!body("## Recommended pipeline").trim()) errors.push("Recommended pipeline is empty");

	const urls = webSources(workspace);
	const cache = new Map<string, ResolvedSource>();
	const resolveOnce = (source: Source) => {
		if (!cache.has(source.text)) cache.set(source.text, resolveSource(source, workspace, context, urls));
		return cache.get(source.text)!;
	};
	for (const source of extractSources(document)) {
		const resolved = resolveOnce(source);
		if (resolved.error && !errors.includes(resolved.error)) errors.push(resolved.error);
	}
	const dataSources = (text: string) => extractSources(text).filter(source => source.kind === "profile"
		|| (source.kind === "artifact" && !source.path.startsWith("resources/")));
	if (!dataSources(body("## Recommended pipeline")).length) {
		errors.push("Recommended pipeline cites no dataset source; tie it to the profile or your analysis artifacts");
	}

	// Facts carry the dataset claims; their numbers must appear in the cited data.
	const checkNumbers = (label: string, item: string, requireSource: boolean) => {
		const cited = dataSources(item).map(resolveOnce).filter(resolved => !resolved.error);
		const summary = item.split("\n")[0].replace(/^(?:[-*]|\d+[.)])\s+/, "").slice(0, 80);
		if (requireSource && !dataSources(item).length) { errors.push(`${label} "${summary}" cites no dataset source`); return; }
		const values = cited.flatMap(resolved => resolved.values ?? []);
		for (const number of statedNumbers(item)) {
			if (!supports(number, values)) errors.push(`${label} "${summary}": ${number.text.trim()} is not in the cited data`);
		}
	};
	facts.forEach(item => checkNumbers("Fact", item, true));
	listItems(body("## Leakage and risks")).forEach(item => checkNumbers("Risk", item, false));

	for (const pattern of CREDENTIAL_PATTERNS) if (pattern.test(document)) errors.push(`document contains credential-like text: ${pattern.source}`);
	return { valid: errors.length === 0, errors };
}

export function validateResearchFile(path: string, context: ResearchContext): ResearchValidationResult {
	if (!existsSync(path)) return { valid: false, errors: ["research.md was not created"] };
	const workspace = resolve(dirname(path));
	const result = validateBrief(readFileSync(path, "utf8"), workspace, context);
	const analysisDir = join(workspace, "analysis");
	if (existsSync(analysisDir)) {
		for (const entry of readdirSync(analysisDir, { withFileTypes: true })) {
			if (!entry.isFile() || !/\.(?:py|js|ts|sh)$/.test(entry.name)) continue;
			if (/\/(?:Users|home)\/[^/]+\//.test(readFileSync(join(analysisDir, entry.name), "utf8"))) {
				result.errors.push(`analysis script contains a machine-specific absolute path: analysis/${entry.name}`);
			}
		}
	}
	result.valid = result.errors.length === 0;
	return result;
}
