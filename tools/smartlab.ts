/**
 * SmartLab submit tool (native TypeScript, no Python, no subprocess).
 *
 * Exposes exactly ONE pi tool: `smartlab_submit`. Given a prediction CSV it
 * logs in to the SmartLab web UI behind the scenes (using LAB_USER / LAB_PASS),
 * uploads the CSV plus an in-memory source archive, polls the task's Attempts
 * table, and returns the score with info.
 *
 * Auth/session handling (CSRF login, cookie jar, re-login) is internal and is
 * NOT exposed as tools. Task listing/creation is handled elsewhere.
 *
 * Environment:
 *   LAB_USER, LAB_PASS        credentials (required for login)
 *   LAB_BASE_URL              default https://lab-test.smartlab.mlsec.tu-berlin.de/
 *   LAB_LOGIN_URL             default = LAB_BASE_URL
 *   LAB_INSECURE_TLS=1        accept the lab's self-signed certificate
 *   SMARTLAB_TASK_URL         default task_url when the tool arg is omitted
 *
 * Auto-loaded for every pi session started in this repo via .pi/settings.json
 * ("extensions": ["../tools/smartlab.ts"]). For a one-off test you can also run:
 *   pi -e tools/smartlab.ts
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { deflateRawSync } from "node:zlib";

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, ".."); // <root>/tools/smartlab.ts

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const MAX_TRIES = 3;

function truthy(value: string | undefined): boolean {
	return ["1", "true", "yes", "y", "on"].includes(String(value ?? "").toLowerCase());
}

// --------------------------------------------------------------------------
// HTTP response + cookie-aware client
// --------------------------------------------------------------------------

interface HttpResponse {
	url: string;
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: Buffer;
	text: string;
}

interface RequestOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: Buffer;
	signal?: AbortSignal;
	followRedirects?: boolean;
}

class LabClient {
	private cookies = new Map<string, string>();
	private agent?: HttpsAgent;
	readonly baseUrl: string;
	readonly loginUrl: string;

	constructor(private insecure: boolean) {
		this.baseUrl = process.env.LAB_BASE_URL ?? "https://lab-test.smartlab.mlsec.tu-berlin.de/";
		this.loginUrl = process.env.LAB_LOGIN_URL ?? this.baseUrl;
		if (insecure) this.agent = new HttpsAgent({ rejectUnauthorized: false });
	}

	private cookieHeader(): string {
		return Array.from(this.cookies.entries())
			.map(([k, v]) => `${k}=${v}`)
			.join("; ");
	}

	private storeCookies(setCookie: string | string[] | undefined): void {
		if (!setCookie) return;
		const list = Array.isArray(setCookie) ? setCookie : [setCookie];
		for (const raw of list) {
			const pair = raw.split(";", 1)[0];
			const eq = pair.indexOf("=");
			if (eq <= 0) continue;
			const name = pair.slice(0, eq).trim();
			const value = pair.slice(eq + 1).trim();
			if (name) this.cookies.set(name, value);
		}
	}

	cookie(name: string): string | undefined {
		return this.cookies.get(name);
	}

	private rawRequest(url: string, opts: RequestOptions): Promise<HttpResponse> {
		const parsed = new URL(url);
		const isHttps = parsed.protocol === "https:";
		const requester = isHttps ? httpsRequest : httpRequest;
		const headers: Record<string, string> = {
			"User-Agent": "Mozilla/5.0 smartlab-auto-agent/0.1",
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
			...(opts.headers ?? {}),
		};
		const cookieHeader = this.cookieHeader();
		if (cookieHeader) headers.Cookie = cookieHeader;
		if (opts.body) headers["Content-Length"] = String(opts.body.length);

		return new Promise<HttpResponse>((resolvePromise, rejectPromise) => {
			const req = requester(
				{
					protocol: parsed.protocol,
					hostname: parsed.hostname,
					port: parsed.port || (isHttps ? 443 : 80),
					path: parsed.pathname + parsed.search,
					method: opts.method ?? "GET",
					headers,
					...(isHttps && this.agent ? { agent: this.agent } : {}),
				},
				(res) => {
					this.storeCookies(res.headers["set-cookie"]);
					const chunks: Buffer[] = [];
					res.on("data", (c) => chunks.push(c as Buffer));
					res.on("end", () => {
						const body = Buffer.concat(chunks);
						resolvePromise({
							url,
							status: res.statusCode ?? 0,
							headers: res.headers,
							body,
							text: body.toString("utf8"),
						});
					});
				},
			);
			req.on("error", rejectPromise);
			if (opts.signal) {
				if (opts.signal.aborted) {
					req.destroy(new Error("aborted"));
				} else {
					opts.signal.addEventListener("abort", () => req.destroy(new Error("aborted")), {
						once: true,
					});
				}
			}
			req.setTimeout(180_000, () => req.destroy(new Error("request timed out")));
			if (opts.body) req.write(opts.body);
			req.end();
		});
	}

	/** Perform a request, following redirects and carrying cookies. */
	async request(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
		let currentUrl = url;
		let method = opts.method ?? "GET";
		let body = opts.body;
		const follow = opts.followRedirects ?? true;

		for (let hop = 0; hop < 10; hop++) {
			const res = await this.rawRequest(currentUrl, { ...opts, method, body });
			const location = res.headers.location as string | undefined;
			if (follow && res.status >= 300 && res.status < 400 && location) {
				currentUrl = new URL(location, currentUrl).toString();
				if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
					method = "GET";
					body = undefined;
				}
				continue;
			}
			return { ...res, url: currentUrl };
		}
		throw new Error(`Too many redirects starting from ${url}`);
	}

	// ---- login / session ----

	private isLoginPage(html: string): boolean {
		for (const form of parseForms(html)) {
			const hasPassword = form.inputs.some((i) => (i.type ?? "text").toLowerCase() === "password");
			const hasUser = form.inputs.some((i) => /user|login/i.test(i.name ?? ""));
			if (hasPassword && hasUser) return true;
		}
		return false;
	}

	private csrfFromHtmlOrCookie(html: string): string | undefined {
		for (const form of parseForms(html)) {
			for (const input of form.inputs) {
				if (input.name === "csrfmiddlewaretoken" && input.value) return input.value;
			}
		}
		return this.cookies.get("csrftoken");
	}

	async login(signal?: AbortSignal): Promise<HttpResponse> {
		const username = process.env.LAB_USER;
		const password = process.env.LAB_PASS;
		if (!username || !password) {
			throw new Error("Set LAB_USER and LAB_PASS in the environment before submitting.");
		}

		const loginPage = await this.request(this.loginUrl, { signal });
		if (loginPage.status >= 400) {
			throw new Error(`Could not load login page: HTTP ${loginPage.status}`);
		}

		const forms = parseForms(loginPage.text);
		const form =
			forms.find((f) => f.inputs.some((i) => (i.type ?? "text").toLowerCase() === "password")) ??
			forms[0];
		if (!form) throw new Error("Could not find a login form");

		const actionUrl = new URL(form.action || loginPage.url, loginPage.url).toString();
		const data: Record<string, string> = {};
		let passwordField = "password";
		let usernameField = "username";

		for (const input of form.inputs) {
			const name = input.name;
			if (!name) continue;
			const type = (input.type ?? "text").toLowerCase();
			const value = input.value ?? "";
			if (type === "hidden" || type === "submit") data[name] = value;
			if (type === "password") passwordField = name;
			if (
				(type === "text" || type === "email") &&
				(/user|login/i.test(name) || usernameField === "username")
			) {
				usernameField = name;
			}
		}

		if (!("csrfmiddlewaretoken" in data)) {
			const token = this.csrfFromHtmlOrCookie(loginPage.text);
			if (token) data.csrfmiddlewaretoken = token;
		}
		data[usernameField] = username;
		data[passwordField] = password;

		const referer = loginPage.url;
		const origin = new URL(referer);
		const result = await this.request(actionUrl, {
			method: "POST",
			body: Buffer.from(new URLSearchParams(data).toString(), "utf8"),
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Referer: referer,
				Origin: `${origin.protocol}//${origin.host}`,
			},
			signal,
		});
		if (result.status >= 400) throw new Error(`Login POST failed: HTTP ${result.status}`);
		if (this.isLoginPage(result.text)) {
			throw new Error("Login failed or server still returned the login page (check LAB_USER/LAB_PASS).");
		}
		return result;
	}

	/** Fetch a lab path/URL, transparently logging in if the session expired. */
	async get(pathOrUrl: string, signal?: AbortSignal): Promise<HttpResponse> {
		const url = new URL(pathOrUrl, this.baseUrl).toString();
		let res = await this.request(url, { signal });
		if (res.status === 401 || res.status === 403 || this.isLoginPage(res.text)) {
			await this.login(signal);
			res = await this.request(url, { signal });
		}
		if (res.status >= 400) throw new Error(`Fetch failed: HTTP ${res.status} for ${url}`);
		return res;
	}
}

