/**
 * Submit session: directly calls the SmartLab HTTP submission logic
 * without spinning up a PI agent session. This avoids LLM latency for
 * what is purely a deterministic HTTP upload + poll operation.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { request as httpsRequest, Agent as HttpsAgent } from "node:https";
import { request as httpRequest } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { deflateRawSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = resolve(HERE, "..");
const PROJECT_ROOT = resolve(AGENT_DIR, "..");
const MEMORY_FILE = join(AGENT_DIR, "memory", "memory.json");

export interface SubmitResult {
	ok: boolean;
	score: number | null;
	triesLeft: number | null;
	error?: string;
}

// ---------------------------------------------------------------------------
// Minimal HTTP client (cookie-aware, redirect-following)
// ---------------------------------------------------------------------------

interface HttpResp { url: string; status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; text: string; }

function truthy(v: string | undefined) { return ["1","true","yes","y","on"].includes(String(v ?? "").toLowerCase()); }

class SimpleClient {
	private cookies = new Map<string, string>();
	private agent?: HttpsAgent;
	readonly baseUrl: string;
	readonly loginUrl: string;

	constructor(insecure: boolean) {
		this.baseUrl = process.env.LAB_BASE_URL ?? "https://lab-test.smartlab.mlsec.tu-berlin.de/";
		this.loginUrl = process.env.LAB_LOGIN_URL ?? this.baseUrl;
		if (insecure) this.agent = new HttpsAgent({ rejectUnauthorized: false });
	}

	private cookieHeader() { return Array.from(this.cookies.entries()).map(([k,v])=>`${k}=${v}`).join("; "); }
	private storeCookies(sc: string | string[] | undefined) {
		if (!sc) return;
		for (const raw of (Array.isArray(sc) ? sc : [sc])) {
			const pair = raw.split(";",1)[0]; const eq = pair.indexOf("=");
			if (eq>0) this.cookies.set(pair.slice(0,eq).trim(), pair.slice(eq+1).trim());
		}
	}
	cookie(n: string) { return this.cookies.get(n); }

	rawReq(url: string, opts: { method?: string; headers?: Record<string,string>; body?: Buffer }): Promise<HttpResp> {
		const parsed = new URL(url);
		const isHttps = parsed.protocol === "https:";
		const req_fn = isHttps ? httpsRequest : httpRequest;
		const headers: Record<string,string> = { "User-Agent": "smartlab-auto-agent/0.1", Accept: "text/html,application/xhtml+xml,*/*;q=0.8", ...opts.headers ?? {} };
		const ch = this.cookieHeader(); if (ch) headers.Cookie = ch;
		if (opts.body) headers["Content-Length"] = String(opts.body.length);
		return new Promise((res, rej) => {
			const req = req_fn({ protocol: parsed.protocol, hostname: parsed.hostname, port: parsed.port||(isHttps?443:80), path: parsed.pathname+parsed.search, method: opts.method??"GET", headers, ...(isHttps&&this.agent?{agent:this.agent}:{}) }, (r) => {
				this.storeCookies(r.headers["set-cookie"]);
				const chunks: Buffer[] = [];
				r.on("data", (c) => chunks.push(c as Buffer));
				r.on("end", () => { const body=Buffer.concat(chunks); res({url, status:r.statusCode??0, headers:r.headers, body, text:body.toString("utf8")}); });
			});
			req.on("error", rej);
			req.setTimeout(180_000, ()=>req.destroy(new Error("timeout")));
			if (opts.body) req.write(opts.body);
			req.end();
		});
	}

	async request(url: string, opts: { method?: string; headers?: Record<string,string>; body?: Buffer } = {}): Promise<HttpResp> {
		let cur = url, method = opts.method??"GET", body = opts.body;
		for (let i=0; i<10; i++) {
			const res = await this.rawReq(cur, {...opts, method, body});
			const loc = res.headers.location as string|undefined;
			if (res.status>=300 && res.status<400 && loc) {
				cur = new URL(loc, cur).toString();
				if (res.status===303 || (method==="POST"&&(res.status===301||res.status===302))) { method="GET"; body=undefined; }
				continue;
			}
			return {...res, url: cur};
		}
		throw new Error("Too many redirects: "+url);
	}

	isLoginPage(html: string) {
		const forms = parseForms(html);
		return forms.some(f => f.inputs.some(i=>(i.type??"text").toLowerCase()==="password") && f.inputs.some(i=>/user|login/i.test(i.name??"")));
	}
	csrfFromHtmlOrCookie(html: string) {
		for (const f of parseForms(html)) for (const i of f.inputs) if (i.name==="csrfmiddlewaretoken"&&i.value) return i.value;
		return this.cookie("csrftoken");
	}

	async login() {
		const username = process.env.LAB_USER, password = process.env.LAB_PASS;
		if (!username||!password) throw new Error("Set LAB_USER and LAB_PASS");
		const lp = await this.request(this.loginUrl);
		if (lp.status>=400) throw new Error("Login page failed: HTTP "+lp.status);
		const forms = parseForms(lp.text);
		const form = forms.find(f=>f.inputs.some(i=>(i.type??"text").toLowerCase()==="password"))??forms[0];
		if (!form) throw new Error("No login form found");
		const action = new URL(form.action||lp.url, lp.url).toString();
		const data: Record<string,string> = {}; let pf="password", uf="username";
		for (const i of form.inputs) {
			if (!i.name) continue;
			const t=(i.type??"text").toLowerCase();
			if (t==="hidden"||t==="submit") data[i.name]=i.value??"";
			if (t==="password") pf=i.name;
			if ((t==="text"||t==="email")&&(/user|login/i.test(i.name)||uf==="username")) uf=i.name;
		}
		if (!("csrfmiddlewaretoken" in data)) { const tok=this.csrfFromHtmlOrCookie(lp.text); if (tok) data.csrfmiddlewaretoken=tok; }
		data[uf]=username; data[pf]=password;
		const result = await this.request(action, { method:"POST", body:Buffer.from(new URLSearchParams(data).toString(),"utf8"), headers:{"Content-Type":"application/x-www-form-urlencoded", Referer:lp.url, Origin:new URL(lp.url).origin} });
		if (result.status>=400) throw new Error("Login POST failed: HTTP "+result.status);
		if (this.isLoginPage(result.text)) throw new Error("Login failed (check LAB_USER/LAB_PASS)");
	}

	async get(pathOrUrl: string): Promise<HttpResp> {
		const url = new URL(pathOrUrl, this.baseUrl).toString();
		let res = await this.request(url);
		if (res.status===401||res.status===403||this.isLoginPage(res.text)) { await this.login(); res=await this.request(url); }
		if (res.status>=400) throw new Error("Fetch failed: HTTP "+res.status+" for "+url);
		return res;
	}
}

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

