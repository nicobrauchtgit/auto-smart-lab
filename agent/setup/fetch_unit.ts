import {
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { LabClient } from "./lab_client.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const UNITS_DIR = join(PROJECT_ROOT, "units");
const CACHE_DIR = join(HERE, "downloaded_task_page");

export interface FetchUnitOptions {
	insecure?: boolean;
	refreshMetadata?: boolean;
	refreshData?: boolean;
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

async function findCachedUnit(unit: string): Promise<{
	record: UnitDataHash;
	unitDir: string;
	valid: boolean;
} | undefined> {
	if (!existsSync(UNITS_DIR)) return undefined;
	const query = unit.toLowerCase().replace(/\/$/, "");
	for (const unitName of readdirSync(UNITS_DIR)) {
		const unitDir = join(UNITS_DIR, unitName);
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
		const currentHash = await hashUnitData(unitDir, record.dataFiles);
		return { record, unitDir, valid: currentHash === record.dataHash };
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

async function cachedGet(client: LabClient, url: string, path: string, refresh = false): Promise<string> {
	mkdirSync(dirname(path), { recursive: true });
	if (!refresh && existsSync(path) && statSync(path).size > 0) return readFileSync(path, "utf8");
	const response = await client.get(url);
	writeFileSync(path, response.body);
	return response.text;
}

async function extractZip(archive: string, destination: string): Promise<boolean> {
	const listing = Bun.spawn(["unzip", "-Z1", archive], { stdout: "pipe", stderr: "pipe" });
	const [listingText, listingError, listingExit] = await Promise.all([
		new Response(listing.stdout).text(),
		new Response(listing.stderr).text(),
		listing.exited,
	]);
	if (listingExit !== 0) throw new Error(listingError.trim() || `unzip listing exited with ${listingExit}`);
	const destinationRoot = resolve(destination);
	const entries = listingText.split(/\r?\n/).filter(Boolean).map((entry) => entry.replaceAll("\\", "/"));
	for (const entry of entries) {
		const target = resolve(destinationRoot, entry);
		if (target !== destinationRoot && !target.startsWith(`${destinationRoot}${sep}`)) {
			throw new Error(`unsafe archive path: ${entry}`);
		}
	}
	if (entries.length > 0 && entries.every((entry) => existsSync(resolve(destinationRoot, entry)))) {
		return false;
	}

	const child = Bun.spawn(["unzip", "-o", "-q", archive, "-d", destination], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const errorText = await new Response(child.stderr).text();
	const exitCode = await child.exited;
	if (exitCode !== 0) throw new Error(errorText.trim() || `unzip exited with ${exitCode}`);
	return true;
}

async function downloadData(
	client: LabClient,
	urls: string[],
	destination: string,
	refreshData: boolean,
): Promise<string[]> {
	mkdirSync(destination, { recursive: true });
	const packages: string[] = [];
	for (const url of urls) {
		const urlPath = new URL(url).pathname;
		const filename = decodeURIComponent(basename(urlPath)) || "data.zip";
		const localPath = join(destination, filename);
		if (!existsSync(localPath) || refreshData) {
			console.log(`    [download] ${url}`);
			const response = await client.get(url);
			const expectedLength = Number(response.headers["content-length"] ?? 0);
			if (expectedLength > 0 && response.body.length !== expectedLength) {
				throw new Error(`Incomplete download for ${url}: expected ${expectedLength} bytes, got ${response.body.length}`);
			}
			if (filename.toLowerCase().endsWith(".zip")) {
				const signature = response.body.subarray(0, 4).toString("hex");
				if (!["504b0304", "504b0506", "504b0708"].includes(signature)) {
					throw new Error(`Downloaded response is not a ZIP archive: ${url}`);
				}
			}
			const temporaryPath = `${localPath}.tmp`;
			writeFileSync(temporaryPath, response.body);
			renameSync(temporaryPath, localPath);
		} else {
			console.log(`    [skip] ${filename} (already downloaded)`);
		}
		packages.push(localPath);
		if (filename.toLowerCase().endsWith(".zip")) {
			try {
				if (await extractZip(localPath, destination)) {
					console.log(`    [extract] ${filename} -> ${relative(PROJECT_ROOT, destination)}/`);
				}
			} catch (error) {
				console.warn(`    [warn] could not extract ${filename}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
	return packages;
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

function metadataCacheValid(record: UnitDataHash): boolean {
	const introPath = join(PROJECT_ROOT, record.unitSlug.startsWith("units/") ? record.unitSlug : `units/${record.unitSlug}`, "unit-intro.md");
	if (!existsSync(introPath)) return false;
	const intro = readFileSync(introPath, "utf8");
	if (/Confidential Unit Information|Please login with[\s\S]{0,300}password/i.test(intro)) return false;
	const indexPath = join(UNITS_DIR, "index.json");
	if (!existsSync(indexPath)) return false;
	let index: Record<string, string>;
	try {
		index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, string>;
	} catch {
		return false;
	}
	const keyword = unitKeyword(record.unitSlug);
	for (const [position, taskPath] of record.taskPaths.entries()) {
		const taskDir = resolve(PROJECT_ROOT, taskPath);
		const promptPath = join(taskDir, "prompt.md");
		const metadataPath = join(taskDir, "meta.json");
		if (!existsSync(promptPath) || !existsSync(metadataPath)) return false;
		const prompt = readFileSync(promptPath, "utf8");
		if (prompt.length < 300 || /Submit New Attempt/i.test(prompt)) return false;
		const metadata = readMetadata(metadataPath);
		const taskNumber = position + 1;
		const shortId = `${keyword}${taskNumber}`;
		if (!metadata || metadata.task_number !== taskNumber || metadata.short_id !== shortId) return false;
		if (index[shortId] !== metadata.url) return false;
	}
	return true;
}

function rebuildTaskIndex(): void {
	mkdirSync(UNITS_DIR, { recursive: true });
	const index: Record<string, string> = {};
	for (const unitName of readdirSync(UNITS_DIR).sort()) {
		const unitDir = join(UNITS_DIR, unitName);
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
	writeFileSync(join(UNITS_DIR, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
	console.log(`[fetch_unit] Index contains: ${Object.keys(index).join(", ")}`);
}

export async function fetchUnit(unit: string, options: FetchUnitOptions = {}): Promise<FetchUnitResult> {
	const cached = await findCachedUnit(unit);
	if (cached?.valid && metadataCacheValid(cached.record) && !options.refreshMetadata && !options.refreshData) {
		console.log(`[fetch_unit] ${cached.record.unitSlug} unit data hash matches; skipping fetch.`);
		return { unitSlug: cached.record.unitSlug, taskPaths: cached.record.taskPaths };
	}
	// SmartLab uses a permanently self-signed certificate on its lab/download hosts.
	const client = new LabClient({ insecure: options.insecure ?? true });
	const unitsUrl = new URL("/units/", client.baseUrl).toString();
	const unitsPage = await cachedGet(client, unitsUrl, join(CACHE_DIR, "units.html"), options.refreshMetadata);
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
		const page = await cachedGet(client, url, join(CACHE_DIR, "units", `${id}.html`), options.refreshMetadata);
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
	const localNames = existsSync(UNITS_DIR) ? readdirSync(UNITS_DIR) : [];
	const existingName = localNames.find((name) =>
		[name.toLowerCase(), slugify(name)].includes(querySlug) || name.toLowerCase() === numberedAlias);
	const selected = { ...matched, slug: existingName ?? numberedAlias ?? matched.slug };

	const unitDir = join(UNITS_DIR, selected.slug);
	mkdirSync(unitDir, { recursive: true });
	console.log(`[unit] ${selected.title || selected.id} -> ${relative(PROJECT_ROOT, unitDir)}/`);
	const intro = htmlToMarkdown(extractUnitDescription(selected.page));
	if (intro) writeFileSync(join(unitDir, "unit-intro.md"), `# ${selected.title}\n\n${intro}\n`);

	const taskUrls = unique(parseLinks(selected.page)
		.filter((link) => /\/units\/[0-9a-f-]+\/tasks\/[0-9a-f-]+\/?$/i.test(link.href))
		.map((link) => new URL(link.href, selected.url).toString()));
	if (taskUrls.length === 0) throw new Error(`No tasks found for unit ${selected.title || selected.id}`);
	const taskPaths: string[] = [];
	const dataPackages: string[] = [];
	for (const [taskIndex, taskUrl] of taskUrls.entries()) {
		const taskId = new URL(taskUrl).pathname.split("/").filter(Boolean).at(-1) ?? "task";
		const taskPage = await cachedGet(client, taskUrl,
			join(CACHE_DIR, "tasks", `${selected.id}__${taskId}.html`), options.refreshMetadata);
		const crumbs = breadcrumb(taskPage);
		const taskTitle = crumbs[2] ?? "";
		const taskSlug = (taskTitle ? slugify(taskTitle) : "") || taskId;
		const taskDir = join(unitDir, taskSlug);
		mkdirSync(taskDir, { recursive: true });
		console.log(`  [task] ${taskTitle || taskId} -> ${relative(PROJECT_ROOT, taskDir)}/`);
		writeFileSync(join(taskDir, "prompt.md"),
			`# ${taskTitle}\n\nSource: ${taskUrl}\n\n${htmlToMarkdown(extractTaskDescription(taskPage))}\n`);
		const metadata: TaskMetadata = {
			unit: selected.title,
			unit_slug: selected.slug,
			task: taskTitle,
			task_slug: taskSlug,
			url: taskUrl,
			task_number: taskIndex + 1,
		};
		writeFileSync(join(taskDir, "meta.json"), `${JSON.stringify(metadata, null, 2)}\n`);

		const downloads = unique(parseLinks(taskPage)
			.map((link) => new URL(link.href, taskUrl).toString())
			.filter((url) => url.includes("download.smartlab") || /\.(zip|gz|csv|json)(\?|$)/i.test(url)));
		if (downloads.length > 0) {
			dataPackages.push(...await downloadData(
				client,
				downloads.sort(),
				join(taskDir, "data"),
				options.refreshData ?? false,
			));
		}
		else console.log("    [data] no download links found on task page");
		taskPaths.push(relative(PROJECT_ROOT, taskDir));
	}

	rebuildTaskIndex();
	const dataFiles = dataPackages.map((packagePath) => relative(unitDir, packagePath)).sort();
	const dataHash = await hashUnitData(unitDir, dataFiles);
	if (!dataHash) throw new Error(`Could not hash complete unit corpus for ${selected.slug}`);
	if (
		cached && !options.refreshData &&
		JSON.stringify([...cached.record.dataFiles].sort()) === JSON.stringify(dataFiles) &&
		cached.record.dataHash !== dataHash
	) {
		throw new Error(
			`Unit data differs from the saved hash for ${selected.slug}; rerun with { refreshData: true } to replace existing archives`,
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
	writeFileSync(join(unitDir, ".data-hash.json"), `${JSON.stringify(hashRecord, null, 2)}\n`);
	console.log(`[fetch_unit] Done. ${taskPaths.length} task(s) written for ${selected.slug}.`);
	return { unitSlug: selected.slug, taskPaths };
}
