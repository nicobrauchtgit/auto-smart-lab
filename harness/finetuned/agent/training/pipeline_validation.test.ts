import {test,expect} from "bun:test";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {projectPython} from "../pipeline/task_configuration.js";
import {runPipelineValidation} from "./pipeline_validation.js";

test("outer validation deadline fails an anchored smoke that blocks in native code", async () => {
 const root=mkdtempSync(join(tmpdir(),"smoke-deadline-"));
 try {
  const script=join(root,"blocked.py");
  // Agent code can write files and print before blocking; neither may turn a timeout into a pass.
  writeFileSync(script,'import json, ctypes\nprint(json.dumps({"passed":True,"sample":{"trainRows":256}}), flush=True)\nctypes.CDLL(None).sleep(30)\n');
  const issues=await runPipelineValidation({pythonExecutable:projectPython(),scriptPath:script,sourceRoot:root,cwd:root,timeoutMs:1000,measurement:{kind:"clustering",execution:"batch",anchorManifestPath:"fixture"} as any,request:{pipeline:{module:"fixture"}} as any,interpret(value:any){return value.passed ? [] : undefined;}});
  expect(issues[0]!.problem).toContain("did not finish");
 } finally {rmSync(root,{recursive:true,force:true})}
});

test("binary smoke that hangs at exit still fails", async () => {
 const root=mkdtempSync(join(tmpdir(),"binary-smoke-deadline-"));
 try {
  const script=join(root,"blocked.py");
  writeFileSync(script, 'import json, time\nprint(json.dumps({"passed":True}), flush=True)\ntime.sleep(30)\n');
  const issues=await runPipelineValidation({pythonExecutable:projectPython(),scriptPath:script,sourceRoot:root,cwd:root,timeoutMs:300,measurement:{kind:"classification"} as any,request:{pipeline:{module:"fixture"}} as any,interpret(){return [];}});
  expect(issues[0]!.problem).toContain("did not finish");
 } finally {rmSync(root,{recursive:true,force:true});}
});
