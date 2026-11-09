import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
	extractTaskDescription,
	extractUnitDescription,
	htmlToMarkdown,
	fetchUnit,
	type FetchUnitDependencies,
} from "./fetch_unit.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "fetch-unit-"));
	roots.push(root);
	const cacheDir = join(root, "cache");
	const baseUrl = "https://lab.example/";
	const unitPath = "/units/abcdef/tasks/";
	const taskPath = `${unitPath}abcdef01/`;
	const pages = new Map<string, string>([
		["/units/", `<a href="${unitPath}">Sample Unit</a>`],
		[unitPath, `<li class="breadcrumb-item">Units</li><li class="breadcrumb-item">Sample Unit</li>
			<div class="col-md-12"><h1 class="bd-title">Sample Unit</h1><p>Public introduction.</p></div>
			<a href="${taskPath}">Details</a>`],
		[taskPath, taskPage("https://download.smartlab.example/week-one.zip")],
	]);
	const requested: string[] = [];
	const dependencies: FetchUnitDependencies = { projectRoot: root, cacheDir, client: {
		baseUrl,
		async get(url) {
			const path = new URL(url).pathname;
			requested.push(path);
			if (!pages.has(path)) throw new Error("private provider failure; do not print");
			const text = pages.get(path)!;
			return { url, status: 200, headers: {}, text, body: Buffer.from(text) };
		},
	} };
	return { root, cacheDir, pages, requested, unitPath, taskPath, dependencies };
}

function taskPage(download: string): string {
	return `<li class="breadcrumb-item">Units</li><li class="breadcrumb-item">Sample Unit</li><li class="breadcrumb-item">Sample Task</li>
		<div class="col-md-8"><h1 class="bd-title">Sample Task</h1><p>${"Task instructions. ".repeat(25)}</p>
		<a href="${download}">Data</a></div>`;
}

function files(root: string): Record<string, string> {
	const result: Record<string, string> = {};
	function walk(path: string) {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) walk(child);
			else result[relative(root, child)] = readFileSync(child).toString("base64");
		}
	}
	walk(root);
	return result;
}

describe("Live metadata refresh", () => {
	test("unreachable lab makes no directories or files and hides raw errors", async () => {
		const f = fixture();
		f.pages.clear();
		await expect(fetchUnit("sample-unit", {}, f.dependencies)).rejects.toThrow("No local files were changed");
		expect(readdirSync(f.root)).toEqual([]);
	});

	test("a later task fetch failure preserves old metadata and caches", async () => {
		const f = fixture();
		await fetchUnit("sample-unit", {}, f.dependencies);
		const before = files(f.root);
		f.pages.set(f.unitPath, f.pages.get(f.unitPath)! + `<a href="${f.unitPath}abcdef02/">New task</a>`);
		f.pages.set(f.taskPath, taskPage("https://download.smartlab.example/week-two.zip"));
		await expect(fetchUnit("sample-unit", {}, f.dependencies)).rejects.toThrow("metadata is unavailable");
		expect(files(f.root)).toEqual(before);
	});

	test("valid local hashes and old HTML never hide newly published links", async () => {
		const f = fixture();
		await fetchUnit("sample-unit", {}, f.dependencies);
		const metaPath = join(f.root, "units/sample-unit/sample-task/meta.json");
		const metadata = JSON.parse(readFileSync(metaPath, "utf8"));
		metadata.data_files[0] = { ...metadata.data_files[0], bytes: 123, sha256: "retained-download-hash" };
		writeFileSync(metaPath, JSON.stringify(metadata));
		f.requested.length = 0;
		f.pages.set(f.taskPath, taskPage("https://download.smartlab.example/week-one.zip")
			+ '<a href="https://download.smartlab.example/week-two.zip">Week two</a>');
		await fetchUnit("sample-unit", {}, f.dependencies);
		expect(f.requested).toEqual(["/units/", f.unitPath, f.taskPath]);
		const updated = JSON.parse(readFileSync(metaPath, "utf8"));
		expect(updated.data_files).toEqual([
			{ name: "week-one.zip", url: "https://download.smartlab.example/week-one.zip", bytes: 123, sha256: "retained-download-hash" },
			{ name: "week-two.zip", url: "https://download.smartlab.example/week-two.zip" },
		]);
		expect(readFileSync(join(f.cacheDir, "tasks/abcdef__abcdef01.html"), "utf8")).toContain("week-two.zip");
		expect(existsSync(join(f.root, "units/sample-unit/sample-task/data"))).toBe(false);
	});

	test("invalid task descriptions are rejected before any staged page is written", async () => {
		const f = fixture();
		f.pages.set(f.taskPath, "<div>Broken task page</div>");
		await expect(fetchUnit("sample-unit", {}, f.dependencies)).rejects.toThrow("primary task description");
		expect(readdirSync(f.root)).toEqual([]);
	});
});


describe("SmartLab description extraction", () => {
	test("extracts the task description instead of the submit modal", () => {
		const page = `
			<div class="row">
				<div class="col-md-12"><ol class="breadcrumb"><li>Task</li></ol></div>
				<div class="col-md-8">
					<h1 class="bd-title mb-3">Spam Detection</h1>
					<p>Train a spam classifier with Balanced Accuracy.</p>
					<div class="codehilite"><pre><code>data/example.x;1</code></pre></div>
				</div>
				<div class="col-md-4"><p>Sidebar</p></div>
			</div>
			<div class="modal-content"><h5>Submit New Attempt</h5></div>`;

		const markdown = htmlToMarkdown(extractTaskDescription(page));
		expect(markdown).toContain("Train a spam classifier");
		expect(markdown).toContain("data/example.x;1");
		expect(markdown).toContain("```");
		expect(markdown).not.toContain("Sidebar");
		expect(markdown).not.toContain("Submit New Attempt");
	});

	test("excludes confidential unit credentials and task cards", () => {
		const page = `
			<div class="row"><div class="col-md-12">
				<h1 class="bd-title mb-3">Introduction with Spam</h1>
				<p>Welcome to the spam unit.</p>
				<div class="cards-columns">
					<button>Show Confidential Unit Information</button>
					<div id="user_info"><p>Please login with ssh user@host with the password secret.</p></div>
				</div>
				<h2>Tasks</h2><p>Task cards follow.</p>
			</div></div>`;

		const markdown = htmlToMarkdown(extractUnitDescription(page));
		expect(markdown).toContain("Welcome to the spam unit");
		expect(markdown).not.toContain("Confidential");
		expect(markdown).not.toContain("password");
		expect(markdown).not.toContain("Task cards");
	});
});