interface FormInput { name?: string; type?: string; value?: string; }
interface ParsedForm { action: string; inputs: FormInput[]; }

function parseAttrs(tag: string) {
	const attrs: Record<string,string> = {};
	const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
	let m: RegExpExecArray|null;
	while ((m=re.exec(tag))) attrs[m[1].toLowerCase()]=m[3]??m[4]??m[5]??"";
	return attrs;
}
function parseForms(html: string): ParsedForm[] {
	const forms: ParsedForm[] = [];
	const fr = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi; let fm: RegExpExecArray|null;
	while ((fm=fr.exec(html))) {
		const a=parseAttrs(fm[1]); const inputs: FormInput[] = [];
		const ir = /<input\b([^>]*?)\/?>/gi; let im: RegExpExecArray|null;
		while ((im=ir.exec(fm[2]))) { const ia=parseAttrs(im[1]); inputs.push({name:ia.name,type:ia.type,value:ia.value}); }
		forms.push({action:a.action??"", inputs});
	}
	return forms;
}
function decodeEntities(s: string) {
	return s.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g," ").replace(/&#(\d+);/g,(_,d)=>String.fromCharCode(Number(d)));
}
function cleanHtml(f: string) {
	return decodeEntities(f.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim());
}
function parseScore(v: string|undefined): number|null {
	if (!v) return null; const c=cleanHtml(v); if (["---","-",""].includes(c)) return null;
	const m=c.match(/[-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/); if (!m) return null;
	const n=Number(m[0]); return Number.isFinite(n)?n:null;
}
function parseTriesUsed(v: string|null): number|null {
	if (!v) return null; const m=v.match(/(\d+)\s+of\s+\d+\s+attempts\s+used/i); return m?Number(m[1]):null;
}
interface Attempt { number: string; date: string; comment: string; result: string; info: string; }
interface TaskInfo { title: string; taskUrl: string; uploadUrl: string|null; csrfToken: string|null; attemptsUsed: string|null; attempts: Attempt[]; }

function parseTaskPage(taskUrl: string, page: string, baseUrl: string): TaskInfo {
	const tm=page.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
	const title=tm?cleanHtml(tm[1]):taskUrl;
	let uploadUrl: string|null=null, csrfToken: string|null=null;
	const fm=page.match(/<form[^>]+action="([^"]+\/upload\/)"[^>]*enctype="multipart\/form-data"[^>]*>([\s\S]*?)<\/form>/i);
	if (fm) {
		uploadUrl=new URL(decodeEntities(fm[1]),baseUrl).toString();
		const cm=fm[2].match(/<input[^>]+name="csrfmiddlewaretoken"[^>]+value="([^"]+)"/i);
		if (cm) csrfToken=decodeEntities(cm[1]);
	}
	const um=page.match(/(\d+\s+of\s+\d+\s+attempts\s+used)/i);
	const attempts: Attempt[] = [];
	const rr=/<tr>([\s\S]*?)<\/tr>/gi; let rm: RegExpExecArray|null;
	while ((rm=rr.exec(page))) {
		const cells=Array.from(rm[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)).map(c=>c[1]);
		if (cells.length>=5&&!cleanHtml(rm[1]).toLowerCase().includes("currently no valid attempts"))
			attempts.push({number:cleanHtml(cells[0]),date:cleanHtml(cells[1]),comment:cleanHtml(cells[2]),result:cleanHtml(cells[3]),info:cleanHtml(cells[4])});
	}
	return {title, taskUrl, uploadUrl, csrfToken, attemptsUsed: um?um[1]:null, attempts};
}

