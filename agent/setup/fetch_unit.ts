import {
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { LabClient } from "./lab_client.ts";
import { dataFileName, type TaskDataFile } from "./task_data.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const CACHE_DIR = join(HERE, "downloaded_task_page");

/**
 * Fetch a unit's metadata: intro, task prompts and each task's download links.
 * No data is downloaded here; a run downloads its own task's files on demand
 * (agent/setup/task_data.ts), so storage holds only the tasks actually run.
 */
export interface FetchUnitOptions {
	insecure?: boolean;
	/** Retained for callers; explicit fetches always refresh live metadata. */
	refreshMetadata?: boolean;
}

/** Injectable storage/transport for offline regression fixtures. */
export interface FetchUnitDependencies {
	projectRoot?: string;
	cacheDir?: string;
	client?: Pick<LabClient, "baseUrl" | "get">;
}

export interface FetchUnitResult {
	unitSlug: string;
	taskPaths: string[];
}

interface Link {
	href: string;
	text: string;
}

interface TaskMetadata {
	unit: string;
	unit_slug: string;
	task: string;
	task_slug: string;
	url: string;
	task_number?: number;
	short_id?: string;
	/** Download links of the task's data; sizes and hashes are added when a run downloads them. */
	data_files?: TaskDataFile[];
}

interface UnitDataHash {
	unitId: string;
	unitSlug: string;
	unitTitle: string;
	unitUrl: string;
	taskPaths: string[];
	dataFiles: string[];
	dataHash: string;
}

async function sha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function hashUnitData(unitDir: string, dataFiles: string[]): Promise<string | undefined> {
	const hash = createHash("sha256");
	const root = resolve(unitDir);
	for (const dataFile of [...dataFiles].sort()) {
		const absolutePath = resolve(root, dataFile);
		if (!absolutePath.startsWith(`${root}${sep}`) || !existsSync(absolutePath)) return undefined;
		hash.update(dataFile);
		hash.update("\0");
		hash.update(await sha256(absolutePath));
		hash.update("\0");
	}
	return hash.digest("hex");
}

async function findCachedUnit(unit: string, unitsDir: string): Promise<{
	record: UnitDataHash;
	unitDir: string;
} | undefined> {
	if (!existsSync(unitsDir)) return undefined;
	const query = unit.toLowerCase().replace(/\/$/, "");
	for (const unitName of readdirSync(unitsDir)) {
		const unitDir = join(unitsDir, unitName);
		const hashPath = join(unitDir, ".data-hash.json");
		if (!existsSync(hashPath)) continue;
		let record: UnitDataHash;
		try {
			record = JSON.parse(readFileSync(hashPath, "utf8")) as UnitDataHash;
		} catch {
			continue;
		}
		const identifiers = [record.unitId, record.unitSlug, record.unitTitle, record.unitUrl]
			.map((value) => value.toLowerCase().replace(/\/$/, ""));
		if (!identifiers.includes(query) && !record.unitId.toLowerCase().startsWith(query)) continue;
		return { record, unitDir };
	}
	return undefined;
}

function decodeHtml(value: string): string {
	const named: Record<string, string> = {
		amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
	};
	return value.replace(/&(#x[\da-f]+|#\d+|[a-z][\w]+);/gi, (entity, code: string) => {
		if (code.toLowerCase().startsWith("#x")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
		if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
		return named[code.toLowerCase()] ?? entity;
	});
}

function attribute(tag: string, name: string): string | undefined {
	const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
	return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? "") : undefined;
}

function stripTags(fragment: string): string {
	return decodeHtml(fragment
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim());
}

function parseLinks(page: string): Link[] {
	return [...page.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)]
		.map((match) => ({ href: attribute(match[1], "href") ?? "", text: stripTags(match[2]) }))
		.filter((link) => link.href.length > 0);
}

function breadcrumb(page: string): string[] {
	return [...page.matchAll(/<li[^>]*breadcrumb-item[^>]*>([\s\S]*?)<\/li>/gi)]
		.map((match) => stripTags(match[1]));
}

