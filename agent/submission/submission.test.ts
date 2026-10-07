import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFrozenBundle, readOfficialStatus, readSubmissionAccounting, reconcileSubmission, submitRefit } from "./service.js";
import { parseTaskPage } from "./transport.js";
import { validatePolicy, type SubmitRefitOptions, type OfficialAttempt } from "./types.js";
import { PROJECT_ROOT, PYTHON, trainingEnvironment } from "../training/testing.js";
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const fn of cleanup.splice(0))fn();});
function fixture(variant="a") {
 const root=mkdtempSync(join(tmpdir(),"submit-mock-"));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
 const artifact=JSON.parse(execFileSync(PYTHON,[join(import.meta.dir,"fixture.py"),root,PROJECT_ROOT,variant],{env:trainingEnvironment(),encoding:"utf8"}));
 return {root,artifact};
}
function page(attempts:OfficialAttempt[], upload=true) {return `${attempts.length} of 3 attempts used<table><tr><th>#</th><th>Date</th><th>Comment</th><th>Result</th><th>Info</th></tr>${attempts.map(a=>`<tr class="attempt"><td>${a.id}</td><td>today</td><td>${a.comment}</td><td>${a.score??"---"}</td><td>${a.state==="rejected"?"FAILURE":""}</td></tr>`).join("")}</table>${upload?'<form enctype="multipart/form-data" action="/task/upload/"><input value="csrf-fixture" name="csrfmiddlewaretoken"></form>':""}`;}
function server(mode:"score"|"unknown"|"pending"|"reject"|"timeout"|"crash"="score", auth=false) {
 const state={attempts:[] as OfficialAttempt[],posts:0,loginPosts:0,getFailure:false,score:0,childPid:0};
 const running=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req) {
  const url=new URL(req.url);
  if(url.pathname==="/login/"&&req.method==="POST") {state.loginPosts++;const body=await req.text();expect(body).toContain("username=mock-user");expect(body).toContain("csrfmiddlewaretoken=login-csrf");return new Response("authenticated",{headers:{"Set-Cookie":"sessionid=mock-session; Path=/"}});}
  if(req.method==="GET") {
   if(state.getFailure)return new Response("unavailable",{status:503});
   if(auth&&!req.headers.get("cookie")?.includes("sessionid=mock-session"))return new Response('<form action="/login/"><input name="username" type="text"><input name="password" type="password"><input type="hidden" name="csrfmiddlewaretoken" value="login-csrf"></form>');
   return new Response(page(state.attempts));
  }
  expect(url.pathname).toBe("/task/upload/");state.posts++;
  const body=await req.formData();expect(body.get("csrfmiddlewaretoken")).toBe("csrf-fixture");expect(req.headers.get("x-csrftoken")).toBe("csrf-fixture");expect((body.get("file[0]") as File).name).toBe("output.csv");expect((body.get("file[1]") as File).name).toBe("source.zip");
  expect(await (body.get("file[0]") as File).text()).toBe("test/a.x;0\ntest/b.x;1\n");
  if(mode!=="unknown")state.attempts.push({id:String(state.attempts.length+1),comment:String(body.get("comment")),state:mode==="pending"?"pending":mode==="reject"?"rejected":"scored",score:mode==="pending"||mode==="reject"?null:state.score});
  if(mode==="crash")process.kill(state.childPid,"SIGKILL");
  if(mode==="timeout") {await Bun.sleep(100);return new Response("late");}return new Response("anything is not acceptance");
 }});cleanup.push(()=>running.stop(true));return {state,url:`http://127.0.0.1:${running.port}/task/`};
}
function options(f:ReturnType<typeof fixture>,s:ReturnType<typeof server>,action="action-a"):SubmitRefitOptions {return {taskId:"fixture",refitArtifact:f.artifact,policy:{version:1,authorized:true,maxSubmissions:3,pipelineRunId:"run-a",controllerInvocationId:action},transport:{taskUrl:s.url,username:"mock-user",password:"mock-password",timeoutMs:1000},accountingRoot:join(f.root,"accounting"),projectRoot:PROJECT_ROOT,pythonExecutable:PYTHON,environmentFingerprint:"fixture-environment",taskPromptPath:join(f.root,"prompt.md"),env:trainingEnvironment(),pollTimeoutMs:1,pollIntervalMs:1};}
const hash=(p:string)=>createHash("sha256").update(readFileSync(p)).digest("hex");
test("strict official table parsing keeps score zero and rejects unrelated/malformed rows",()=>{
 const status=parseTaskPage("https://example.test/task/",page([{id:"1",comment:"token",state:"scored",score:0}]));expect(status.attempts[0].score).toBe(0);expect(status.triesRemaining).toBe(2);
 const scientific=page([{id:"1",comment:"token",state:"scored",score:0.2}]).replace(">0.2</td>",">2e-1</td>");expect(parseTaskPage("https://example.test/task/",scientific).attempts[0].score).toBe(0.2);
 for(const html of [page([]).replace("0 of 3","0 of 9"),page([]).replace("<th>Comment</th>","<th>Other</th>"),page([{id:"1",comment:"x",state:"scored",score:1.1}]),page([{id:"1",comment:"x",state:"scored",score:0}]).replace(">0</td>",">error 0</td>")])expect(()=>parseTaskPage("https://example.test/task/",html)).toThrow();
});
test("controller authorization is mandatory; no-submit causes zero HTTP POST including login",async()=>{
 const f=fixture(),s=server("score",true),o=options(f,s);o.policy.authorized=false;
 const result=await submitRefit(o);expect(result.state).toBe("disabled");expect(s.state.posts+s.state.loginPosts).toBe(0);
 expect(()=>validatePolicy(undefined)).toThrow();expect(()=>validatePolicy({...o.policy,maxSubmissions:4})).toThrow();
},30000);
test("real transport handles authentication, CSRF and multipart; score zero and durable duplicate actions",async()=>{
 const f=fixture(),s=server("score",true),o=options(f,s);
 const before=await readOfficialStatus({...o.transport,cookie:"sessionid=mock-session"});expect(before.attempts).toEqual([]);
 const first=await submitRefit(o);expect(first).toMatchObject({state:"scored",officialScore:0,triesUsed:1,triesRemaining:2,newAttempt:true,reservedUnknown:0,effectiveTriesUsed:1});expect(first.artifacts.map(a=>a.kind)).toEqual(["submission_receipt","submission_bundle"]);
 expect((await submitRefit(o)).newAttempt).toBe(false);
 expect((await submitRefit({...o,policy:{...o.policy,pipelineRunId:"new-run",controllerInvocationId:"new-action"}})).newAttempt).toBe(false);expect(s.state.posts).toBe(1);
},30000);
test("unknown outcome reserves budget across restart and blocks any different action",async()=>{
 const f=fixture(),s=server("unknown"),o=options(f,s);const first=await submitRefit(o);
 expect(first).toMatchObject({state:"unknown",triesUsed:0,triesRemaining:2,reservedUnknown:1,effectiveTriesUsed:1});
 expect((await submitRefit(o)).state).toBe("unknown");await expect(submitRefit({...o,policy:{...o.policy,pipelineRunId:"new-run",controllerInvocationId:"b"}})).rejects.toThrow("reconciliation");expect(s.state.posts).toBe(1);
 const scope=join(o.accountingRoot,readdirSync(o.accountingRoot)[0]);const ledger=JSON.parse(readFileSync(join(scope,"ledger.json"),"utf8"));
 s.state.attempts.push({id:"1",comment:ledger.intents[0].token,state:"scored",score:0.8});
 expect(await submitRefit(o)).toMatchObject({state:"scored",officialScore:0.8,reservedUnknown:0,newAttempt:false});expect(s.state.posts).toBe(1);
},30000);
test("accepted upload timeout reconciles read-only and never repeats POST",async()=>{
 const f=fixture(),s=server("timeout"),o=options(f,s);o.transport.timeoutMs=25;
 expect(await submitRefit(o)).toMatchObject({state:"scored",officialScore:0});await submitRefit(o);expect(s.state.posts).toBe(1);
},30000);
test("new run status includes task-global unknown reservations without original source or an upload",async()=>{
 const f=fixture(),s=server("unknown"),o=options(f,s);await submitRefit(o);
 const scope=join(o.accountingRoot,readdirSync(o.accountingRoot)[0]);const ledger=JSON.parse(readFileSync(join(scope,"ledger.json"),"utf8"));
 rmSync(o.refitArtifact.path);rmSync(join(f.root,"source"),{recursive:true,force:true});
 const next={...o,policy:{...o.policy,pipelineRunId:"new-run",controllerInvocationId:"new-controller"}};
 expect(await readSubmissionAccounting(next)).toMatchObject({officialStatus:{triesUsed:0,triesRemaining:3},reservedUnknown:1,effectiveTriesUsed:1,unresolved:true});
 s.state.attempts.push({id:"1",comment:ledger.intents[0].token,state:"pending",score:null});
 expect(await readSubmissionAccounting(next)).toMatchObject({officialStatus:{triesUsed:1,triesRemaining:2},reservedUnknown:0,effectiveTriesUsed:1,unresolved:true});
 s.state.attempts[0]={...s.state.attempts[0],state:"scored",score:1};
 expect(await readSubmissionAccounting(next)).toMatchObject({officialStatus:{triesUsed:1,triesRemaining:2},reservedUnknown:0,effectiveTriesUsed:1,unresolved:false});
 expect(s.state.posts).toBe(1);
},30000);
test("official failures consume tries, external attempts and task-global three-try cap survive new runs",async()=>{
 const f=fixture(),s=server("reject"),o=options(f,s);s.state.attempts.push({id:"1",comment:"external",state:"scored",score:0.4});
 expect(await submitRefit(o)).toMatchObject({state:"rejected",triesUsed:2,triesRemaining:1});
 const f2=fixture("b");const o2={...options(f2,s,"b"),accountingRoot:o.accountingRoot,policy:{...o.policy,pipelineRunId:"other-run",controllerInvocationId:"b"}};
 expect(await submitRefit(o2)).toMatchObject({state:"rejected",triesUsed:3,triesRemaining:0});
 await expect(submitRefit({...o2,policy:{...o2.policy,controllerInvocationId:"c"}})).rejects.toThrow("budget");expect(s.state.posts).toBe(2);
},30000);
test("pending or ambiguous attempts block uploads until official reconciliation",async()=>{
 const f=fixture(),s=server("pending"),o=options(f,s);expect((await submitRefit(o)).state).toBe("pending");
 await expect(submitRefit({...o,policy:{...o.policy,controllerInvocationId:"b"}})).rejects.toThrow("reconciliation");
 s.state.attempts.push({...s.state.attempts[0],id:"2"});await expect(submitRefit(o)).rejects.toThrow("Ambiguous");expect(s.state.posts).toBe(1);
},30000);
test("single writer lock guards concurrent POST ownership",async()=>{
 const f=fixture(),s=server("timeout"),o=options(f,s);const active=submitRefit(o);
 await expect(submitRefit(o)).rejects.toThrow("owned by another service");await active;expect(s.state.posts).toBe(1);
},30000);
test("frozen bundle excludes credential/data/transcript files, preserves exact source and platform format",()=>{
 const f=fixture(),s=server(),o=options(f,s);const bundle=buildFrozenBundle(o,f.root);const manifest=JSON.parse(readFileSync(join(bundle.directory,"bundle.json"),"utf8"));expect(manifest.files.map((v:any)=>v.path)).toEqual(["features.py","tasks/fixture.py"]);
 expect(readFileSync(join(bundle.directory,"output.csv"),"utf8")).toBe("test/a.x;0\ntest/b.x;1\n");
 const listing=execFileSync(PYTHON,["-c","import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.namelist()); assert z.testzip() is None",join(bundle.directory,"source.zip")],{encoding:"utf8"});expect(listing).toContain("source/tasks/fixture.py");expect(listing).not.toContain("credentials");
 writeFileSync(join(bundle.directory,"source.zip"),"tamper");expect(()=>buildFrozenBundle(o,f.root)).toThrow("changed");
},30000);
test("wrong task, stale evidence, dirty frozen source and checksummed invalid prediction domain are refused before upload",async()=>{
 const f=fixture(),s=server(),o=options(f,s);
 await expect(submitRefit({...o,taskId:"wrong"})).rejects.toThrow("validation");
 writeFileSync(join(f.root,"predictions.csv"),"id,prediction\ntest/a.x,2\ntest/b.x,1\n");
 const result=JSON.parse(readFileSync(f.artifact.path,"utf8"));result.artifacts["predictions.csv"]=hash(join(f.root,"predictions.csv"));writeFileSync(f.artifact.path,JSON.stringify(result));o.refitArtifact={...f.artifact,sha256:hash(f.artifact.path)};
 await expect(submitRefit(o)).rejects.toThrow("validation");expect(s.state.posts).toBe(0);
},30000);
test("recovery reconciles a saved intent without building source or making any POST",async()=>{
 const f=fixture(),s=server("unknown"),o=options(f,s);await submitRefit(o);
 const scope=join(o.accountingRoot,readdirSync(o.accountingRoot)[0]);const ledger=JSON.parse(readFileSync(join(scope,"ledger.json"),"utf8"));
 s.state.attempts.push({id:"1",comment:ledger.intents[0].token,state:"scored",score:1});
 // Frozen development files can be unavailable on recovery; receipt recovery only uses existing intent/bundle and GET.
 rmSync(join(f.root,"source"),{recursive:true,force:true});
 expect(await reconcileSubmission(o)).toMatchObject({state:"scored",officialScore:1,newAttempt:false,reservedUnknown:0});expect(s.state.posts).toBe(1);expect(s.state.loginPosts).toBe(0);
},30000);
test("read-only status authenticates with existing credentials without any upload",async()=>{
 const s=server("score",true);expect((await readOfficialStatus({taskUrl:s.url,username:"mock-user",password:"mock-password"})).triesUsed).toBe(0);expect(s.state.loginPosts).toBe(1);expect(s.state.posts).toBe(0);
});
test("same action changed bundle is refused; distinct action bundles are permitted",async()=>{
 const f=fixture(),s=server(),o=options(f,s);await submitRefit(o);const f2=fixture("b");const next={...options(f2,s),accountingRoot:o.accountingRoot};
 await expect(submitRefit(next)).rejects.toThrow("different frozen bundle");
 expect((await submitRefit({...next,policy:{...next.policy,controllerInvocationId:"b"}})).newAttempt).toBe(true);expect(s.state.posts).toBe(2);
},30000);
test("existing official pending attempts block new upload before artifact validation",async()=>{
 const f=fixture(),s=server(),o=options(f,s);s.state.attempts.push({id:"1",comment:"external",state:"pending",score:null});
 await expect(submitRefit(o)).rejects.toThrow("reconciliation");expect(s.state.posts).toBe(0);
},30000);
test("cached production table layout permits failure rows excluded from official consumed count",()=>{
 const html=page([{id:"1",comment:"format feedback",state:"rejected",score:0.9645}]).replace("1 of 3", "0 of 3").replace("<th>Date</th>","<th>Submission Date</th>").replace("<th>Info</th>","<th>Info</th><th></th><th></th>").replace("FAILURE</td>","FAILURE</td><td></td><td></td>");
 const status=parseTaskPage("https://example.test/task/",html);expect(status.triesUsed).toBe(0);expect(status.attempts[0]).toMatchObject({state:"rejected",score:null});
});
test("stale supporting evidence and dirty frozen source reject before any upload",async()=>{
 const f=fixture(),s=server(),o=options(f,s);const evidence=join(f.root,"evidence.json"),original=readFileSync(evidence);
 writeFileSync(evidence,"tampered evidence");await expect(submitRefit(o)).rejects.toThrow("validation");writeFileSync(evidence,original);
 writeFileSync(join(f.root,"source/solutions/features.py"),"VALUE = 2\n");await expect(submitRefit(o)).rejects.toThrow("validation");expect(s.state.posts).toBe(0);
},30000);
test("confirmation/freeze marker drift is rejected despite authoritative result reference",async()=>{
 const f=fixture(),s=server(),o=options(f,s);const frozen=JSON.parse(readFileSync(join(f.root,"freeze.json"),"utf8"));writeFileSync(frozen.terminalPath,"changed terminal marker");
 await expect(submitRefit(o)).rejects.toThrow("validation");expect(s.state.posts).toBe(0);
},30000);
test("changed source archive blocks recovery receipt validation and never triggers an upload",async()=>{
 const f=fixture(),s=server("unknown"),o=options(f,s);await submitRefit(o);const scope=join(o.accountingRoot,readdirSync(o.accountingRoot)[0]);const ledger=JSON.parse(readFileSync(join(scope,"ledger.json"),"utf8"));
 writeFileSync(join(ledger.intents[0].bundleDirectory,"source.zip"),"changed");await expect(reconcileSubmission(o)).rejects.toThrow("changed");expect(s.state.posts).toBe(1);
},30000);
test("official count moving backwards cannot reset task-global budget",async()=>{
 const f=fixture(),s=server(),o=options(f,s);await submitRefit(o);s.state.attempts=[];await expect(submitRefit(o)).rejects.toThrow("moved backwards");expect(s.state.posts).toBe(1);
},30000);

