import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

export interface LabResponse {
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
}

interface StoredCookie {
	name: string;
	value: string;
	domain: string;
	hostOnly: boolean;
	path: string;
	secure: boolean;
}

function truthy(value: string | undefined): boolean {
	return ["1", "true", "yes", "y", "on"].includes(String(value ?? "").toLowerCase());
}

function attributes(tag: string): Record<string, string> {
	const result: Record<string, string> = {};
	const pattern = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
	for (const match of tag.matchAll(pattern)) {
		result[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
	}
	return result;
}

interface HtmlForm {
	action: string;
	method: string;
	inputs: Record<string, string>[];
}

function parseForms(page: string): HtmlForm[] {
	return [...page.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map((match) => {
		const form = attributes(match[1]);
		const inputs = [...match[2].matchAll(/<input\b([^>]*)>/gi)]
			.map((input) => attributes(input[1]));
		return { action: form.action ?? "", method: (form.method ?? "get").toLowerCase(), inputs };
	});
}

export class LabClient {
	readonly baseUrl: string;
	readonly loginUrl: string;
	private readonly cookies = new Map<string, StoredCookie>();
	private readonly httpsAgent?: HttpsAgent;

	constructor(options: { insecure?: boolean; baseUrl?: string; loginUrl?: string } = {}) {
		this.baseUrl = options.baseUrl ?? process.env.LAB_BASE_URL ??
			"https://lab-test.smartlab.mlsec.tu-berlin.de/";
		this.loginUrl = options.loginUrl ?? process.env.LAB_LOGIN_URL ??
			new URL("/accounts/login/", this.baseUrl).toString();
		const caBundle = process.env.LAB_CA_BUNDLE;
		if (caBundle) this.httpsAgent = new HttpsAgent({ ca: readFileSync(caBundle) });
		else if (options.insecure || truthy(process.env.LAB_INSECURE_TLS)) {
			this.httpsAgent = new HttpsAgent({ rejectUnauthorized: false });
		}
	}

	private storeCookies(header: string | string[] | undefined, requestUrl: URL): void {
		if (!header) return;
		for (const value of Array.isArray(header) ? header : [header]) {
			const parts = value.split(";").map((part) => part.trim());
			const pair = parts.shift() ?? "";
			const separator = pair.indexOf("=");
			if (separator <= 0) continue;
			const name = pair.slice(0, separator).trim();
			const cookieValue = pair.slice(separator + 1).trim();
			const attributes = new Map<string, string>();
			for (const part of parts) {
				const split = part.indexOf("=");
				attributes.set(
					(split === -1 ? part : part.slice(0, split)).toLowerCase(),
					split === -1 ? "" : part.slice(split + 1),
				);
			}
			const explicitDomain = attributes.get("domain")?.toLowerCase().replace(/^\./, "");
			const domain = explicitDomain || requestUrl.hostname.toLowerCase();
			const requestHostname = requestUrl.hostname.toLowerCase();
			if (explicitDomain && requestHostname !== domain && !requestHostname.endsWith(`.${domain}`)) continue;
			const defaultPath = requestUrl.pathname.includes("/")
				? requestUrl.pathname.slice(0, requestUrl.pathname.lastIndexOf("/") + 1) || "/"
				: "/";
			const path = attributes.get("path") || defaultPath;
			const key = `${domain}\0${path}\0${name}`;
			const maxAge = attributes.get("max-age");
			const expires = attributes.get("expires");
			if (cookieValue === "" || maxAge === "0" || (expires && Date.parse(expires) <= Date.now())) {
				this.cookies.delete(key);
				continue;
			}
			this.cookies.set(key, {
				name,
				value: cookieValue,
				domain,
				hostOnly: !explicitDomain,
				path,
				secure: attributes.has("secure"),
			});
		}
	}

	private cookieHeader(url: URL): string {
		const hostname = url.hostname.toLowerCase();
		return [...this.cookies.values()]
			.filter((cookie) => {
				const domainMatches = cookie.hostOnly
					? hostname === cookie.domain
					: hostname === cookie.domain || hostname.endsWith(`.${cookie.domain}`);
				const pathMatches = url.pathname === cookie.path || url.pathname.startsWith(
					cookie.path.endsWith("/") ? cookie.path : `${cookie.path}/`,
				);
				return domainMatches && pathMatches && (!cookie.secure || url.protocol === "https:");
			})
			.map((cookie) => `${cookie.name}=${cookie.value}`)
			.join("; ");
	}

	private rawRequest(url: string, options: RequestOptions): Promise<LabResponse> {
		const parsed = new URL(url);
		const isHttps = parsed.protocol === "https:";
		const requester = isHttps ? httpsRequest : httpRequest;
		const headers: Record<string, string> = {
			"User-Agent": "Mozilla/5.0 smartlab-auto-agent/0.1",
			Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			"Accept-Language": "en-US,en;q=0.9",
			...(options.headers ?? {}),
		};
		const cookie = this.cookieHeader(parsed);
		if (cookie) headers.Cookie = cookie;
		if (options.body) headers["Content-Length"] = String(options.body.length);

		return new Promise((resolvePromise, rejectPromise) => {
			const request = requester({
				protocol: parsed.protocol,
				hostname: parsed.hostname,
				port: parsed.port || (isHttps ? 443 : 80),
				path: parsed.pathname + parsed.search,
				method: options.method ?? "GET",
				headers,
				...(isHttps && this.httpsAgent ? { agent: this.httpsAgent } : {}),
			}, (response) => {
				this.storeCookies(response.headers["set-cookie"], parsed);
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(chunk as Buffer));
				response.on("end", () => {
					const body = Buffer.concat(chunks);
					const contentType = String(response.headers["content-type"] ?? "").toLowerCase();
					const textual = /text|html|json|xml|javascript|x-www-form-urlencoded/.test(contentType);
					resolvePromise({
						url,
						status: response.statusCode ?? 0,
						headers: response.headers,
						body,
						text: textual ? body.toString("utf8") : "",
					});
				});
			});
			request.on("error", rejectPromise);
			request.setTimeout(120_000, () => request.destroy(new Error("request timed out")));
			if (options.body) request.write(options.body);
			request.end();
		});
	}

	async request(url: string, options: RequestOptions = {}): Promise<LabResponse> {
		let currentUrl = url;
		let method = options.method ?? "GET";
		let body = options.body;
		for (let redirects = 0; redirects < 10; redirects++) {
			const response = await this.rawRequest(currentUrl, { ...options, method, body });
			const location = response.headers.location as string | undefined;
			if (response.status < 300 || response.status >= 400 || !location) {
				return { ...response, url: currentUrl };
			}
			currentUrl = new URL(location, currentUrl).toString();
			if (response.status === 303 || (method === "POST" && [301, 302].includes(response.status))) {
				method = "GET";
				body = undefined;
			}
		}
		throw new Error(`Too many redirects starting from ${url}`);
	}

	private isLoginPage(page: string): boolean {
		return parseForms(page).some((form) =>
			form.inputs.some((input) => (input.type ?? "text").toLowerCase() === "password") &&
			form.inputs.some((input) => /user|login/i.test(input.name ?? "")),
		);
	}

	private isLabOrigin(url: string): boolean {
		return new URL(url).origin === new URL(this.baseUrl).origin;
	}

	async login(): Promise<void> {
		const username = process.env.LAB_USER;
		const password = process.env.LAB_PASS;
		if (!username || !password) throw new Error("LAB_USER and LAB_PASS must be set");

		const loginPage = await this.request(this.loginUrl);
		if (loginPage.status >= 400) throw new Error(`Could not load login page: HTTP ${loginPage.status}`);
		const forms = parseForms(loginPage.text);
		const form = forms.find((candidate) =>
			candidate.inputs.some((input) => (input.type ?? "text").toLowerCase() === "password"),
		);
		if (!form) {
			if (!this.isLoginPage(loginPage.text) && this.isLabOrigin(loginPage.url)) return;
			throw new Error("Could not find a login form");
		}

		const data: Record<string, string> = {};
		let usernameField = "username";
		let passwordField = "password";
		for (const input of form.inputs) {
			if (!input.name) continue;
			const type = (input.type ?? "text").toLowerCase();
			if (["hidden", "submit"].includes(type)) data[input.name] = input.value ?? "";
			if (type === "password") passwordField = input.name;
			if (["text", "email"].includes(type) && /user|login/i.test(input.name)) usernameField = input.name;
		}
		data[usernameField] = username;
		data[passwordField] = password;
		const action = new URL(form.action || loginPage.url, loginPage.url).toString();
		const origin = new URL(loginPage.url).origin;
		const response = await this.request(action, {
			method: "POST",
			body: Buffer.from(new URLSearchParams(data).toString()),
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Referer: loginPage.url,
				Origin: origin,
			},
		});
		if (response.status >= 400) throw new Error(`Login POST failed: HTTP ${response.status}`);
		if (this.isLoginPage(response.text)) throw new Error("Login failed; check LAB_USER and LAB_PASS");
	}

	async get(pathOrUrl: string): Promise<LabResponse> {
		const url = new URL(pathOrUrl, this.baseUrl).toString();
		let response = await this.request(url);
		const loginPage = this.isLoginPage(response.text);
		const labAuthorizationFailure = [401, 403].includes(response.status) && this.isLabOrigin(response.url);
		if (loginPage || labAuthorizationFailure) {
			await this.login();
			response = await this.request(url);
		}
		if (this.isLoginPage(response.text)) throw new Error(`Authentication failed while fetching ${url}`);
		if (response.status >= 400) throw new Error(`Fetch failed: HTTP ${response.status} for ${url}`);
		return response;
	}
}
