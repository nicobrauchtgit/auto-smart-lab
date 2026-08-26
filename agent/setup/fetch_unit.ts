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
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { LabClient } from "./lab_client.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const UNITS_DIR = join(PROJECT_ROOT, "units");
const CACHE_DIR = join(HERE, "downloaded_task_page");

export interface FetchUnitOptions {
	insecure?: boolean;
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

function mainContent(page: string): string {
	const match = page.match(
		/<(?:div|main|article)[^>]*(?:id|class)=(?:"[^"]*(?:content|main|task|description)[^"]*"|'[^']*(?:content|main|task|description)[^']*')[^>]*>([\s\S]*?)<\/(?:div|main|article)>/i,
	);
	return match?.[1] ?? page;
}

function htmlToMarkdown(fragment: string): string {
	let text = fragment;
	for (let level = 6; level >= 1; level--) {
		text = text.replace(new RegExp(`<h${level}[^>]*>([\\s\\S]*?)<\\/h${level}>`, "gi"),
			(_match, content) => `\n${"#".repeat(level)} ${stripTags(content)}\n`);
	}
	text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_match, content) => `- ${stripTags(content)}\n`);
	text = text.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
		(_match, content) => `\n\`\`\`\n${decodeHtml(content.replace(/<[^>]+>/g, ""))}\n\`\`\`\n`);
	text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_match, content) => `\`${stripTags(content)}\``);
	text = text.replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi,
		(_match, content) => `**${stripTags(content)}**`);
	text = text.replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi,
		(_match, content) => `*${stripTags(content)}*`);
	text = text.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi,
		(_match, tag, content) => `[${stripTags(content)}](${attribute(tag, "href") ?? ""})`);
	text = text.replace(/<br\s*\/?>/gi, "\n");
	text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_match, content) => `\n${stripTags(content)}\n`);
	return decodeHtml(text.replace(/<[^>]+>/g, " ").replace(/\n{3,}/g, "\n\n")).trim();
}