test("process crash after server accepts leaves intent reserved and kernel lock recoverable",async()=>{
 const f=fixture(),s=server("crash"),o=options(f,s);
 const child=spawn(process.execPath,["-e",`import {submitRefit} from ${JSON.stringify(join(import.meta.dir,"service.ts"))}; await submitRefit(JSON.parse(process.env.MOCK_SUBMISSION_OPTIONS));`],{env:{...trainingEnvironment(),MOCK_SUBMISSION_OPTIONS:JSON.stringify(o)},stdio:"ignore"});
 s.state.childPid=child.pid!;await new Promise<void>(resolve=>child.once("close",()=>resolve()));
 expect(s.state.posts).toBe(1);expect(s.state.attempts).toHaveLength(1);
 const scope=join(o.accountingRoot,readdirSync(o.accountingRoot)[0]);const ledger=JSON.parse(readFileSync(join(scope,"ledger.json"),"utf8"));expect(ledger.intents[0].state).toBe("unknown");
 expect(await reconcileSubmission(o)).toMatchObject({state:"scored",officialScore:0,newAttempt:false});expect(s.state.posts).toBe(1);
},30000);
test("missing durable intent returns null and cannot upload during recovery",async()=>{
 const f=fixture(),s=server("score",true),o=options(f,s);
 expect(await reconcileSubmission(o)).toBeNull();expect(s.state.posts).toBe(0);expect(s.state.loginPosts).toBe(0);
},30000);
test("recovery rejects a mismatched task ID without any new upload",async()=>{
 const f=fixture(),s=server(),o=options(f,s);await submitRefit(o);await expect(reconcileSubmission({...o,taskId:"other-task"})).rejects.toThrow("task identity");expect(s.state.posts).toBe(1);
},30000);
