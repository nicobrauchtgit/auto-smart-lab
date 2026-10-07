/** Bounded same-origin transport. POST is never redirected or retried. */
import { request as http } from "node:http";
import { request as https } from "node:https";
import type { OfficialAttempt, OfficialStatus, TransportConfig } from "./types.js";
const fail = () => new Error("Submission service access or response validation failed");
export const clean = (s: string) => s.replace(/<[^>]*>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g," ").trim();
export function attrs(s: string): Record<string,string> { return Object.fromEntries([...s.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(m=>[m[1].toLowerCase(),m[2]??m[3]??m[4]])); }
export function forms(page: string) { return [...page.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)].map(m=>({ attributes: attrs(m[1]), inputs: [...m[2].matchAll(/<input\b([^>]*)>/gi)].map(i=>attrs(i[1])) })); }
export function parseTaskPage(taskUrl: string, page: string): OfficialStatus & { uploadUrl: string | null; csrf: string | null } {
 const counts = [...page.matchAll(/(\d+)\s+of\s+(\d+)\s+attempts\s+used/gi)];
 if (counts.length !== 1) throw fail();
 const used = Number(counts[0][1]), max = Number(counts[0][2]);
 if (max !== 3 || used > max) throw fail();
 const attempts: OfficialAttempt[] = [];
 // Only parse the explicitly headed Attempts table, never unrelated rows.
 const tables = [...page.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].filter(m => {
  const headers = [...m[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(h=>clean(h[1]).toLowerCase());
  return (headers.length === 5 || headers.length === 7 && headers.slice(5).every(h=>!h)) && /^(#|number|attempt|no\.?)$/.test(headers[0]) && /^(submission )?date$/.test(headers[1]) && headers[2] === "comment" && headers[3] === "result" && headers[4] === "info";
 });
 if (tables.length !== 1) throw fail();
 for (const row of tables[0][1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
  const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(c=>clean(c[1]));
  if (!cells.length || (cells.length === 1 && /currently no valid attempts/i.test(cells[0]))) continue;
  if (![5,7].includes(cells.length) || !/^\d+$/.test(cells[0])) throw fail();
  const value = cells[3];
  const numeric = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value);
  const score = numeric ? Number(value) : null;
  if (score !== null && (!Number.isFinite(score) || score < 0 || score > 1)) throw fail();
  const rejected = /^(failure|failed|rejected|error)$/i.test(cells[4]);
  if (score === null && !rejected && !["", "-", "---", "pending"].includes(value.toLowerCase())) throw fail();
  attempts.push({ id: cells[0], comment: cells[2], state: rejected ? "rejected" : score === null ? "pending" : "scored", score: rejected ? null : score });
 }
 if (new Set(attempts.map(a=>a.id)).size !== attempts.length) throw fail();
 const upload = forms(page).filter(f=>f.attributes.enctype?.toLowerCase() === "multipart/form-data");
 if (upload.length > 1) throw fail();
 const uploadUrl = upload[0]?.attributes.action ? new URL(upload[0].attributes.action,taskUrl).href : null;
 if (uploadUrl && new URL(uploadUrl).origin !== new URL(taskUrl).origin) throw fail();
 const csrf = upload[0]?.inputs.find(i=>i.name === "csrfmiddlewaretoken")?.value ?? null;
 return { taskUrl, triesUsed: used, triesRemaining: max-used, attempts, uploadAvailable: !!uploadUrl && !!csrf && used < max, uploadUrl, csrf };
}
export class SubmissionClient {
 private cookies = new Map<string,string>();
 constructor(readonly config: TransportConfig) {
  const url = new URL(config.taskUrl);
  if (url.username || url.password || url.hash || !["https:","http:"].includes(url.protocol) || (url.protocol === "http:" && !["127.0.0.1","localhost","[::1]"].includes(url.hostname))) throw fail();
  if (!config.username?.trim() || !config.password) throw fail();
  if (config.cookie) for (const pair of config.cookie.split(";")) { const i=pair.indexOf("="); if(i>0) this.cookies.set(pair.slice(0,i).trim(),pair.slice(i+1).trim()); }
 }
 async request(url: string, method: "GET" | "POST", body?: Buffer, headers: Record<string,string> = {}, signal?: AbortSignal): Promise<{status:number;text:string;location?:string}> {
  if(new URL(url).origin !== new URL(this.config.taskUrl).origin) throw fail();
  try {
   return await new Promise((resolve,reject)=> {
    const parsed = new URL(url);
    const req = (parsed.protocol === "https:" ? https : http)(parsed, {method, signal: AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(this.config.timeoutMs ?? 10000)]), ...(this.config.ca ? {ca:this.config.ca}:{}), headers:{ ...headers, Cookie:[...this.cookies].map(([k,v])=>`${k}=${v}`).join("; "), ...(body?{"Content-Length":String(body.length)}:{})}},res=>{
     const chunks:Buffer[]=[]; let size=0;
     for(const cookie of res.headers["set-cookie"] ?? []) { const pair=cookie.split(";",1)[0]; const i=pair.indexOf("="); if(i>0)this.cookies.set(pair.slice(0,i),pair.slice(i+1)); }
     res.on("data",chunk=>{size+=chunk.length; if(size>1024*1024) req.destroy(fail()); else chunks.push(chunk);});
     res.on("error",err=>{clearTimeout(timer);reject(err);}); res.on("end",()=>{clearTimeout(timer);resolve({status:res.statusCode??0,text:Buffer.concat(chunks).toString("utf8"),location:res.headers.location});});
    });
    const timer=setTimeout(()=>{req.destroy();reject(fail());},this.config.timeoutMs??10000);
    req.on("error",err=>{clearTimeout(timer);reject(err);}); req.end(body);
   });
  } catch { throw fail(); }
 }
 async get(url: string, signal?: AbortSignal) {
  for(let n=0;n<5;n++) { const res=await this.request(url,"GET",undefined,{},signal); if(res.status>=300 && res.status<400 && res.location) {url=new URL(res.location,url).href;continue;} if(res.status!==200)throw fail();return res.text; } throw fail();
 }
 async status(signal?: AbortSignal, authenticate = true) {
  let page=await this.get(this.config.taskUrl,signal);
  const login=forms(page).find(f=>f.inputs.some(i=>i.type === "password"));
  if(login) {
   if(!authenticate)throw new Error("Read-only submission status requires an authenticated session cookie");
   const loginUrl=this.config.loginUrl ?? new URL(login.attributes.action||this.config.taskUrl,this.config.taskUrl).href;
   const data:Record<string,string>={};
   for(const i of login.inputs) if(i.name && i.type === "hidden")data[i.name]=i.value??"";
   const user=login.inputs.find(i=>/user|login/i.test(i.name??""));const pass=login.inputs.find(i=>i.type === "password");
   if(!user?.name||!pass?.name||!data.csrfmiddlewaretoken)throw fail();
   data[user.name]=this.config.username;data[pass.name]=this.config.password;
   const res=await this.request(loginUrl,"POST",Buffer.from(new URLSearchParams(data).toString()),{"Content-Type":"application/x-www-form-urlencoded",Referer:this.config.taskUrl,"X-CSRFToken":data.csrfmiddlewaretoken},signal);
   if(res.status<200||res.status>=400)throw fail();page=await this.get(this.config.taskUrl,signal);
  }
  return parseTaskPage(this.config.taskUrl,page);
 }
 async upload(status: Awaited<ReturnType<SubmissionClient["status"]>>, token: string, csv: Buffer, source: Buffer, signal?:AbortSignal) {
  if(!status.uploadAvailable||!status.uploadUrl||!status.csrf)throw fail();
  const boundary=`----smartlab-${token}`;const parts:Buffer[]=[];const add=(s:string)=>parts.push(Buffer.from(s));
  for(const [key,value] of Object.entries({csrfmiddlewaretoken:status.csrf,comment:token}))add(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
  for(const [field,name,type,data] of [["file[0]","output.csv","text/csv",csv],["file[1]","source.zip","application/zip",source]] as const) {add(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`);parts.push(data);add("\r\n");}
  add(`--${boundary}--\r\n`);
  const res=await this.request(status.uploadUrl,"POST",Buffer.concat(parts),{"Content-Type":`multipart/form-data; boundary=${boundary}`,"X-CSRFToken":status.csrf,Referer:this.config.taskUrl,"X-Requested-With":"XMLHttpRequest"},signal);
  // An HTTP response never establishes acceptance/consumption; only official attempts do.
  return res.status;
 }
}
export async function readOfficialStatus(config: TransportConfig, signal?: AbortSignal): Promise<OfficialStatus> {
 const {uploadUrl,csrf,...safe}=await new SubmissionClient(config).status(signal);return safe;
}
