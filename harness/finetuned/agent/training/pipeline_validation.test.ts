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
  writeFileSync(script,'import json, ctypes\nimport sys\nfrom pathlib import Path\nPath(json.load(sys.stdin)["smokeBasePath"]).write_text(json.dumps({"smokeBase":{"passed":True,"sample":{"trainRows":256}}}))\nctypes.CDLL(None).sleep(30)\n');
  let seen:any;
  const issues=await runPipelineValidation({pythonExecutable:projectPython(),scriptPath:script,smokeBasePath:join(root,"base.json"),sourceRoot:root,cwd:root,timeoutMs:1000,measurement:{kind:"clustering",execution:"batch",anchorManifestPath:"fixture"} as any,request:{pipeline:{module:"fixture"}} as any,interpret(value:any){seen=value;return value.passed ? [] : undefined;}});
  expect(issues).toEqual([]);expect(seen).toMatchObject({passed:true,sample:{trainRows:256},testPart:{available:false,reason:"Timeout"}});
 } finally {rmSync(root,{recursive:true,force:true})}
});

test("binary smoke that hangs at exit still fails despite a base record", async () => {
 const root=mkdtempSync(join(tmpdir(),"binary-smoke-deadline-"));
 try {
  const script=join(root,"blocked.py");
  writeFileSync(script, 'import json, sys, time\nfrom pathlib import Path\nPath(json.load(sys.stdin)["smokeBasePath"]).write_text(json.dumps({"smokeBase":{"passed":True}}))\nprint(json.dumps({"smokeBase":{"passed":True}}), flush=True)\ntime.sleep(30)\n');
  const issues=await runPipelineValidation({pythonExecutable:projectPython(),scriptPath:script,smokeBasePath:join(root,"base.json"),sourceRoot:root,cwd:root,timeoutMs:300,measurement:{kind:"classification"} as any,request:{pipeline:{module:"fixture"}} as any,interpret(){return [];}});
  expect(issues[0]!.problem).toContain("did not finish");
 } finally {rmSync(root,{recursive:true,force:true});}
});