// ---------------------------------------------------------------------------
// Source zip builder
// ---------------------------------------------------------------------------

const EXCLUDED_DIRS = new Set([".git","__pycache__",".pytest_cache","env","venv",".venv","data","downloaded_task_page","submissions","reports","node_modules"]);
const EXCLUDED_NAMES = new Set(["lab-cookies.txt","source.zip","output.csv"]);
const ALLOWED_SUFFIXES = new Set([".py",".sh",".ts",".md",".txt",".toml",".yaml",".yml",".json"]);
const CRC_TABLE = (() => { const t=new Uint32Array(256); for (let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;t[n]=c>>>0;} return t; })();
function crc32(buf: Buffer) { let c=0xffffffff; for(let i=0;i<buf.length;i++)c=CRC_TABLE[(c^buf[i])&0xff]^(c>>>8); return (c^0xffffffff)>>>0; }
function collectFiles(root: string): {rel:string;abs:string}[] {
	const out: {rel:string;abs:string}[] = [];
	const walk=(dir:string,parts:string[])=>{
		for (const e of readdirSync(dir).sort()) {
			const abs=join(dir,e), rel=[...parts,e], st=statSync(abs);
			if (st.isDirectory()){if(!EXCLUDED_DIRS.has(e))walk(abs,rel);continue;}
			if (EXCLUDED_NAMES.has(e)||e.startsWith("._"))continue;
			const dot=e.lastIndexOf("."); const suf=dot>=0?e.slice(dot).toLowerCase():"";
			if (!ALLOWED_SUFFIXES.has(suf))continue;
			out.push({rel:rel.join("/"),abs});
		}
	};
	walk(root,[]);
	return out.sort((a,b)=>a.rel<b.rel?-1:a.rel>b.rel?1:0);
}
function buildZip(root: string): Buffer {
	const files=collectFiles(root); const local: Buffer[]=[], central: Buffer[]=[]; let offset=0;
	for (const {rel,abs} of files) {
		const content=readFileSync(abs); const crc=crc32(content); const compressed=deflateRawSync(content); const name=Buffer.from(`source/${rel}`,"utf8");
		const lh=Buffer.alloc(30); lh.writeUInt32LE(0x04034b50,0);lh.writeUInt16LE(20,4);lh.writeUInt16LE(0,6);lh.writeUInt16LE(8,8);lh.writeUInt16LE(0,10);lh.writeUInt16LE(0x21,12);lh.writeUInt32LE(crc,14);lh.writeUInt32LE(compressed.length,18);lh.writeUInt32LE(content.length,22);lh.writeUInt16LE(name.length,26);lh.writeUInt16LE(0,28);
		local.push(lh,name,compressed);
		const ch=Buffer.alloc(46);ch.writeUInt32LE(0x02014b50,0);ch.writeUInt16LE(20,4);ch.writeUInt16LE(20,6);ch.writeUInt16LE(0,8);ch.writeUInt16LE(8,10);ch.writeUInt16LE(0,12);ch.writeUInt16LE(0x21,14);ch.writeUInt32LE(crc,16);ch.writeUInt32LE(compressed.length,20);ch.writeUInt32LE(content.length,24);ch.writeUInt16LE(name.length,28);ch.writeUInt16LE(0,30);ch.writeUInt16LE(0,32);ch.writeUInt16LE(0,34);ch.writeUInt16LE(0,36);ch.writeUInt32LE(0,38);ch.writeUInt32LE(offset,42);
		central.push(ch,name);
		offset+=lh.length+name.length+compressed.length;
	}
	const lb=Buffer.concat(local), cb=Buffer.concat(central), end=Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(0,4);end.writeUInt16LE(0,6);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(cb.length,12);end.writeUInt32LE(lb.length,16);end.writeUInt16LE(0,20);
	return Buffer.concat([lb,cb,end]);
}