// --------------------------------------------------------------------------
// HTML / attempts-table parsing (ports smartlab/submit.py)
// --------------------------------------------------------------------------

interface FormInput {
	name?: string;
	type?: string;
	value?: string;
}
interface ParsedForm {
	action: string;
	method: string;
	inputs: FormInput[];
}

function parseAttrs(tag: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(tag))) {
		const key = m[1].toLowerCase();
		const value = m[3] ?? m[4] ?? m[5] ?? "";
		attrs[key] = value;
	}
	return attrs;
}

function parseForms(html: string): ParsedForm[] {
	const forms: ParsedForm[] = [];
	const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
	let fm: RegExpExecArray | null;
	while ((fm = formRe.exec(html))) {
		const attrs = parseAttrs(fm[1]);
		const inputs: FormInput[] = [];
		const inputRe = /<input\b([^>]*?)\/?>/gi;
		let im: RegExpExecArray | null;
		while ((im = inputRe.exec(fm[2]))) {
			const a = parseAttrs(im[1]);
			inputs.push({ name: a.name, type: a.type, value: a.value });
		}
		forms.push({
			action: attrs.action ?? "",
			method: (attrs.method ?? "get").toLowerCase(),
			inputs,
		});
	}
	return forms;
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function cleanHtml(fragment: string): string {
	let text = fragment.replace(/<script[\s\S]*?<\/script>/gi, " ");
	text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
	text = text.replace(/<[^>]+>/g, " ");
	return decodeEntities(text.replace(/\s+/g, " ").trim());
}

function parseScore(value: string | undefined): number | null {
	if (!value) return null;
	const cleaned = cleanHtml(value);
	if (["---", "-", ""].includes(cleaned)) return null;
	const match = cleaned.match(/[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/);
	if (!match) return null;
	const n = Number(match[0]);
	return Number.isFinite(n) ? n : null;
}

function parseTriesUsed(value: string | null): number | null {
	if (!value) return null;
	const match = value.match(/(\d+)\s+of\s+\d+\s+attempts\s+used/i);
	return match ? Number(match[1]) : null;
}

interface Attempt {
	number: string;
	date: string;
	comment: string;
	result: string;
	info: string;
}
interface TaskPageInfo {
	title: string;
	taskUrl: string;
	uploadUrl: string | null;
	csrfToken: string | null;
	attemptsUsed: string | null;
	attempts: Attempt[];
}

function parseTaskPage(taskUrl: string, page: string, baseUrl: string): TaskPageInfo {
	const titleMatch = page.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
	const title = titleMatch ? cleanHtml(titleMatch[1]) : taskUrl;

	let uploadUrl: string | null = null;
	let csrfToken: string | null = null;
	const formMatch = page.match(
		/<form[^>]+action="([^"]+\/upload\/)"[^>]*enctype="multipart\/form-data"[^>]*>([\s\S]*?)<\/form>/i,
	);
	if (formMatch) {
		uploadUrl = new URL(decodeEntities(formMatch[1]), baseUrl).toString();
		const csrfMatch = formMatch[2].match(
			/<input[^>]+name="csrfmiddlewaretoken"[^>]+value="([^"]+)"/i,
		);
		if (csrfMatch) csrfToken = decodeEntities(csrfMatch[1]);
	}

	let attemptsUsed: string | null = null;
	const usedMatch = page.match(/(\d+\s+of\s+\d+\s+attempts\s+used)/i);
	if (usedMatch) attemptsUsed = usedMatch[1];

	const attempts: Attempt[] = [];
	const rowRe = /<tr>([\s\S]*?)<\/tr>/gi;
	let rm: RegExpExecArray | null;
	while ((rm = rowRe.exec(page))) {
		const cells = Array.from(rm[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map((c) => c[1]);
		if (cells.length >= 5 && !cleanHtml(rm[1]).toLowerCase().includes("currently no valid attempts")) {
			attempts.push({
				number: cleanHtml(cells[0]),
				date: cleanHtml(cells[1]),
				comment: cleanHtml(cells[2]),
				result: cleanHtml(cells[3]),
				info: cleanHtml(cells[4]),
			});
		}
	}

	return { title, taskUrl, uploadUrl, csrfToken, attemptsUsed, attempts };
}

function scores(attempts: Attempt[]): number[] {
	return attempts.map((a) => parseScore(a.result)).filter((s): s is number => s !== null);
}

// --------------------------------------------------------------------------
// In-memory source zip (ports make_source_archive)
// --------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

const EXCLUDED_DIRS = new Set([
	".git",
	"__pycache__",
	".pytest_cache",
	"env",
	"venv",
	".venv",
	"data",
	"downloaded_task_page",
	"submissions",
	"reports",
]);
const EXCLUDED_NAMES = new Set(["lab-cookies.txt", "source.zip", "output.csv"]);
const ALLOWED_SUFFIXES = new Set([
	".py",
	".sh",
	".ts",
	".md",
	".txt",
	".toml",
	".yaml",
	".yml",
	".json",
]);

function collectSourceFiles(root: string): { rel: string; abs: string }[] {
	const out: { rel: string; abs: string }[] = [];
	const walk = (dir: string, relParts: string[]) => {
		for (const entry of readdirSync(dir).sort()) {
			const abs = join(dir, entry);
			const rel = [...relParts, entry];
			const st = statSync(abs);
			if (st.isDirectory()) {
				if (EXCLUDED_DIRS.has(entry)) continue;
				walk(abs, rel);
				continue;
			}
			if (EXCLUDED_NAMES.has(entry) || entry.startsWith("._")) continue;
			const dot = entry.lastIndexOf(".");
			const suffix = dot >= 0 ? entry.slice(dot).toLowerCase() : "";
			if (!ALLOWED_SUFFIXES.has(suffix)) continue;
			out.push({ rel: rel.join("/"), abs });
		}
	};
	walk(root, []);
	return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

function buildSourceZip(root: string): Buffer {
	const files = collectSourceFiles(root);
	const localParts: Buffer[] = [];
	const centralParts: Buffer[] = [];
	let offset = 0;
	const DOS_DATE = 0x21; // 1980-01-01

	for (const { rel, abs } of files) {
		const content = readFileSync(abs);
		const crc = crc32(content);
		const compressed = deflateRawSync(content);
		const nameBuf = Buffer.from(`source/${rel}`, "utf8");

		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0, 6);
		local.writeUInt16LE(8, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(content.length, 22);
		local.writeUInt16LE(nameBuf.length, 26);
		local.writeUInt16LE(0, 28);
		localParts.push(local, nameBuf, compressed);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt16LE(0, 12);
		central.writeUInt16LE(DOS_DATE, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(content.length, 24);
		central.writeUInt16LE(nameBuf.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE(0, 38);
		central.writeUInt32LE(offset, 42);
		centralParts.push(central, nameBuf);

		offset += local.length + nameBuf.length + compressed.length;
	}

	const localBuf = Buffer.concat(localParts);
	const centralBuf = Buffer.concat(centralParts);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(0, 4);
	end.writeUInt16LE(0, 6);
	end.writeUInt16LE(files.length, 8);
	end.writeUInt16LE(files.length, 10);
	end.writeUInt32LE(centralBuf.length, 12);
	end.writeUInt32LE(localBuf.length, 16);
	end.writeUInt16LE(0, 20);
	return Buffer.concat([localBuf, centralBuf, end]);
}

// --------------------------------------------------------------------------
// Multipart upload (ports build_multipart / post_multipart, file[0]/file[1])
// --------------------------------------------------------------------------

interface UploadFile {
	field: string;
	filename: string;
	contentType: string;
	data: Buffer;
}

function buildMultipart(fields: Record<string, string>, files: UploadFile[]): { body: Buffer; boundary: string } {
	const boundary = `----smartlab${createHash("sha1").update(String(Math.random()) + Date.now()).digest("hex").slice(0, 24)}`;
	const parts: Buffer[] = [];
	const push = (s: string) => parts.push(Buffer.from(s, "utf8"));

	for (const [name, value] of Object.entries(fields)) {
		push(`--${boundary}\r\n`);
		push(`Content-Disposition: form-data; name="${name}"\r\n\r\n`);
		push(`${value}\r\n`);
	}
	for (const f of files) {
		push(`--${boundary}\r\n`);
		push(`Content-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\n`);
		push(`Content-Type: ${f.contentType}\r\n\r\n`);
		parts.push(f.data);
		push("\r\n");
	}
	push(`--${boundary}--\r\n`);
	return { body: Buffer.concat(parts), boundary };
}

// --------------------------------------------------------------------------
// Submit + score (ports submit_and_score)
// --------------------------------------------------------------------------

interface SubmissionResult {
	ok: boolean;
	upload_ok: boolean;
	upload_status: number | null;
	upload_message: string | null;
	error: string | null;
	format_error: string | null;
	max_tries: number;
	tries_used: number | null;
	tries_left: number | null;
	current_score: number | null;
	previous_scores: number[];
	improved: boolean;
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((res, rej) => {
		const t = setTimeout(res, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(t);
			rej(new Error("aborted"));
		}, { once: true });
	});

async function getTaskInfo(client: LabClient, taskUrl: string, signal?: AbortSignal): Promise<TaskPageInfo> {
	const res = await client.get(taskUrl, signal);
	return parseTaskPage(res.url, res.text, client.baseUrl);
}

interface SubmitArgs {
	client: LabClient;
	taskUrl: string;
	csvPath: string;
	sourceDir: string;
	comment: string;
	pollTimeoutS: number;
	pollIntervalS: number;
	signal?: AbortSignal;
}

async function submitAndScore(args: SubmitArgs): Promise<SubmissionResult> {
	const { client, taskUrl, csvPath, sourceDir, comment, pollTimeoutS, pollIntervalS, signal } = args;
	const before = await getTaskInfo(client, taskUrl, signal);
	const previousScores = scores(before.attempts);
	const previousBest = previousScores.length ? Math.max(...previousScores) : null;

	const make = (over: Partial<SubmissionResult> & { attemptsInfo?: TaskPageInfo }): SubmissionResult => {
		const info = over.attemptsInfo ?? before;
		const triesUsed = parseTriesUsed(info.attemptsUsed);
		const { attemptsInfo: _drop, ...rest } = over;
		return {
			ok: false,
			upload_ok: false,
			upload_status: null,
			upload_message: null,
			error: null,
			format_error: null,
			max_tries: MAX_TRIES,
			tries_used: triesUsed,
			tries_left: triesUsed !== null ? MAX_TRIES - triesUsed : null,
			current_score: null,
			previous_scores: previousScores,
			improved: false,
			...rest,
		};
	};

	if (!existsSync(csvPath)) return make({ error: `output.csv not found: ${csvPath}` });
	if (!before.uploadUrl) return make({ error: `Task page does not expose an upload form: ${taskUrl}` });
	if (!before.csrfToken) return make({ error: "Could not find upload CSRF token" });

	const csvData = readFileSync(csvPath);
	const zipData = buildSourceZip(sourceDir);
	if (zipData.length > MAX_UPLOAD_BYTES) return make({ error: `Source archive exceeds 2 MB upload limit (${zipData.length} bytes)` });
	if (csvData.length > MAX_UPLOAD_BYTES) return make({ error: `output.csv exceeds 2 MB upload limit (${csvData.length} bytes)` });

	const { body, boundary } = buildMultipart(
		{ csrfmiddlewaretoken: before.csrfToken, comment },
		[
			// Dropzone uploadMultiple=true sends file[0]/file[1], not repeated "file".
			{ field: "file[0]", filename: "output.csv", contentType: "text/csv", data: csvData },
			{ field: "file[1]", filename: "source.zip", contentType: "application/zip", data: zipData },
		],
	);

	const uploadRes = await client.request(before.uploadUrl, {
		method: "POST",
		body,
		headers: {
			"Content-Type": `multipart/form-data; boundary=${boundary}`,
			Accept: "application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			Referer: before.taskUrl,
			"X-Requested-With": "XMLHttpRequest",
			"X-CSRFToken": before.csrfToken,
		},
		signal,
	});

	const uploadMessage = cleanHtml(uploadRes.text);
	const uploadOk = uploadRes.status >= 200 && uploadRes.status < 300 && uploadMessage.toLowerCase().includes("successfully");
	if (!uploadOk) {
		return make({
			upload_ok: false,
			upload_status: uploadRes.status,
			upload_message: uploadMessage,
			error: uploadMessage || `Upload failed with HTTP ${uploadRes.status}`,
		});
	}

	// Poll the Attempts table until a new row with a result appears.
	const deadline = Date.now() + pollTimeoutS * 1000;
	let after = await getTaskInfo(client, taskUrl, signal);
	while (Date.now() < deadline) {
		const hasNew = after.attempts.length > before.attempts.length;
		if (hasNew && after.attempts[0].result) break;
		await sleep(pollIntervalS * 1000, signal);
		after = await getTaskInfo(client, taskUrl, signal);
	}

	const beforeKeys = new Set(before.attempts.map((a) => JSON.stringify(a)));
	const newAttempt = after.attempts.find((a) => !beforeKeys.has(JSON.stringify(a)));
	if (!newAttempt) {
		return make({
			upload_ok: true,
			upload_status: 200,
			upload_message: uploadMessage,
			error: "Upload succeeded, but no new attempt row appeared before timeout",
			attemptsInfo: after,
		});
	}

	const currentScore = parseScore(newAttempt.result);
	const formatError = newAttempt.info.toUpperCase() === "FAILURE" ? newAttempt.comment : null;
	if (currentScore === null) {
		return make({
			upload_ok: true,
			upload_status: 200,
			upload_message: uploadMessage,
			error: "No numeric score returned",
			format_error: formatError,
			attemptsInfo: after,
		});
	}

	const improved = previousBest === null || currentScore > previousBest;
	return make({
		ok: true,
		upload_ok: true,
		upload_status: 200,
		upload_message: uploadMessage,
		attemptsInfo: after,
		current_score: currentScore,
		improved,
	});
}

// --------------------------------------------------------------------------
// The single pi tool
// --------------------------------------------------------------------------

export default function smartlabExtension(pi: ExtensionAPI) {
	pi.registerTool(
		defineTool({
			name: "smartlab_submit",
			label: "SmartLab: submit",
			description:
				"Submit a SmartLab solution: upload a prediction CSV and return the resulting score plus attempt info. Login and CSRF/session handling happen automatically using LAB_USER/LAB_PASS.",
			promptSnippet: "Submit a SmartLab prediction CSV and read back the score",
			promptGuidelines: [
				"Use smartlab_submit to upload a finished prediction CSV to SmartLab and get the score; do not try to log in or fetch tokens separately.",
			],
			parameters: Type.Object({
				csv: Type.String({ description: "Path to the prediction CSV to upload (as output.csv)" }),
				task_url: Type.Optional(
					Type.String({ description: "Full task URL (defaults to SMARTLAB_TASK_URL env)" }),
				),
				comment: Type.Optional(Type.String({ description: "Attempt comment", default: "auto-agent submission" })),
				source_dir: Type.Optional(
					Type.String({ description: "Directory to archive as source.zip (default: project root)" }),
				),
				poll_timeout: Type.Optional(Type.Integer({ description: "Seconds to poll for the result", default: 180 })),
				poll_interval: Type.Optional(Type.Integer({ description: "Seconds between polls", default: 10 })),
			}),
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				if (signal?.aborted) {
					return { content: [{ type: "text", text: "Cancelled" }], details: {} };
				}

				const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? PROJECT_ROOT;
				const rawCsv = params.csv.replace(/^@/, "");
				const csvPath = isAbsolute(rawCsv) ? rawCsv : resolve(cwd, rawCsv);
				const taskUrl = params.task_url ?? process.env.SMARTLAB_TASK_URL;
				if (!taskUrl) {
					throw new Error("No task_url given and SMARTLAB_TASK_URL is not set.");
				}
				const sourceDir = params.source_dir
					? isAbsolute(params.source_dir)
						? params.source_dir
						: resolve(cwd, params.source_dir)
					: PROJECT_ROOT;

				const client = new LabClient(truthy(process.env.LAB_INSECURE_TLS));
				const result = await submitAndScore({
					client,
					taskUrl,
					csvPath,
					sourceDir,
					comment: params.comment ?? "auto-agent submission",
					pollTimeoutS: params.poll_timeout ?? 180,
					pollIntervalS: params.poll_interval ?? 10,
					signal,
				});

				return {
					content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
					details: result as unknown as Record<string, unknown>,
				};
			},
		}),
	);
}
