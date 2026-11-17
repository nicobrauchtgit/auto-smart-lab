import { runConfirmation } from "../confirmation/service.js";
/** Multiclass contract and full measured lifecycle with string class names. */
import { expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { createHarnessTraining } from "../training/index.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { tagMessage } from "../training/git.js";
import { commitAll, PYTHON, PROJECT_ROOT, temporaryProject, trainingEnvironment, until, WORKER } from "../training/testing.js";
import { prepareSolveWorkspace } from "../solve/workspace.js";
import { parseTaskConfiguration, type TaskConfiguration } from "../pipeline/task_configuration.js";
import { createHash } from "node:crypto";
import { runRefit } from "./service.js";

import { trialDigest } from "../run/trial_digest.js";
import { taskContract } from "../prompts/lead.js";
import { sealFamilies, createStratifiedFolds } from "../solve/folds.js";
function zip(directory: string, target: string, members: Record<string, string>) {
	for (const [name, body] of Object.entries(members)) {
		mkdirSync(join(directory, name, ".."), { recursive: true });
		writeFileSync(join(directory, name), body);
	}
	execFileSync(PYTHON, ["-c", "import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], 'w') as a:\n for n in sys.argv[2:]: a.write(n, n)", target, ...Object.keys(members)], { cwd: directory });
}


const CONFIG = parseTaskConfiguration({schemaVersion:1,kind:"multiclass_classification",samples:{source:"zip_members",train:"tor1-train.zip",test:"tor1-test.zip"}, targets:{kind:"multiclass",file:"tor1-train.labels"},execution:"inductive",holdout:"stratified",metric:"balanced_accuracy",refit:"fit_training_predict_test",submission:{format:"id_semicolon_prediction",predictions:"class_label"}});
const MODEL = `
import zipfile
from sklearn.base import BaseEstimator
class Model(BaseEstimator):
 def words(self, X):
  result = []
  for d in X['input']:
   with zipfile.ZipFile(d['archive']) as z: result.append(z.read(d['member']).decode().strip())
  return result
 def fit(self, X, y):
  assert all(isinstance(v, str) for v in y)
  self.mapping = dict(zip(self.words(X), y))
  self.classes_ = sorted(set(y))
  return self
 def predict(self, X): return [self.mapping[w] for w in self.words(X)]
def build_pipeline(context): return Model()
`;
test("tor declarations parse and render factual lead contracts", () => {
 const config = JSON.parse(readFileSync(join(import.meta.dir,"../../pipeline.config.json"),"utf8"));
 for (const id of ["tor1","tor2"]) {
  const c = parseTaskConfiguration(config.pipeline.tasks[id]);
  expect(taskContract(loadPromptSnapshot(),id,c,"")[0].text).toContain(id);
 }
 expect(trialDigest("multiclass_classification",{metrics:{balancedAccuracy:.8,perClassRecall:{"site0.org":.5},topConfusions:[{true:"site0.org",predicted:"site1.org",rows:3}]}})).toContain("worst-recall classes site0.org: 0.500; top confusions");
 expect(() => parseTaskConfiguration({...CONFIG,submission:{...CONFIG.submission,predictions:"binary"}})).toThrow();
});
test("multiclass sealing and folds preserve all classes", () => {
 const rows = Array.from({length:90},(_,i)=>({id:String(i),group:`site${i%3}`}));
 const split = sealFamilies(rows,13);
 for (const group of ["site0","site1","site2"]) {
  expect(rows.some(r=>r.group===group && split.sealedIds.includes(r.id))).toBe(true);
  expect(rows.some(r=>r.group===group && split.devIds.includes(r.id))).toBe(true);
 }
 const labels = rows.map(r=>r.group);
 for (const fold of createStratifiedFolds(labels,3,13)) expect(new Set(fold.map(i=>labels[i])).size).toBe(3);
});
test("multiclass strings: trial, champion comparison, confirmation, refit and delivery", async () => {
 const project = temporaryProject("multiclass-task-");
 let training: ReturnType<typeof createHarnessTraining> | undefined;
 try {
 const taskDir = join(project.root,"task"), data = join(taskDir,"data");
 mkdirSync(data,{recursive:true});writeFileSync(join(taskDir,"prompt.md"),"Predict website names.\n");
 const train:Record<string,string> = {}, labels:string[] = [];
 for(let c=0;c<3;c++) for(let i=0;i<20;i++) {const id=`train/${c}-${i}.pcap`;train[id]=`site${c}`;labels.push(`${id};site${c}.org`);}
 const testRows = {"1.pcap":"site0","2.pcap":"site1","3.pcap":"site2"};
 zip(join(project.root,"train"),join(data,"tor1-train.zip"),train);
 zip(join(project.root,"test"),join(data,"tor1-test.zip"),testRows);
 writeFileSync(join(data,"tor1-train.labels"),labels.join("\n")+"\n");
 const workspace = prepareSolveWorkspace("fixture",{configuration:CONFIG,projectRoot:project.root,taskDir,pythonExecutable:PYTHON,seed:13});
 expect(workspace.targetSummary).toContain("Classes: 3;");
 writeFileSync(join(project.solutionsRoot,"tasks/fixture.py"),MODEL);commitAll(project.solutionsRoot,"String classifier");
 const datasetSha256 = createHash("sha256").update(readFileSync(workspace.devZip)).update(readFileSync(workspace.sampleManifestPath)).digest("hex");
 training = createHarnessTraining({root:join(workspace.root,"training/run"),projectRoot:project.root,solutionsRoot:project.solutionsRoot,pythonExecutable:PYTHON,env:trainingEnvironment(),environmentFingerprint:"fixture-environment",taskId:"fixture",datasetSha256,rootSeed:13,zipPath:workspace.devZip,measurement:workspace.measurement,workerPath:WORKER,prompts:loadPromptSnapshot(),limits:{sampleIntervalMs:25}});
 for(let i=0;i<2;i++) {
 const started = await training.service.start({schemaVersion:2,hypothesis:"Fixture string mapping",pipeline:{module:"solutions/tasks/fixture.py",factory:"build_pipeline"},cv:{kind:"builtin",scheme:"stratified_kfold",folds:3,repeats:1},scope:{kind:"promotion"}});
 expect(await until(()=>training!.supervisor.status(started.id).status!=="running",30000)).toBe(true);
 await training.service.finalize(started.id);
 const result=JSON.parse(readFileSync(join(started.directory,"trial-result.json"),"utf8"));
 expect(result).toMatchObject({status:"completed",promotionEligible:true,metrics:{balancedAccuracy:1,accuracy:1}});
 if(i===1) expect(result.championComparison ?? result.diagnostics.championComparison).toMatchObject({status:"completed",meanDifference:0});
 }
 const search = await training.service.start({schemaVersion:2,hypothesis:"Multiclass search fixture",pipeline:{module:"solutions/tasks/fixture.py",factory:"build_pipeline"},cv:{kind:"builtin",scheme:"stratified_kfold",folds:3,repeats:1},scope:{kind:"promotion"},search:{space:{"factory.slot":{type:"categorical",choices:[1]}},sampler:"grid",maxConfigs:1}});
 expect(await until(()=>training!.supervisor.status(search.id).status!=="running",30000)).toBe(true);
 await training.service.finalize(search.id);
 expect(JSON.parse(readFileSync(join(search.directory,"trial-result.json"),"utf8"))).toMatchObject({status:"completed",promotionEligible:true,metrics:{balancedAccuracy:1}});
 await training.close();training=undefined;
 const confirmed=await runConfirmation({workspace:{...workspace,solutionsRoot:project.solutionsRoot},pythonExecutable:PYTHON,environmentFingerprint:"fixture-environment",env:trainingEnvironment()});
 const receipt=JSON.parse(readFileSync(confirmed.artifact.path,"utf8"));expect(receipt.metrics.balancedAccuracy).toBe(1);expect(receipt.interval.lower).toBe(1);
 const refit=await runRefit({taskId:"fixture",projectRoot:project.root,solutionsRoot:project.solutionsRoot,pythonExecutable:PYTHON,taskConfiguration:CONFIG,labelsPath:join(data,"tor1-train.labels"),trainZip:join(data,"tor1-train.zip"),testZip:join(data,"tor1-test.zip"),environmentFingerprint:"fixture-environment",env:trainingEnvironment()});
 expect(refit.validation.valid).toBe(true);
 const promptPath = join(taskDir,"prompt.md");writeFileSync(promptPath,"1.pcap;site0.org\n");
 const bundle = JSON.parse(execFileSync(PYTHON,[join(import.meta.dir,"../submission/bundle.py")],{input:JSON.stringify({refitArtifact:refit.artifacts.find(a=>a.kind==="terminal_refit_result"),taskId:"fixture",environmentFingerprint:"fixture-environment",projectRoot:PROJECT_ROOT,predictions:"class_label",taskPromptPath:promptPath,outputDirectory:join(project.root,"bundle")}),env:trainingEnvironment(),encoding:"utf8"}));
 expect(bundle.taskId).toBe("fixture");
 const delivery=refit.artifacts.find(a=>a.kind==="final_delivery")!;
 expect(readFileSync(join(delivery.path,"..","output.csv"),"utf8")).toBe("1.pcap;site0.org\n2.pcap;site1.org\n3.pcap;site2.org\n");
 } finally {await training?.close();rmSync(project.root,{recursive:true,force:true});}
},120000);
