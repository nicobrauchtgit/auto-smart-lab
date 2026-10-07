/** Deterministic upload stage. Configuration enablement is never authorization. */
import { join } from "node:path";
import { readPythonEnvironment } from "../../run/python_environment.js";
import { resolveCppRuntimeLibraryPath } from "../../training/environment.js";
import { submitRefit, reconcileSubmission, validatePolicy, submissionTransport, type SubmissionPolicy } from "../../submission/index.js";
import { PROJECT_ROOT, resolveTask } from "../resolve_task.js";
import type { StageDefinition, StageInput, StageResult } from "../types.js";
export interface SubmitStageOptions { timeoutMs:number; pollTimeoutMs:number; pollIntervalMs:number }
function inputPolicy(input:StageInput):SubmissionPolicy { return validatePolicy(input.submissionPolicy); }
export const submitStage:StageDefinition<SubmitStageOptions>={
 name:"submit",version:1,description:"Validate frozen terminal evidence and submit once under durable official attempt accounting",
 // Shared preflight skips submission credentials for disabled policy.
 setupRequirements:["task","python","submission"],
 recoverySetupRequirements:["submission-recovery"],
 parseOptions(raw) {
  if(raw!==undefined&&(!raw||typeof raw!=="object"||Array.isArray(raw)))throw new Error("submit options must be an object");
  const value=(raw??{}) as Record<string,unknown>;const defaults:SubmitStageOptions={timeoutMs:10000,pollTimeoutMs:30000,pollIntervalMs:1000};
  for(const key of Object.keys(value)) {
   if(!Object.hasOwn(defaults,key))throw new Error("Unknown submission transport option");
   const number=value[key];if(typeof number!=="number"||!Number.isInteger(number)||number<1||number>60000)throw new Error("Submission timing must be an integer in [1,60000]");
   defaults[key as keyof SubmitStageOptions]=number;
  }return defaults;
 },
 checkInput(input) {
  inputPolicy(input);resolveTask({taskId:input.taskId});
  const artifacts=input.upstream.filter(a=>a.kind==="terminal_refit_result");
  if(artifacts.length!==1||!artifacts[0].sha256||!/^[a-f0-9]{64}$/.test(artifacts[0].sha256))throw new Error("Submission requires one authoritative checksummed terminal_refit_result");
 },
 async run(context) {
  const policy=inputPolicy(context.input);
  const env=Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>entry[1]!==undefined));
  const runtime=resolveCppRuntimeLibraryPath(env);if(runtime)env.LD_LIBRARY_PATH=runtime;
  try {
   const environment=readPythonEnvironment();const task=resolveTask({taskId:context.input.taskId});
   const result=await submitRefit({taskId:context.input.taskId,refitArtifact:context.input.upstream.find(a=>a.kind==="terminal_refit_result")!,policy,
    transport:{...submissionTransport(context.input.taskId),timeoutMs:context.options.timeoutMs},accountingRoot:join(PROJECT_ROOT,"runs/submissions"),projectRoot:PROJECT_ROOT,
    pythonExecutable:environment.executable,environmentFingerprint:environment.fingerprint,taskPromptPath:join(task.taskDir,"prompt.md"),env,report:context.report,signal:context.signal,
    pollTimeoutMs:context.options.pollTimeoutMs,pollIntervalMs:context.options.pollIntervalMs});
   return submissionStageResult(result);
  }catch {
   context.signal.throwIfAborted();return {artifacts:[],attempts:0,validation:{valid:false,errors:["Submission blocked: validate policy, frozen artifact, durable accounting and official service status"]}};
  }
 },
 async reconcile(context) {
  const policy=inputPolicy(context.input);
  try {
   const result=await reconcileSubmission({taskId:context.input.taskId,policy,transport:{...submissionTransport(context.input.taskId),timeoutMs:context.options.timeoutMs},
    accountingRoot:join(PROJECT_ROOT,"runs/submissions"),report:context.report,signal:context.signal});
   if(!result)return {artifacts:[],attempts:0,validation:{valid:false,errors:["No durable submission intent found for this action; recovery cannot issue a new upload"]},summary:{version:1,state:"unknown",newAttempt:false}};
   return submissionStageResult(result);
  }catch {
   context.signal.throwIfAborted();return {artifacts:[],attempts:0,validation:{valid:false,errors:["Submission recovery blocked by official status or durable accounting validation"]},summary:{version:1,state:"unknown",newAttempt:false}};
  }
 }
};
export function submissionStageResult(result:import("../../submission/types.js").SubmissionResult):StageResult {
 const valid=result.state==="scored"||result.state==="disabled";
 return {artifacts:result.artifacts,attempts:0,validation:{valid,errors:valid?[]:[`Submission outcome ${result.state}; reconcile official state before any further upload`]},summary:{...result,artifacts:undefined}};
}
