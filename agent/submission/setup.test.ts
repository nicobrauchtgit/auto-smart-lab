import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkWritableAccountingParent, submissionSetupChecks, submissionRecoverySetupChecks } from "./setup.js";
import { SetupSession } from "../pipeline/setup.js";
const policy={version:1 as const,authorized:true,maxSubmissions:3,pipelineRunId:"run",controllerInvocationId:"action"};
test("submission setup is read-only and candidate prerequisite distinguishes upstream chains",()=>{
 const root=mkdtempSync(join(tmpdir(),"submit-setup-"));try{
  checkWritableAccountingParent(join(root,"runs/submissions"));expect(existsSync(join(root,"runs"))).toBe(false);
  expect(submissionSetupChecks({taskId:"fixture"})).toEqual([]);
  expect(submissionSetupChecks({taskId:"fixture",policy:{...policy,authorized:false}})).toEqual([]);
  expect(submissionSetupChecks({taskId:"fixture",policy,candidateProducedUpstream:true}).map(c=>c.id)).toEqual(["submission-local","submission-access:fixture"]);
  expect(submissionSetupChecks({taskId:"fixture",policy,candidateProducedUpstream:false}).map(c=>c.id)).toContain("submission-candidate:fixture");
 }finally{rmSync(root,{recursive:true,force:true});}
});
test("missing local submission prerequisites prevent service access and stage execution without leaking errors",async()=>{
 const old=process.env.LAB_USER;delete process.env.LAB_USER;let probes=0,stages=0;
 try {
  const checks=submissionSetupChecks({taskId:"spam1",policy,candidateProducedUpstream:true});
  checks.find(c=>c.phase==="remote")!.run=()=>{probes++;};
  await expect(new SetupSession().check(checks,new AbortController().signal,()=>{}).then(()=>stages++)).rejects.toThrow("submission-local");
  expect(probes).toBe(0);expect(stages).toBe(0);
 }finally{if(old!==undefined)process.env.LAB_USER=old;}
});

test("recovery setup permits pending/exhausted status and makes no upload or accounting writes",async()=>{
 const root=mkdtempSync(join(tmpdir(),"submit-recovery-setup-"));let auth=0,uploads=0;let exhausted=false;
 const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
  if(req.method==="POST"){if(new URL(req.url).pathname!=="/login/"){uploads++;return new Response("forbidden",{status:400});}auth++;return new Response("ok",{headers:{"Set-Cookie":"sessionid=fixture; Path=/"}});}
  if(!req.headers.get("cookie"))return new Response('<form action="/login/"><input type="text" name="username"><input type="password" name="password"><input type="hidden" name="csrfmiddlewaretoken" value="fixture"></form>');
  const rows=exhausted?3:1;return new Response(`${rows} of 3 attempts used<table><tr><th>#</th><th>Date</th><th>Comment</th><th>Result</th><th>Info</th></tr>${Array.from({length:rows},(_,i)=>`<tr><td>${i+1}</td><td>today</td><td>fixture</td><td>${exhausted?"0":"---"}</td><td></td></tr>`).join("")}</table>`);
 }});
 try {
  const options={taskId:"fixture",policy,projectRoot:root,transport:{taskUrl:`http://127.0.0.1:${server.port}/task/`,username:"fixture",password:"fixture"}};
  for(const check of submissionRecoverySetupChecks(options))await check.run(new AbortController().signal);
  exhausted=true;
  for(const check of submissionRecoverySetupChecks(options))await check.run(new AbortController().signal);
  const normal=submissionSetupChecks({...options,candidateProducedUpstream:true}).find(c=>c.phase==="remote")!;await normal.run(new AbortController().signal);
  expect(uploads).toBe(0);expect(auth).toBe(3);expect(existsSync(join(root,"runs"))).toBe(false);
 }finally{server.stop(true);rmSync(root,{recursive:true,force:true});}
});
test("submission stage options cannot carry authorization or transport credentials",async()=>{
 const {submitStage}=await import("../pipeline/stages/submit.js");
 for(const value of [{authorized:true},{cookie:"value"},{transport:{}},{toString:1}])expect(()=>submitStage.parseOptions(value)).toThrow("Unknown");
 expect(typeof submitStage.reconcile).toBe("function");expect(submitStage.recoverySetupRequirements).toEqual(["submission-recovery"]);
});