function slugify(value: string): string {
	return value.toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/[\s_]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

async function cachedGet(client: LabClient, url: string, path: string): Promise<string> {
	mkdirSync(dirname(path), { recursive: true });
	if (existsSync(path) && statSync(path).size > 0) return readFileSync(path, "utf8");
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
	refetchUnit: boolean,
): Promise<string[]> {
	mkdirSync(destination, { recursive: true });
	const packages: string[] = [];
	for (const url of urls) {
		const urlPath = new URL(url).pathname;
		const filename = decodeURIComponent(basename(urlPath)) || "data.zip";
		const localPath = join(destination, filename);
		if (!existsSync(localPath) || refetchUnit) {
			console.log(`    [download] ${url}`);
			const response = await client.get(url);
			writeFileSync(localPath, response.body);
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

function rebuildTaskIndex(): void {
	mkdirSync(UNITS_DIR, { recursive: true });
	const index: Record<string, string> = {};
	const stopwords = new Set(["introduction", "with", "the", "a", "an", "and", "or", "in", "of", "to"]);
	for (const unitName of readdirSync(UNITS_DIR).sort()) {
		const unitDir = join(UNITS_DIR, unitName);
		if (!statSync(unitDir).isDirectory()) continue;
		const parts = unitName.split("-").filter((part) => !stopwords.has(part));
		const keyword = parts.at(-1) ?? unitName;
		const tasks = readdirSync(unitDir)
			.map((name) => join(unitDir, name))
			.filter((path) => statSync(path).isDirectory() && existsSync(join(path, "meta.json")))
			.sort((left, right) => {
				const leftMeta = readMetadata(join(left, "meta.json"));
				const rightMeta = readMetadata(join(right, "meta.json"));
				const leftNumber = Number(leftMeta?.task.match(/^(\d+)\./)?.[1] ?? 999);
				const rightNumber = Number(rightMeta?.task.match(/^(\d+)\./)?.[1] ?? 999);
				return leftNumber - rightNumber || left.localeCompare(right);
			});
		tasks.forEach((taskDir, indexWithinUnit) => {
			const metadataPath = join(taskDir, "meta.json");
			const metadata = readMetadata(metadataPath);
			if (!metadata) return;
			const taskNumber = Number(metadata.task.match(/^(\d+)\./)?.[1] ?? indexWithinUnit + 1);
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
	if (cached?.valid) {
		console.log(`[fetch_unit] ${cached.record.unitSlug} unit data hash matches; skipping fetch.`);
		return { unitSlug: cached.record.unitSlug, taskPaths: cached.record.taskPaths };
	}
	const refetchUnit = cached !== undefined;
	const client = new LabClient({ insecure: options.insecure });
	const unitsUrl = new URL("/units/", client.baseUrl).toString();
	const unitsPage = await cachedGet(client, unitsUrl, join(CACHE_DIR, "units.html"));
	const discovered = unique(parseLinks(unitsPage)
		.filter((link) => /\/units\/[0-9a-f-]+\/tasks\/?$/i.test(link.href))
		.map((link) => new URL(link.href, client.baseUrl).toString()));
	const directUrl = /^https?:\/\//i.test(unit) ? new URL(unit).toString() : undefined;
	const candidates = directUrl ? [directUrl] : discovered;
	if (candidates.length === 0) throw new Error("No SmartLab unit links found; check login and LAB_BASE_URL");

	let selected: { url: string; id: string; page: string; title: string; slug: string } | undefined;
	const query = unit.toLowerCase();
	for (const url of candidates) {
		const segments = new URL(url).pathname.split("/").filter(Boolean);
		const id = segments.at(-1) === "tasks" ? segments.at(-2) ?? "unit" : segments.at(-1) ?? "unit";
		const page = await cachedGet(client, url, join(CACHE_DIR, "units", `${id}.html`));
		const crumbs = breadcrumb(page);
		const title = crumbs[1] ?? "";
		const slug = (title ? slugify(title) : "") || id;
		if (directUrl || [id.toLowerCase(), title.toLowerCase(), slug.toLowerCase()].includes(query) ||
			id.toLowerCase().startsWith(query)) {
			selected = { url, id, page, title, slug };
			break;
		}
	}
	if (!selected) throw new Error(`Unit not found: ${unit}`);

	const unitDir = join(UNITS_DIR, selected.slug);
	mkdirSync(unitDir, { recursive: true });
	console.log(`[unit] ${selected.title || selected.id} -> ${relative(PROJECT_ROOT, unitDir)}/`);
	const intro = htmlToMarkdown(mainContent(selected.page));
	if (intro) writeFileSync(join(unitDir, "unit-intro.md"), `# ${selected.title}\n\n${intro}\n`);

	const taskUrls = unique(parseLinks(selected.page)
		.filter((link) => /\/units\/[0-9a-f-]+\/tasks\/[0-9a-f-]+\/?$/i.test(link.href))
		.map((link) => new URL(link.href, selected.url).toString()));
	if (taskUrls.length === 0) throw new Error(`No tasks found for unit ${selected.title || selected.id}`);
	const taskPaths: string[] = [];
	const dataPackages: string[] = [];
	for (const taskUrl of taskUrls) {
		const taskId = new URL(taskUrl).pathname.split("/").filter(Boolean).at(-1) ?? "task";
		const taskPage = await cachedGet(client, taskUrl,
			join(CACHE_DIR, "tasks", `${selected.id}__${taskId}.html`));
		const crumbs = breadcrumb(taskPage);
		const taskTitle = crumbs[2] ?? "";
		const taskSlug = (taskTitle ? slugify(taskTitle) : "") || taskId;
		const taskDir = join(unitDir, taskSlug);
		mkdirSync(taskDir, { recursive: true });
		console.log(`  [task] ${taskTitle || taskId} -> ${relative(PROJECT_ROOT, taskDir)}/`);
		writeFileSync(join(taskDir, "prompt.md"),
			`# ${taskTitle}\n\nSource: ${taskUrl}\n\n${htmlToMarkdown(mainContent(taskPage))}\n`);
		const metadata: TaskMetadata = {
			unit: selected.title,
			unit_slug: selected.slug,
			task: taskTitle,
			task_slug: taskSlug,
			url: taskUrl,
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
				refetchUnit,
			));
		}
		else console.log("    [data] no download links found on task page");
		taskPaths.push(relative(PROJECT_ROOT, taskDir));
	}

	rebuildTaskIndex();
	const dataFiles = dataPackages.map((packagePath) => relative(unitDir, packagePath)).sort();
	const dataHash = await hashUnitData(unitDir, dataFiles);
	if (!dataHash) throw new Error(`Could not hash complete unit corpus for ${selected.slug}`);
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
