import {test,expect} from "bun:test";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {projectPython} from "../pipeline/task_configuration.js";
import {runPipelineValidation} from "./pipeline_validation.js";
test("outer validation deadline preserves the committed smoke base result during native blocking", async () => {
 const root=mkdtempSync(join(tmpdir(),"smoke-deadline-"));
 try {
  const script=join(root,"blocked.py");
  writeFileSync(script,'import json, ctypes\nprint(json.dumps({"smokeBase":{"passed":True,"sample":{"trainRows":256}}}), flush=True)\nctypes.CDLL(None).sleep(30)\n');
  let seen:any;
  const issues=await runPipelineValidation({pythonExecutable:projectPython(),scriptPath:script,sourceRoot:root,cwd:root,timeoutMs:1000,request:{pipeline:{module:"fixture"}} as any,interpret(value:any){seen=value;return value.passed ? [] : undefined;}});
  expect(issues).toEqual([]);expect(seen).toMatchObject({passed:true,sample:{trainRows:256},testPart:{available:false,reason:"Timeout"}});
 } finally {rmSync(root,{recursive:true,force:true})}
});