interface ElementRange {
	openStart: number;
	openEnd: number;
	closeStart: number;
	closeEnd: number;
}

function balancedElementRange(page: string, tagName: string, openStart: number): ElementRange | undefined {
	const openingEnd = page.indexOf(">", openStart);
	if (openingEnd === -1) return undefined;
	const tags = new RegExp(`<${tagName}\\b[^>]*>|<\\/${tagName}\\s*>`, "gi");
	tags.lastIndex = openStart;
	let depth = 0;
	for (let match = tags.exec(page); match; match = tags.exec(page)) {
		if (match.index === openStart || !match[0].startsWith("</")) depth++;
		else depth--;
		if (depth === 0) {
			return {
				openStart,
				openEnd: openingEnd + 1,
				closeStart: match.index,
				closeEnd: match.index + match[0].length,
			};
		}
	}
	return undefined;
}

function descriptionColumn(page: string, columnClass: string): string | undefined {
	const heading = /<h1\b[^>]*class=(?:"[^"]*\bbd-title\b[^"]*"|'[^']*\bbd-title\b[^']*')[^>]*>[\s\S]*?<\/h1\s*>/i.exec(page);
	if (!heading || heading.index === undefined) return undefined;
	const candidates = [...page.slice(0, heading.index).matchAll(/<div\b[^>]*>/gi)]
		.filter((candidate) => {
			const classes = attribute(candidate[0], "class")?.split(/\s+/) ?? [];
			return classes.includes(columnClass);
		});
	const container = candidates.at(-1);
	if (!container || container.index === undefined) return undefined;
	const range = balancedElementRange(page, "div", container.index);
	if (!range || range.closeStart <= heading.index + heading[0].length) return undefined;
	return page.slice(heading.index + heading[0].length, range.closeStart).trim();
}

export function extractTaskDescription(page: string): string {
	const description = descriptionColumn(page, "col-md-8");
	if (!description) throw new Error("Could not locate the primary task description in the SmartLab page");
	return description;
}

export function extractUnitDescription(page: string): string {
	let fragment = descriptionColumn(page, "col-md-12");
	if (!fragment) throw new Error("Could not locate the primary unit description in the SmartLab page");
	const confidential = /<div\b[^>]*class=(?:"[^"]*\bcards-columns\b[^"]*"|'[^']*\bcards-columns\b[^']*')[^>]*>/i.exec(fragment);
	if (confidential?.index !== undefined) {
		const range = balancedElementRange(fragment, "div", confidential.index);
		if (range && /Confidential Unit Information|\bid=["']user_info["']|Please login with/i.test(
			fragment.slice(range.openStart, range.closeEnd),
		)) {
			fragment = fragment.slice(0, range.openStart) + fragment.slice(range.closeEnd);
		}
	}
	const tasksHeading = /<h2\b[^>]*>\s*Tasks\s*<\/h2\s*>/i.exec(fragment);
	if (tasksHeading?.index !== undefined) fragment = fragment.slice(0, tasksHeading.index);
	return fragment.trim();
}

export function htmlToMarkdown(fragment: string): string {
	let text = fragment;
	const codeBlock = (_match: string, content: string) =>
		`\n\`\`\`\n${decodeHtml(content.replace(/<[^>]+>/g, "")).trim()}\n\`\`\`\n`;
	text = text.replace(
		/<div\b[^>]*class=(?:"[^"]*\bcodehilite\b[^"]*"|'[^']*\bcodehilite\b[^']*')[^>]*>[\s\S]*?<pre[^>]*>([\s\S]*?)<\/pre>[\s\S]*?<\/div>/gi,
		codeBlock,
	);
	text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, codeBlock);
	for (let level = 6; level >= 1; level--) {
		text = text.replace(new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi"),
			(_match, content) => `\n${"#".repeat(level)} ${stripTags(content)}\n`);
	}
	text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, content) => `- ${stripTags(content)}\n`);
	text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_match, content) => `\`${stripTags(content)}\``);
	text = text.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi,
		(_match, content) => `**${stripTags(content)}**`);
	text = text.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi,
		(_match, content) => `*${stripTags(content)}*`);
	text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
		(_match, tag, content) => `[${stripTags(content)}](${attribute(tag, "href") ?? ""})`);
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_match, content) => `\n${stripTags(content)}\n`);
	return decodeHtml(text.replace(/<[^>]+>/g, " ").replace(/\n{3,}/g, "\n\n"))
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function slugify(value: string): string {
	return value.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/[\s_]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function readMetadata(path: string): TaskMetadata | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as TaskMetadata;
	} catch {
		return undefined;
	}
}