// ---------------------------------------------------------------------------
// Multipart builder
// ---------------------------------------------------------------------------

function buildMultipart(fields: Record<string,string>, files: {field:string;filename:string;ct:string;data:Buffer}[]): {body:Buffer;boundary:string} {
	const boundary=`----smartlab${createHash("sha1").update(String(Date.now())).digest("hex").slice(0,24)}`;
	const parts: Buffer[]=[];
	const p=(s:string)=>parts.push(Buffer.from(s,"utf8"));
	for (const [n,v] of Object.entries(fields)){p(`--${boundary}\r\n`);p(`Content-Disposition: form-data; name="${n}"\r\n\r\n`);p(`${v}\r\n`);}
	for (const f of files){p(`--${boundary}\r\n`);p(`Content-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\n`);p(`Content-Type: ${f.ct}\r\n\r\n`);parts.push(f.data);p("\r\n");}
	p(`--${boundary}--\r\n`);
	return {body:Buffer.concat(parts),boundary};
}

const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));

// ---------------------------------------------------------------------------
// Memory update
// ---------------------------------------------------------------------------

function updateMemory(taskId: string, triesUsed: number|null, score: number|null) {
	let store: Record<string,unknown> = { tasks:{}, sessions:[], global_notes:"" };
	try { if (existsSync(MEMORY_FILE)) store = JSON.parse(readFileSync(MEMORY_FILE,"utf8")); } catch {}
	const tasks = (store.tasks ?? {}) as Record<string,Record<string,unknown>>;
	const task = tasks[taskId] ?? {};
	const MAX = 3;
	const newTriesUsed = triesUsed ?? ((Number(task.tries_used??0))+1);
	tasks[taskId] = { ...task, tries_used: newTriesUsed, tries_left: MAX-newTriesUsed, ...(score!==null&&(task.best_score===null||task.best_score===undefined||Number(task.best_score)<score)?{best_score:score}:{}) };
	store.tasks = tasks;
	const tmp = MEMORY_FILE+".tmp";
	writeFileSync(tmp, JSON.stringify(store,null,2),"utf8");
	renameSync(tmp, MEMORY_FILE);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runSubmitSession(taskId: string, csvPath: string): Promise<SubmitResult> {
	const insecure = truthy(process.env.LAB_INSECURE_TLS);
	const taskUrl = process.env.SMARTLAB_TASK_URL;
	if (!taskUrl) { console.error("[submit] SMARTLAB_TASK_URL not set"); return {ok:false,score:null,triesLeft:null,error:"SMARTLAB_TASK_URL not set"}; }

	const abscsv = isAbsolute(csvPath) ? csvPath : resolve(PROJECT_ROOT, csvPath);
	if (!existsSync(abscsv)) { console.error(`[submit] CSV not found: ${abscsv}`); return {ok:false,score:null,triesLeft:null,error:`CSV not found: ${abscsv}`}; }

	console.log(`[submit] Submitting ${abscsv} to ${taskUrl}`);

	const client = new SimpleClient(insecure);

	// Fetch task page (login if needed)
	const taskRes = await client.get(taskUrl);
	const before = parseTaskPage(taskRes.url, taskRes.text, client.baseUrl);
	console.log(`[submit] Task: ${before.title}, attempts so far: ${before.attempts.length}`);

	if (!before.uploadUrl) return {ok:false,score:null,triesLeft:null,error:"No upload form found on task page"};
	if (!before.csrfToken) return {ok:false,score:null,triesLeft:null,error:"No CSRF token found"};

	const csvData = readFileSync(abscsv);
	const zipData = buildZip(PROJECT_ROOT);
	console.log(`[submit] CSV: ${csvData.length} bytes, source.zip: ${zipData.length} bytes`);

	const {body, boundary} = buildMultipart(
		{csrfmiddlewaretoken: before.csrfToken, comment: "auto-agent submission"},
		[
			{field:"file[0]", filename:"output.csv", ct:"text/csv", data:csvData},
			{field:"file[1]", filename:"source.zip", ct:"application/zip", data:zipData},
		]
	);

	console.log(`[submit] Uploading to ${before.uploadUrl} ...`);
	const uploadRes = await client.request(before.uploadUrl, {
		method:"POST", body,
		headers:{
			"Content-Type":`multipart/form-data; boundary=${boundary}`,
			Accept:"application/json,text/html,*/*;q=0.8",
			Referer: before.taskUrl,
			"X-Requested-With":"XMLHttpRequest",
			"X-CSRFToken": before.csrfToken,
		}
	});
	const uploadMsg = cleanHtml(uploadRes.text);
	console.log(`[submit] Upload response: HTTP ${uploadRes.status} — ${uploadMsg.slice(0,200)}`);

	const uploadOk = uploadRes.status >= 200 && uploadRes.status < 300 && (
		uploadMsg.toLowerCase().includes("successfully") ||
		uploadMsg.toLowerCase().includes('"success"') ||
		(!uploadMsg.toLowerCase().includes("error") && !uploadMsg.toLowerCase().includes("invalid") && !uploadMsg.toLowerCase().includes("fail"))
	);

	if (!uploadOk) {
		updateMemory(taskId, null, null);
		return {ok:false, score:null, triesLeft:null, error:`Upload failed HTTP ${uploadRes.status}: ${uploadMsg}`};
	}

	// Poll for the result row
	console.log("[submit] Upload ok, polling for result...");
	const pollTimeout = Date.now() + 180_000;
	let after = before;
	while (Date.now() < pollTimeout) {
		await sleep(10_000);
		const r = await client.get(taskUrl);
		after = parseTaskPage(r.url, r.text, client.baseUrl);
		const hasNew = after.attempts.length > before.attempts.length;
		console.log(`[submit] Poll: ${after.attempts.length} attempts (was ${before.attempts.length})`);
		if (hasNew && after.attempts[0]?.result) break;
	}

	const beforeKeys = new Set(before.attempts.map(a=>JSON.stringify(a)));
	const newAttempt = after.attempts.find(a=>!beforeKeys.has(JSON.stringify(a)));
	if (!newAttempt) {
		updateMemory(taskId, null, null);
		return {ok:false, score:null, triesLeft:null, error:"Upload succeeded but no result row appeared"};
	}

	const score = parseScore(newAttempt.result);
	const triesUsed = parseTriesUsed(after.attemptsUsed);
	const triesLeft = triesUsed !== null ? 3 - triesUsed : null;
	console.log(`[submit] Result: score=${score}, tries_used=${triesUsed}, tries_left=${triesLeft}`);

	updateMemory(taskId, triesUsed, score);
	return {ok: score!==null, score, triesLeft};
}
