import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import type { SetupCheck } from "../pipeline/setup.js";
import { PROJECT_ROOT, resolveTask } from "../pipeline/resolve_task.js";
import { sanitizeTrainingEnvironment } from "../training/environment.js";
import { readPythonEnvironment } from "../run/python_environment.js";
import { prepareRefit } from "../refit/service.js";
import { hashFile } from "../refit/service.js";
import { validateFrozenRefit } from "./service.js";
import { readOfficialStatus } from "./transport.js";
import { validatePolicy, type SubmissionPolicy, type TransportConfig } from "./types.js";
export function submissionTransport(taskId:string):TransportConfig {
 const task=resolveTask({taskId});if(!task.url)throw new Error("Selected task has no submission URL");
 return {taskUrl:task.url,username:process.env.LAB_USER??"",password:process.env.LAB_PASS??"",loginUrl:process.env.LAB_LOGIN_URL,cookie:process.env.LAB_SESSION_COOKIE,ca:process.env.LAB_CA_BUNDLE?readFileSync(process.env.LAB_CA_BUNDLE,"utf8"):undefined};
}
export interface SubmissionSetupOptions { taskId:string; policy?:SubmissionPolicy; projectRoot?:string; candidateProducedUpstream?:boolean; transport?:TransportConfig }
/** Controller passes the immutable run policy; absent policy never authorizes access. */
export function submissionSetupChecks(options:SubmissionSetupOptions):SetupCheck[] {
 if(options.policy === undefined)return [];
 const policy=validatePolicy(options.policy);
 if(!policy.authorized)return [];
 const root=options.projectRoot??PROJECT_ROOT;
 const checks:SetupCheck[] = [
  {id:"submission-local",phase:"local",remedy:"Set LAB_USER/LAB_PASS, restore the selected task URL/prompt, git and agent/submission/bundle.py, and sync the existing Devbox Python environment. Restore the trusted LAB_CA_BUNDLE for private TLS; submission never disables TLS verification.",run() {
   const config=options.transport??submissionTransport(options.taskId);if(!config.username||!config.password)throw new Error("Missing submission credentials");
   accessSync(join(root,"agent/submission/bundle.py"),constants.R_OK);
   accessSync(join(resolveTask({taskId:options.taskId}).taskDir,"prompt.md"),constants.R_OK);
   const python=readPythonEnvironment().executable;
   const env=sanitizeTrainingEnvironment(process.env);
   const probe=spawnSync(python,["-I","-c","import csv,zipfile,importlib.metadata,fcntl,smartlab_eval,numpy,pandas,sklearn"],{timeout:5000,stdio:"ignore",env});
   const git=spawnSync("git",["--version"],{timeout:5000,stdio:"ignore"});
   if(probe.error||probe.status!==0||git.error||git.status!==0)throw new Error("Submission runtime unavailable");
   checkWritableAccountingParent(join(root,"runs/submissions"));
  }},
  {id:`submission-access:${options.taskId}`,phase:"remote",remedy:"Verify SmartLab credentials, TLS trust and task access. A bounded CSRF login probe may authenticate with LAB_USER/LAB_PASS; it never uploads. The official attempts table must show a three-attempt budget and an available authenticated upload form; resolve pending/unknown attempts before retrying.",async run(signal) {
   const status=await readOfficialStatus(options.transport??submissionTransport(options.taskId),signal);
   if((status.triesRemaining>0&&!status.uploadAvailable)||status.attempts.some(a=>a.state==="pending"))throw new Error("Submission unavailable");
  }},
 ];
 if(!options.candidateProducedUpstream)checks.splice(1,0,{id:`submission-candidate:${options.taskId}`,phase:"local",remedy:"Complete authoritative terminal refit for the selected candidate and restore its immutable source, predictions, dependencies and evidence.",async run(signal) {
  const { refitInputs }=await import("../pipeline/stages/refit.js");
  const refit=refitInputs(options.taskId);const frozen=await prepareRefit({...refit,signal});
  const path=join(frozen.directory,"result.json");
  validateFrozenRefit({taskId:options.taskId,refitArtifact:{kind:"terminal_refit_result",path,sha256:hashFile(path)},projectRoot:root,pythonExecutable:refit.pythonExecutable,environmentFingerprint:refit.environmentFingerprint,env:refit.env,taskPromptPath:join(resolveTask({taskId:options.taskId}).taskDir,"prompt.md")});
 }});
 return checks;
}

export function checkWritableAccountingParent(path:string):void {
 let ancestor=path;while(!existsSync(ancestor)){const parent=dirname(ancestor);if(parent===ancestor)throw new Error("No accounting parent");ancestor=parent;}accessSync(ancestor,constants.R_OK|constants.W_OK);
}
/** Recovery checks task access/accounting, never candidate presence or upload availability. */
export function submissionRecoverySetupChecks(options:SubmissionSetupOptions):SetupCheck[] {
 if(options.policy===undefined)return [];
 const policy=validatePolicy(options.policy);if(!policy.authorized)return [];
 const root=options.projectRoot??PROJECT_ROOT;
 return [
  {id:"submission-recovery-local",phase:"local",remedy:"Restore LAB_USER/LAB_PASS, selected task metadata and readable durable submission accounting. Recovery never requires source/data/refit artifacts and does not reset the ledger.",run() {
   const config=options.transport??submissionTransport(options.taskId);if(!config.username||!config.password)throw new Error("Missing submission credentials");
   const path=join(root,"runs/submissions");if(existsSync(path))accessSync(path,constants.R_OK);
   checkWritableAccountingParent(path);
  }},
  {id:`submission-recovery-access:${options.taskId}`,phase:"remote",remedy:"Verify task service access and bounded CSRF login credentials/TLS trust. Pending attempts and exhausted official budgets are valid recovery states; no upload endpoint is called.",async run(signal) {
   await readOfficialStatus(options.transport??submissionTransport(options.taskId),signal);
  }},
 ];
}