function unitKeyword(unitName: string): string {
	const stopwords = new Set(["introduction", "with", "the", "a", "an", "and", "or", "in", "of", "to"]);
	const parts = unitName.split("-").filter((part) => !stopwords.has(part));
	return parts.at(-1) ?? unitName;
}

function rebuildTaskIndex(unitsDir: string): void {
	mkdirSync(unitsDir, { recursive: true });
	const index: Record<string, string> = {};
	for (const unitName of readdirSync(unitsDir).sort()) {
		const unitDir = join(unitsDir, unitName);
		if (!statSync(unitDir).isDirectory()) continue;
		const keyword = unitKeyword(unitName);
		const tasks = readdirSync(unitDir)
			.map((name) => join(unitDir, name))
			.filter((path) => statSync(path).isDirectory() && existsSync(join(path, "meta.json")))
			.sort((left, right) => {
				const leftMeta = readMetadata(join(left, "meta.json"));
				const rightMeta = readMetadata(join(right, "meta.json"));
				const leftNumber = leftMeta?.task_number ?? Number(leftMeta?.task.match(/^(\d+)\./)?.[1] ?? 999);
				const rightNumber = rightMeta?.task_number ?? Number(rightMeta?.task.match(/^(\d+)\./)?.[1] ?? 999);
				return leftNumber - rightNumber || left.localeCompare(right);
			});
		tasks.forEach((taskDir, indexWithinUnit) => {
			const metadataPath = join(taskDir, "meta.json");
			const metadata = readMetadata(metadataPath);
			if (!metadata) return;
			const taskNumber = metadata.task_number ?? Number(metadata.task.match(/^(\d+)\./)?.[1] ?? indexWithinUnit + 1);
			metadata.task_number = taskNumber;
			metadata.short_id = `${keyword}${taskNumber}`;
			index[metadata.short_id] = metadata.url;
			writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
		});
	}
	writeFileSync(join(unitsDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
	console.log(`[fetch_unit] Index contains: ${Object.keys(index).join(", ")}`);
}

export async function fetchUnit(unit: string, options: FetchUnitOptions = {}, dependencies: FetchUnitDependencies = {}): Promise<FetchUnitResult> {
	const projectRoot = dependencies.projectRoot ?? PROJECT_ROOT;
	const unitsDir = join(projectRoot, "units");
	const cacheDir = dependencies.cacheDir ?? CACHE_DIR;
	const cached = await findCachedUnit(unit, unitsDir);
	// SmartLab uses a permanently self-signed certificate on its lab/download hosts.
	const client = dependencies.client ?? new LabClient({ insecure: options.insecure ?? true, timeoutMs: 10_000 });
	// Fetch every page live. Local data hashes cannot establish freshness of
	// week-two links. Stage writes until every required page has been validated.
	const writes = new Map<string, Buffer | string>();
	const liveGet = async (url: string, path: string): Promise<string> => {
		try {
			const response = await client.get(url);
			writes.set(path, response.body);
			return response.text;
		} catch {
			throw new Error("SmartLab metadata is unavailable; check lab service, VPN and LAB_USER/LAB_PASS. No local files were changed.");
		}
	};
	const unitsUrl = new URL("/units/", client.baseUrl).toString();
	const unitsPage = await liveGet(unitsUrl, join(cacheDir, "units.html"));
	const discovered = new Map<string, string>();
	for (const link of parseLinks(unitsPage)) {
		if (!/\/units\/[0-9a-f-]+\/tasks\/?$/i.test(link.href)) continue;
		const url = new URL(link.href, client.baseUrl).toString();
		if (!discovered.has(url)) discovered.set(url, link.text);
	}
	const directUrl = /^https?:\/\//i.test(unit) ? new URL(unit).toString() : undefined;
	const candidates = directUrl
		? [{ url: directUrl, listingTitle: "" }]
		: [...discovered].map(([url, listingTitle]) => ({ url, listingTitle }));
	if (candidates.length === 0) throw new Error("No SmartLab unit links found; check login and LAB_BASE_URL");

	type UnitCandidate = {
		url: string;
		id: string;
		page: string;
		title: string;
		slug: string;
		position: number;
		listingTitle: string;
	};
	const loaded: UnitCandidate[] = [];
	for (const [position, candidate] of candidates.entries()) {
		const { url, listingTitle } = candidate;
		const segments = new URL(url).pathname.split("/").filter(Boolean);
		const id = segments.at(-1) === "tasks" ? segments.at(-2) ?? "unit" : segments.at(-1) ?? "unit";
		const page = await liveGet(url, join(cacheDir, "units", `${id}.html`));
		const crumbs = breadcrumb(page);
		const title = crumbs[1] || listingTitle;
		const slug = (title ? slugify(title) : "") || id;
		loaded.push({ url, id, page, title, slug, position, listingTitle });
	}

	const query = unit.toLowerCase().replace(/\/$/, "");
	const querySlug = slugify(query);
	const numberedQuery = querySlug.match(/^0*(\d+)(?:-(.+))?$/);
	const unitNumber = numberedQuery ? Number(numberedQuery[1]) : undefined;
	const queryHint = numberedQuery?.[2] ?? querySlug;
	const exact = loaded.find((candidate) =>
		[candidate.id.toLowerCase(), candidate.title.toLowerCase(), candidate.slug.toLowerCase()].includes(query) ||
		candidate.id.toLowerCase().startsWith(query));
	const hintTerms = queryHint.split("-").filter(Boolean);
	const fuzzy = hintTerms.length === 0 ? [] : loaded.filter((candidate) => {
		const terms = new Set(slugify(`${candidate.title} ${candidate.listingTitle} ${candidate.slug}`).split("-"));
		return hintTerms.every((term) => terms.has(term));
	});
	const matched = directUrl
		? loaded[0]
		: exact ?? (fuzzy.length === 1 ? fuzzy[0] : undefined) ??
			(unitNumber ? fuzzy.find((candidate) => candidate.position === unitNumber - 1) : undefined) ??
			(unitNumber && hintTerms.length === 0 ? loaded[unitNumber - 1] : undefined);
	if (!matched) {
		const available = loaded
			.map((candidate) => `${String(candidate.position + 1).padStart(2, "0")}: ${candidate.title || candidate.slug}`)
			.join("; ");
		throw new Error(`Unit not found: ${unit}. Discovered units: ${available}`);
	}

	const numberedAlias = numberedQuery?.[2]
		? `${String(Number(numberedQuery[1])).padStart(2, "0")}-${numberedQuery[2]}`
		: undefined;
	const localNames = existsSync(unitsDir) ? readdirSync(unitsDir) : [];
	const existingName = localNames.find((name) =>
		[name.toLowerCase(), slugify(name)].includes(querySlug) || name.toLowerCase() === numberedAlias);
	const selected = { ...matched, slug: existingName ?? numberedAlias ?? matched.slug };

	const unitDir = join(unitsDir, selected.slug);
	console.log(`[unit] ${selected.title || selected.id} -> ${relative(projectRoot, unitDir)}/`);
	const intro = htmlToMarkdown(extractUnitDescription(selected.page));
	if (intro) writes.set(join(unitDir, "unit-intro.md"), `# ${selected.title}\n\n${intro}\n`);

	const taskUrls = unique(parseLinks(selected.page)
		.filter((link) => /\/units\/[0-9a-f-]+\/tasks\/[0-9a-f-]+\/?$/i.test(link.href))
		.map((link) => new URL(link.href, selected.url).toString()));
	if (taskUrls.length === 0) throw new Error(`No tasks found for unit ${selected.title || selected.id}`);
	const taskPaths: string[] = [];
	const dataPackages: string[] = [];
	for (const [taskIndex, taskUrl] of taskUrls.entries()) {
		const taskId = new URL(taskUrl).pathname.split("/").filter(Boolean).at(-1) ?? "task";
		const taskPage = await liveGet(taskUrl, join(cacheDir, "tasks", `${selected.id}__${taskId}.html`));
		const crumbs = breadcrumb(taskPage);
		const taskTitle = crumbs[2] ?? "";
		const taskSlug = (taskTitle ? slugify(taskTitle) : "") || taskId;
		const taskDir = join(unitDir, taskSlug);
		console.log(`  [task] ${taskTitle || taskId} -> ${relative(projectRoot, taskDir)}/`);
		writes.set(join(taskDir, "prompt.md"),
			`# ${taskTitle}\n\nSource: ${taskUrl}\n\n${htmlToMarkdown(extractTaskDescription(taskPage))}\n`);
		const downloads = unique(parseLinks(taskPage)
			.map((link) => new URL(link.href, taskUrl).toString())
			.filter((url) => url.includes("download.smartlab") || /\.(zip|gz|csv|json)(\?|$)/i.test(url))).sort();
		// Keep sizes/hashes of files a run already downloaded from the same link.
		const previous = readMetadata(join(taskDir, "meta.json"))?.data_files ?? [];
		const dataFiles: TaskDataFile[] = downloads.map((url) => previous.find((file) => file.url === url) ?? { name: dataFileName(url), url });
		const metadata: TaskMetadata = {
			unit: selected.title,
			unit_slug: selected.slug,
			task: taskTitle,
			task_slug: taskSlug,
			url: taskUrl,
			task_number: taskIndex + 1,
			data_files: dataFiles,
		};
		writes.set(join(taskDir, "meta.json"), `${JSON.stringify(metadata, null, 2)}\n`);
		if (dataFiles.length) console.log(`    [data] ${dataFiles.length} file(s) recorded; downloaded when a run needs this task`);
		else console.log("    [data] no download links found on task page");
		dataPackages.push(...dataFiles.map((file) => join(taskDir, "data", file.name)).filter((path) => existsSync(path)));
		taskPaths.push(relative(projectRoot, taskDir));
	}

	const dataFiles = dataPackages.map((packagePath) => relative(unitDir, packagePath)).sort();
	const dataHash = await hashUnitData(unitDir, dataFiles);
	if (!dataHash) throw new Error(`Could not hash complete unit corpus for ${selected.slug}`);
	if (
		cached &&
		JSON.stringify([...cached.record.dataFiles].sort()) === JSON.stringify(dataFiles) &&
		cached.record.dataHash !== dataHash
	) {
		throw new Error(
			`Unit data differs from the saved hash for ${selected.slug}; remove the changed archives so the next run downloads them again`,
		);
	}
	const hashRecord: UnitDataHash = {
		unitId: selected.id,
		unitSlug: selected.slug,
		unitTitle: selected.title,
		unitUrl: selected.url,
		taskPaths,
		dataFiles,
		dataHash,
	};
	writes.set(join(unitDir, ".data-hash.json"), `${JSON.stringify(hashRecord, null, 2)}\n`);
	for (const [path, content] of writes) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	rebuildTaskIndex(unitsDir);
	console.log(`[fetch_unit] Done. ${taskPaths.length} task(s) written for ${selected.slug}.`);
	return { unitSlug: selected.slug, taskPaths };
}
