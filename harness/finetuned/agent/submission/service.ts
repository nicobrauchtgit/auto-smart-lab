import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicJson, claimWorkspace } from "../experiments/ownership.js";
import { sanitizeTrainingEnvironment } from "../training/environment.js";
import { digest } from "../training/terminal.js";
import { SubmissionClient } from "./transport.js";
import { validatePolicy, type OfficialStatus, type SubmissionResult, type SubmitRefitOptions, type SubmissionState } from "./types.js";
export { readOfficialStatus } from "./transport.js";
export type * from "./types.js";
/** Task-global accounting for new runs and resumes; never builds or uploads a bundle. */
export async function readSubmissionAccounting(options:import("./types.js").ReadSubmissionAccountingOptions):Promise<import("./types.js").SubmissionAccounting> {
 const scope=digest({origin:new URL(options.transport.taskUrl).origin,taskUrl:new URL(options.transport.taskUrl).href,account:options.transport.username.trim().toLowerCase()});
 const root=join(options.accountingRoot,scope), path=join(root,"ledger.json");
 // Serialize against uploads even if this account has no ledger yet. This is
 // execution-time accounting, not the non-writing setup probe.
 const release=claimWorkspace(root);
 try {
  const status=await new SubmissionClient(options.transport).status(options.signal);
  const ledger:Ledger=existsSync(path)?loadLedger(path,scope,root):{version:1,scope,highWaterUsed:0,intents:[]};
  reconcile(ledger,status);
  if(existsSync(path))persist(path,ledger);
  const reservedUnknown=ledger.intents.filter(i=>!i.officialAttemptId).length;
  const result={officialStatus:status,reservedUnknown,effectiveTriesUsed:status.triesUsed+reservedUnknown,unresolved:reservedUnknown>0||ledger.intents.some(i=>i.state==="unknown"||i.state==="pending")||status.attempts.some(a=>a.state==="pending")};
  options.report?.event("submission_status",{tries_used:status.triesUsed,reserved_unknown:reservedUnknown,effective_tries_used:result.effectiveTriesUsed,unresolved:result.unresolved});
  return result;
 }finally{release();}
}
const hash = (p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
interface Intent { id:string; token:string; actionId:string; runId:string; bundleId:string; bundleDirectory:string; baseline:string[]; baselineUsed:number; state:Exclude<SubmissionState,"disabled">; officialAttemptId:string|null; officialScore:number|null; uploadStatus?:number; }
interface Ledger { version:1; scope:string; highWaterUsed:number; intents:Intent[] }
function persist(path:string, ledger:Ledger) {atomicJson(path,ledger);}
function loadLedger(path:string,scope:string,root:string):Ledger {
 const ledger:Ledger=JSON.parse(readFileSync(path,"utf8"));
 if(ledger.version!==1||ledger.scope!==scope||!Array.isArray(ledger.intents)||!Number.isInteger(ledger.highWaterUsed)||ledger.highWaterUsed<0||ledger.highWaterUsed>3)throw new Error("Invalid durable submission accounting; inspect without resetting");
 const keys=new Set<string>();const tokens=new Set<string>();
 for(const i of ledger.intents) {
  const key=JSON.stringify([i.runId,i.actionId]);
  if(typeof i.id!=="string"||i.token!==`smartlab-intent-${i.id}`||!i.runId||!i.actionId||keys.has(key)||tokens.has(i.token)||!/^[a-f0-9]{64}$/.test(i.bundleId)||i.bundleDirectory!==join(root,i.bundleId)||!Array.isArray(i.baseline)||i.baseline.some(v=>typeof v!=="string")||!Number.isInteger(i.baselineUsed)||i.baselineUsed<0||i.baselineUsed>3||!["unknown","pending","rejected","scored"].includes(i.state)||(i.officialAttemptId!==null&&!/^\d+$/.test(i.officialAttemptId))||(i.officialScore!==null&&(!Number.isFinite(i.officialScore)||i.officialScore<0||i.officialScore>1)))throw new Error("Invalid durable submission intent; inspect without resetting");
  keys.add(key);tokens.add(i.token);
 }return ledger;
}

function reconcile(ledger:Ledger, status:OfficialStatus) {
 if(status.triesUsed < ledger.highWaterUsed)throw new Error("Official attempt accounting moved backwards; reconciliation required");
 ledger.highWaterUsed=status.triesUsed;
 for(const intent of ledger.intents) {
  const matching=status.attempts.filter(a=>a.comment===intent.token && !intent.baseline.includes(a.id));
  if(matching.length>1)throw new Error("Ambiguous official attempt reconciliation; uploads blocked");
  const match=matching[0];
  if(intent.officialAttemptId && (!match || match.id!==intent.officialAttemptId))throw new Error("Official attempt identity changed; uploads blocked");
  if(match){intent.officialAttemptId=match.id;intent.state=match.state;intent.officialScore=match.score;}
 }
}
function remaining(ledger:Ledger,status:OfficialStatus,max:number) {return Math.max(0,Math.min(status.triesRemaining,max-Math.max(ledger.highWaterUsed,status.triesUsed))-ledger.intents.filter(i=>!i.officialAttemptId).length);}
function receipt(intent:Intent, ledger:Ledger,status:OfficialStatus,max:number,newAttempt:boolean):SubmissionResult {
 const manifestPath=join(intent.bundleDirectory,"bundle.json");const manifest=JSON.parse(readFileSync(manifestPath,"utf8"));
 if(digest(manifest)!==intent.bundleId||["output.csv","source.zip"].some(n=>hash(join(intent.bundleDirectory,n))!==manifest.artifacts[n]))throw new Error("Durable submission bundle was changed; receipt validation blocked");
 const path=join(intent.bundleDirectory,`${intent.id}.receipt.json`);
 const result:SubmissionResult={version:1,state:intent.state,officialScore:intent.officialScore,triesUsed:status.triesUsed,triesRemaining:remaining(ledger,status,max),reservedUnknown:ledger.intents.filter(i=>!i.officialAttemptId).length,effectiveTriesUsed:status.triesUsed+ledger.intents.filter(i=>!i.officialAttemptId).length,newAttempt,attemptId:intent.officialAttemptId,bundleId:intent.bundleId,artifacts:[]};
 atomicJson(path,{...result,intentId:intent.id,policyRunId:intent.runId});
 result.artifacts=[{kind:"submission_receipt",path,sha256:hash(path)},{kind:"submission_bundle",path:join(intent.bundleDirectory,"bundle.json"),sha256:hash(join(intent.bundleDirectory,"bundle.json"))}];return result;
}
export function buildFrozenBundle(options:SubmitRefitOptions, root:string) {
 const temporary=join(root,`.bundle-${randomUUID()}`);mkdirSync(temporary,{recursive:true});
 try {
  const built=spawnSync(options.pythonExecutable,[join(import.meta.dir,"bundle.py")],{input:JSON.stringify({taskId:options.taskId,refitArtifact:options.refitArtifact,projectRoot:options.projectRoot,taskPromptPath:options.taskPromptPath,environmentFingerprint:options.environmentFingerprint,outputDirectory:temporary,...(options.predictions?{predictions:options.predictions}:{})}),env:sanitizeTrainingEnvironment(options.env??process.env),encoding:"utf8",timeout:90000,maxBuffer:2*1024*1024});
  if(built.error||built.status!==0)throw new Error("Frozen submission bundle validation failed; restore exact source, task, dependencies and refit evidence");
  const manifest=JSON.parse(built.stdout);const bundleId=digest(manifest);const directory=join(root,bundleId);
  for(const name of ["output.csv","source.zip"]) {if(hash(join(temporary,name))!==manifest.artifacts[name])throw new Error("Submission bundle checksum mismatch");const fd=openSync(join(temporary,name),"r");try{fsyncSync(fd);}finally{closeSync(fd);}}
  atomicJson(join(temporary,"bundle.json"),manifest);
  if(existsSync(directory)) {
   if(hash(join(directory,"bundle.json"))!==hash(join(temporary,"bundle.json"))||["output.csv","source.zip"].some(n=>hash(join(directory,n))!==manifest.artifacts[n]))throw new Error("Durable submission bundle was changed");
  }else {renameSync(temporary,directory);const fd=openSync(root,"r");try{fsyncSync(fd);}finally{closeSync(fd);}}
  return {bundleId,directory};
 } finally {rmSync(temporary,{recursive:true,force:true});}
}
export async function submitRefit(options:SubmitRefitOptions):Promise<SubmissionResult> {
 const policy=validatePolicy(options.policy);
 options.report?.input({kind:"submission_policy",delivery:"none",status:"available",...policy});
 options.report?.input({kind:"terminal_refit_result",version:1,delivery:"none",status:"available",artifact:options.refitArtifact.path,content_sha256:options.refitArtifact.sha256});
 if(!policy.authorized)return {version:1,state:"disabled",officialScore:null,triesUsed:null,triesRemaining:null,reservedUnknown:0,effectiveTriesUsed:null,newAttempt:false,attemptId:null,bundleId:null,artifacts:[]};
 options.signal?.throwIfAborted();
 // Stable account identity survives password rotation, restarts and new runs. No secret is persisted.
 const scope=digest({origin:new URL(options.transport.taskUrl).origin,taskUrl:new URL(options.transport.taskUrl).href,account:options.transport.username.trim().toLowerCase()});
 const root=join(options.accountingRoot,scope);const release=claimWorkspace(root);
 try {
  const path=join(root,"ledger.json");
  const ledger:Ledger=existsSync(path)?loadLedger(path,scope,root):{version:1,scope,highWaterUsed:0,intents:[]};
  if(ledger.version!==1||ledger.scope!==scope||!Array.isArray(ledger.intents)||!Number.isInteger(ledger.highWaterUsed)||ledger.highWaterUsed<0||ledger.highWaterUsed>3)throw new Error("Invalid durable submission accounting; inspect without resetting");
  const client=new SubmissionClient(options.transport);let status=await client.status(options.signal);reconcile(ledger,status);persist(path,ledger);
  options.report?.event("submission_status",{tries_used:status.triesUsed,tries_remaining:remaining(ledger,status,policy.maxSubmissions),attempts:status.attempts.map(a=>({id:a.id,state:a.state,score:a.score}))});
  const existingAction=ledger.intents.find(i=>i.actionId===policy.controllerInvocationId && i.runId===policy.pipelineRunId);
  if(existingAction) {
   const built=buildFrozenBundle(options,root);
   if(built.bundleId!==existingAction.bundleId)throw new Error("Submission action ID reused for a different frozen bundle");
   return receipt(existingAction,ledger,status,policy.maxSubmissions,false);
  }
  if(status.attempts.some(a=>a.state==="pending")||ledger.intents.some(i=>i.state==="unknown"||i.state==="pending"))throw new Error("Pending or unknown submission requires read-only reconciliation before another upload");
  if(!status.uploadAvailable||remaining(ledger,status,policy.maxSubmissions)<1)throw new Error("Official submission budget exhausted or upload unavailable");
  const built=buildFrozenBundle(options,root);
  const duplicate=ledger.intents.find(i=>i.bundleId===built.bundleId);
  if(duplicate)return receipt(duplicate,ledger,status,policy.maxSubmissions,false);
  // Re-read after expensive local validation: external submissions may have changed the official budget.
  status=await client.status(options.signal);reconcile(ledger,status);persist(path,ledger);
  if(status.attempts.some(a=>a.state==="pending")||!status.uploadAvailable||remaining(ledger,status,policy.maxSubmissions)<1)throw new Error("Official submission budget changed or a pending external attempt blocks upload");
  const id=randomUUID();const intent:Intent={id,token:`smartlab-intent-${id}`,actionId:policy.controllerInvocationId,runId:policy.pipelineRunId,bundleId:built.bundleId,bundleDirectory:built.directory,baseline:status.attempts.map(a=>a.id),baselineUsed:status.triesUsed,state:"unknown",officialAttemptId:null,officialScore:null};
  options.signal?.throwIfAborted();
  // Durable reservation BEFORE the one and only POST. Crash at any later point remains unknown.
  ledger.intents.push(intent);persist(path,ledger);atomicJson(join(built.directory,`${id}.intent.json`),intent);
  options.report?.event("submission_intent_reserved",{intent_id:id,bundle_id:built.bundleId,policy_run_id:policy.pipelineRunId,controller_invocation_id:policy.controllerInvocationId});
  try {
   const manifest=JSON.parse(readFileSync(join(built.directory,"bundle.json"),"utf8"));
   const csv=readFileSync(join(built.directory,"output.csv")),source=readFileSync(join(built.directory,"source.zip"));
   if(digest(manifest)!==built.bundleId||createHash("sha256").update(csv).digest("hex")!==manifest.artifacts["output.csv"]||createHash("sha256").update(source).digest("hex")!==manifest.artifacts["source.zip"])throw new Error("Bundle changed before upload");
   intent.uploadStatus=await client.upload(status,intent.token,csv,source,options.signal);persist(path,ledger);
  } catch {persist(path,ledger);}
  const deadline=Date.now()+(options.pollTimeoutMs??30000);
  do {
   if(options.signal?.aborted)break;
   try {status=await client.status(options.signal);reconcile(ledger,status);persist(path,ledger);}catch{break;}
   if(intent.state==="scored"||intent.state==="rejected"||Date.now()>=deadline)break;
   await Bun.sleep(Math.min(options.pollIntervalMs??1000,Math.max(0,deadline-Date.now())));
  }while(Date.now()<deadline);
  const result=receipt(intent,ledger,status,policy.maxSubmissions,true);
  options.report?.event("submission_reconciled",{intent_id:id,state:result.state,official_score:result.officialScore,tries_used:result.triesUsed,tries_remaining:result.triesRemaining,new_attempt:true});return result;
 }finally{release();}
}
/** Restart recovery: status/authentication only, durable receipt writes, no bundle building or upload POST. */
export async function reconcileSubmission(options:import("./types.js").ReconcileSubmissionOptions):Promise<SubmissionResult | null> {
 const policy=validatePolicy(options.policy);
 options.report?.input({kind:"submission_policy",delivery:"none",status:"available",...policy,recovery:true});
 if(!policy.authorized)return {version:1,state:"disabled",officialScore:null,triesUsed:null,triesRemaining:null,reservedUnknown:0,effectiveTriesUsed:null,newAttempt:false,attemptId:null,bundleId:null,artifacts:[]};
 const scope=digest({origin:new URL(options.transport.taskUrl).origin,taskUrl:new URL(options.transport.taskUrl).href,account:options.transport.username.trim().toLowerCase()});
 const root=join(options.accountingRoot,scope);
 if(!existsSync(join(root,"ledger.json")))return null;
 const release=claimWorkspace(root);
 try {
  const path=join(root,"ledger.json");const ledger=loadLedger(path,scope,root);
  const status=await new SubmissionClient(options.transport).status(options.signal);
  reconcile(ledger,status);persist(path,ledger);
  const intent=ledger.intents.find(i=>i.runId===policy.pipelineRunId&&i.actionId===policy.controllerInvocationId);
  if(!intent)return null;
  const manifest=JSON.parse(readFileSync(join(intent.bundleDirectory,"bundle.json"),"utf8"));
  if(manifest.taskId!==options.taskId)throw new Error("Submission recovery task identity disagrees with durable bundle");
  const result=receipt(intent,ledger,status,policy.maxSubmissions,false);
  options.report?.event("submission_reconciled",{intent_id:intent.id,state:result.state,official_score:result.officialScore,tries_used:result.triesUsed,reserved_unknown:result.reservedUnknown,new_attempt:false});return result;
 }finally{release();}
}
export function validateFrozenRefit(options:Pick<SubmitRefitOptions,"taskId"|"refitArtifact"|"projectRoot"|"pythonExecutable"|"taskPromptPath"|"environmentFingerprint"|"env"|"predictions">):void {
 const checked=spawnSync(options.pythonExecutable,[join(import.meta.dir,"bundle.py")],{input:JSON.stringify({...options,validateOnly:true}),env:sanitizeTrainingEnvironment(options.env??process.env),encoding:"utf8",timeout:90000,maxBuffer:1024*1024});
 if(checked.error||checked.status!==0)throw new Error("Frozen submission candidate unavailable or invalid");
}
