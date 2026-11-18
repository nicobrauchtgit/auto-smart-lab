/** Real measured evidence and terminal worker, with scripted lead/reviewer decisions. */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runLeadSession, type LeadDependencies } from './lead_session.js';
import { runRefit, hashFile, type RefitOptions } from '../refit/service.js';
import { createHarnessTraining } from '../training/index.js';
import { commitAll, temporaryProject, PYTHON, PIPELINE_MODULE, trainingEnvironment, until, writeCorpus } from '../training/testing.js';
import { spamConfiguration } from '../pipeline/task_configuration.testing.js';
import { tagMessage } from '../training/git.js';
import { statePath } from '../paths.js';

for (const failure of ['review', 'cached-evidence-tamper'] as const) test(`new champion fails ${failure}: real terminal delivery uses the validated baseline`, async () => {
 const initial = temporaryProject('completion-delivery-');
 const f = { ...initial, solutionsRoot: statePath(initial.root, 'solutions') };
 mkdirSync(dirname(f.solutionsRoot), { recursive: true }); renameSync(initial.solutionsRoot, f.solutionsRoot);
 const configuration = spamConfiguration();
 const taskPath = join(f.root, 'task.md'); writeFileSync(taskPath, 'Synthetic binary classification fixture');
 const baselineModule = "from sklearn.dummy import DummyClassifier\ndef build_pipeline(context):\n    return DummyClassifier(strategy='most_frequent')\n";
 writeFileSync(join(f.solutionsRoot, 'tasks/fixture.py'), baselineModule);
 const baselineCommit = commitAll(f.solutionsRoot, 'Measured baseline');
 const fullRoot = join(f.root, 'full'); mkdirSync(fullRoot);
 const full = writeCorpus(fullRoot, 140);
 const testZip = join(f.root, 'test.zip');
 execFileSync(PYTHON, ['-c', "import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for i in range(7): z.writestr('test/doc%d.x'%i, 'meeting agenda' if i%2==0 else 'prize winner')", testZip]);
 const data: any = { ...f, root: f.root, taskPath, devZip: f.zipPath, trainZip: full.zipPath, testZip,
  originalTargetsPath: full.labelsPath, configuration, datasetPaths: [f.zipPath],
  targets: f.sampleManifestPath, rowCount: 120, targetSummary: 'balanced synthetic classes',
  recommendation: { folds: 2, repeats: 1, scheme: 'stratified_kfold' }, split: { scheme: 'none', sealedIds: [] } };
 let training: ReturnType<typeof createHarnessTraining>;
 let baseline = '', newer = '', refitOptions: RefitOptions | undefined;
 let validations = 0;
 const directories = new Map<string, string>();
 const dependencies: Partial<LeadDependencies> = {
  prepareData: () => data,
  readPython: () => ({ prefix: dirname(dirname(PYTHON)), executable: PYTHON, fingerprint: 'fixture-environment' } as any),
  sandbox: () => ({ executable: '/bin/false', cwd: f.root, mounts: [], env: {}, agentRoot: join(f.root, 'agent') } as any),
  environmentTool: () => ({ name: 'python_environment' } as any),
  createTraining: options => training = createHarnessTraining({ ...options,
   sandboxCommand: undefined, env: trainingEnvironment() }),
  scouts: () => ({ tool: { name: 'scout' } as any, report: async request => {
   validations++;
   const ref = request.refs?.[0];
   const id = ref && 'experiment' in ref ? ref.experiment : undefined;
   return { text: id === baseline || failure === 'cached-evidence-tamper' ? '- ok: selected candidate satisfies the fixture contract' : '- fix: newer candidate rejected by scripted review',
    roles: [{ role: 'validation', status: 'completed', bullets: 1 }] } as any;
  } }),
  runAgentSession: async options => {
   const handlers: Record<string, any[]> = {};
   for (const extension of options.extensionFactories ?? []) {
    const factory = typeof extension === 'function' ? extension : extension.factory;
    factory?.({ on: (event: string, fn: any) => (handlers[event] ??= []).push(fn) } as any);
   }
   const emit = async (id: string, name: string) => {
    for (const fn of handlers.message_end ?? []) await fn({ message: { role: 'assistant', content: [{ type: 'toolCall', id, name }] } });
   };
   const measure = async (parameters: Record<string, unknown>) => {
    const started = await training.service.start({ schemaVersion: 2, hypothesis: 'synthetic completion regression',
     pipeline: { module: 'tasks/fixture.py', factory: 'build_pipeline', estimatorParams: parameters },
     cv: { kind: 'builtin', scheme: 'stratified_kfold', folds: 2, repeats: 1 }, scope: { kind: 'promotion' } });
    expect(await until(() => training.supervisor.status(started.id).status !== 'running')).toBe(true);
    await training.service.finalize(started.id);
    directories.set(started.id, started.directory);
    return started.id;
   };
   await emit('baseline-trial', 'experiment_start'); baseline = await measure({ strategy: 'most_frequent' });
   await emit('checkpoint', 'hand_over');
   const checkpoint = await options.customTools!.find(tool => tool.name === 'hand_over')!.execute('checkpoint', { reason: 'validate baseline' }, undefined, undefined, undefined as never);
   expect(JSON.stringify(checkpoint)).toContain('Readiness checkpoint accepted');
   writeFileSync(join(f.solutionsRoot, 'tasks/fixture.py'), PIPELINE_MODULE);
   commitAll(f.solutionsRoot, 'New candidate');
   await emit('new-trial', 'experiment_start'); newer = await measure({ model__C: 0.75 });
   expect(JSON.parse(tagMessage(f.solutionsRoot, 'champion/fixture')!.message).experimentId).toBe(newer);
   if (failure === 'cached-evidence-tamper') {
    await emit('new-checkpoint', 'hand_over');
    const approved = await options.customTools!.find(tool => tool.name === 'hand_over')!.execute('new-checkpoint', { reason: 'validate new champion' }, undefined, undefined, undefined as never);
    expect(JSON.stringify(approved)).toContain('Readiness checkpoint accepted');
    const directory = directories.get(newer)!;
    const requestPath = join(directory, 'request.json'), invocationPath = join(directory, 'invocation.json');
    const request = JSON.parse(readFileSync(requestPath, 'utf8')), invocation = JSON.parse(readFileSync(invocationPath, 'utf8'));
    request.hypothesis = 'changed after approval'; invocation.request.hypothesis = request.hypothesis;
    writeFileSync(requestPath, JSON.stringify(request)); writeFileSync(invocationPath, JSON.stringify(invocation));
   }
   return { output: 'finished', agentRunId: 'scripted-lead' } as any;
  },
  refit: async input => {
   refitOptions = { ...input, taskId: 'fixture', taskConfiguration: configuration, projectRoot: f.root, solutionsRoot: f.solutionsRoot,
    pythonExecutable: PYTHON, trainZip: full.zipPath, labelsPath: full.labelsPath, testZip,
    environmentFingerprint: 'fixture-environment', env: trainingEnvironment(), expectedExperimentId: input.experimentId };
   return runRefit(refitOptions);
  },
 };
 const result = await runLeadSession('fixture', { taskConfiguration: configuration, maxToolCalls: 2,
  progressPath: join(f.root, 'lead/PROGRESS.json'), dependencies });
 expect(result.errors).toEqual([]); expect(result.valid).toBe(true);
 expect(result.progress.handOver?.experimentId).toBe(baseline);
 expect(result.collection.selected?.experimentId).toBe(baseline);
 expect(result.progress.budget).toEqual({ limit: 2, used: 2 });
 expect(validations).toBe(2);
 expect(JSON.parse(tagMessage(f.solutionsRoot, 'champion/fixture')!.message).experimentId).toBe(newer);
 const manifestPath = join(dirname(result.refitArtifacts.find(a => a.kind === 'final_delivery')!.path), 'manifest.json');
 const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
 expect(manifest).toMatchObject({ experiment: baseline, solutionCommit: baselineCommit, lines: 7 });
 expect(manifest.review).toMatchObject({ experimentId: baseline, sameExperimentAsDelivered: true });
 const outputPath = join(dirname(manifestPath), 'output.csv');
 const rows = readFileSync(outputPath, 'utf8').trim().split('\n').map(line => line.split(';'));
 expect(rows.map(row => row[0]).sort()).toEqual(Array.from({ length: 7 }, (_, i) => `test/doc${i}.x`));
 expect(rows.every(row => row[1] === '0')).toBe(true);
 expect(hashFile(outputPath)).toBe(manifest.sha256);
 const source = execFileSync(PYTHON, ['-c', "import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read('solutions/tasks/fixture.py').decode(),end='')", join(dirname(manifestPath), 'source.zip')], { encoding: 'utf8' });
 expect(source).toBe(baselineModule);
 const terminalPath = result.refitArtifacts.find(a => a.kind === 'terminal_refit_result')!.path;
 expect(JSON.parse(readFileSync(terminalPath, 'utf8'))).toMatchObject({ fitCalls: 1, trainRows: 140, testRows: 7, pipeline: { estimatorParams: { strategy: 'most_frequent' } } });
 const before = hashFile(terminalPath);
 await runRefit(refitOptions!);
 expect(hashFile(terminalPath)).toBe(before);
 expect(JSON.parse(readFileSync(join(dirname(terminalPath), 'attempt.json'), 'utf8')).attempt).toBe(1);
}, 120_000);

// Synthetic counterpart of code3's read-only PROGRESS.json: a fix finding can
// coexist with verification_incomplete and an unavailable check (exitCode null).
// All training, comparison, tag selection, candidate verification and refit below
// use the real controller/service paths; only agent/reviewer decisions are scripted.
for (const mode of ['incomplete', 'baseline-order', 'repair-chain', 'same-tree', 'tag-error'] as const)
 test(`blocked champion real delivery: ${mode}`, async () => {
 const initial = temporaryProject('blocked-delivery-');
 const f = {...initial, solutionsRoot:statePath(initial.root,'solutions')};
 mkdirSync(dirname(f.solutionsRoot),{recursive:true}); renameSync(initial.solutionsRoot,f.solutionsRoot);
 const configuration=spamConfiguration(), taskPath=join(f.root,'task.md');
 writeFileSync(taskPath,'Synthetic blocked champion regression');
 const fullRoot=join(f.root,'full');mkdirSync(fullRoot);
 const full=writeCorpus(fullRoot,140), testZip=join(f.root,'test.zip');
 execFileSync(PYTHON,['-c',"import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n for i in range(4): z.writestr('test/doc%d.x'%i,'meeting agenda' if i%2==0 else 'prize winner')",testZip]);
 const data:any={...f,root:f.root,taskPath,devZip:f.zipPath,trainZip:full.zipPath,testZip,
  originalTargetsPath:full.labelsPath,configuration,datasetPaths:[f.zipPath],targets:f.sampleManifestPath,rowCount:120,targetSummary:"balanced synthetic classes",
  recommendation:{folds:2,repeats:1,scheme:'stratified_kfold'},split:{scheme:'none',sealedIds:[]}};
 const progressPath=join(f.root,'lead/PROGRESS.json'), events:any[]=[], reviewed:string[]=[];
 let training:ReturnType<typeof createHarnessTraining>, baseline='', blocked='', fixed='', newest='';
 const champion=()=>JSON.parse(tagMessage(f.solutionsRoot,'champion/fixture')!.message).experimentId;
 const saved=()=>JSON.parse(readFileSync(progressPath,'utf8'));
 const module=(fixed:boolean)=>PIPELINE_MODULE+ '\ndef fallback_vector():\n return '+(fixed?'[0]':'[0, 0]')+'\n';
 const dependencies:Partial<LeadDependencies>={
  prepareData:()=>data,
  readPython:()=>({prefix:dirname(dirname(PYTHON)),executable:PYTHON,fingerprint:'fixture-environment'} as any),
  sandbox:()=>({executable:'/bin/false',cwd:f.root,mounts:[],env:{},agentRoot:join(f.root,'agent')} as any),
  environmentTool:()=>({name:'python_environment'} as any),
  createTraining:options=>training=createHarnessTraining({...options,sandboxCommand:undefined,env:trainingEnvironment()}),
  scouts:()=>({tool:{name:'scout'} as any,report:async request=>{
   const ref=request.refs![0],id='experiment' in ref?ref.experiment!:'';
   reviewed.push(id);
   const defect=id===blocked || id===newest;
   return {text:defect?'- fix: fallback feature length differs':'- ok: measured source verified',
    roles:[{role:'validation',status:'completed',bullets:1}],
    checkResults:mode==='incomplete' && id===blocked?[{path:'checks/other/probe.py',exitCode:null,output:'Check execution did not complete'}]:[]};
  }}),
  runAgentSession:async options=>{
   const handover=options.customTools!.find(tool=>tool.name==='hand_over')!;
   const measure=async()=>{
    const trial=await training.service.start({schemaVersion:2,hypothesis:'synthetic repair',
     pipeline:{module:'tasks/fixture.py',factory:'build_pipeline'},
     cv:{kind:'builtin',scheme:'stratified_kfold',folds:2,repeats:1},scope:{kind:'promotion'}});
    expect(await until(()=>training.supervisor.status(trial.id).status!=='running',60_000)).toBe(true);
    await training.service.finalize(trial.id);
    expect(await until(()=>saved().trials.some((row:any)=>row.experimentId===trial.id && row.feedbackRecorded),60_000)).toBe(true);
    return trial.id;
   };
   writeFileSync(join(f.solutionsRoot,'tasks/fixture.py'),"from sklearn.dummy import DummyClassifier\ndef build_pipeline(context):\n return DummyClassifier(strategy='most_frequent')\n");
   commitAll(f.solutionsRoot,'Baseline');baseline=await measure();
   await handover.execute('baseline',{reason:'baseline'},undefined,undefined,undefined as never);
   expect(saved().baseline.experimentId).toBe(baseline);
   writeFileSync(join(f.solutionsRoot,'tasks/fixture.py'),module(false));commitAll(f.solutionsRoot,'Blocked source');
   blocked=await measure();expect(champion()).toBe(blocked);
   const before=mode==='incomplete'||mode==='tag-error';
   if(before)await handover.execute('block',{reason:'check source'},undefined,undefined,undefined as never);
   if(mode==='incomplete'){
    expect(saved().validationAttempts[blocked].validation).toMatchObject({status:'verification_incomplete',fix:[expect.any(String)],checkResults:[{path:'checks/other/probe.py',exitCode:null,output:'Check execution did not complete'}]});
    expect(Object.values(saved().validationReceipts).some((r:any)=>r.experimentId===blocked)).toBe(false);
   }
   if(mode!=='same-tree'){
    writeFileSync(join(f.solutionsRoot,'tasks/fixture.py'),module(true));commitAll(f.solutionsRoot,'Correct fallback');
   }
   if(mode==='tag-error')writeFileSync(join(f.solutionsRoot,'.git/refs/tags/champion/fixture.lock'),'force real git lock failure');
   fixed=await measure();
   if(mode==='incomplete'){
    expect(champion()).toBe(fixed);
    expect(saved().trials.find((r:any)=>r.experimentId===fixed).becameChampion).toBe(true);
   }else expect(champion()).toBe(blocked);
   if(mode==='repair-chain'){
    writeFileSync(join(f.solutionsRoot,'tasks/fixture.py'),module(false)+'\n# additional feature revision\n');
    commitAll(f.solutionsRoot,'Later candidate still defective');newest=await measure();
    expect(champion()).toBe(blocked);
   }
   // Spend the synthetic session's sole tool call: exercise budget-end finalize.
   for(const extension of options.extensionFactories??[]){
    const factory=typeof extension==='function'?extension:extension.factory;
    const handlers:Record<string,any[]>={};
    factory?.({on:(name:string,fn:any)=>(handlers[name]??=[]).push(fn)} as any);
    for(const fn of handlers.message_end??[])await fn({message:{role:'assistant',content:Array.from({length:4},(_,i)=>({type:'toolCall',id:'finish-'+i,name:'read'}))}});
   }
   return {output:'finished',agentRunId:'scripted-lead'} as any;
  },
  refit:input=>runRefit({...input,taskId:'fixture',taskConfiguration:configuration,projectRoot:f.root,solutionsRoot:f.solutionsRoot,
   pythonExecutable:PYTHON,trainZip:full.zipPath,labelsPath:full.labelsPath,testZip,environmentFingerprint:'fixture-environment',
   env:trainingEnvironment(),expectedExperimentId:input.experimentId}),
 };
 const result=await runLeadSession('fixture',{taskConfiguration:configuration,maxToolCalls:4,progressPath,dependencies,
  report:{event:(type:string,data:any)=>events.push({type,...data}),input(){},agentIdentity(){return {};},observation(){return {};}} as any});
 expect(events.filter(e=>e.type==='agent_attempt_error')).toEqual([]);
 const fallback=mode==='same-tree'||mode==='tag-error', expected=fallback?baseline:fixed;
 expect(result.errors).toEqual([]);expect(result.valid).toBe(true);
 expect(result.progress.handOver?.experimentId).toBe(expected);
 expect(result.collection.selected?.experimentId).toBe(expected);
 const manifest=JSON.parse(readFileSync(join(dirname(result.refitArtifacts.find(a=>a.kind==='final_delivery')!.path),'manifest.json'),'utf8'));
 expect(manifest.experiment).toBe(expected);
 expect(reviewed).toEqual(mode==='repair-chain'?[baseline,blocked,newest,fixed]:fallback?[baseline,blocked]:[baseline,blocked,fixed]);
 const repairs=events.filter(e=>e.type==='lead_blocked_champion_replaced');
 expect(repairs.map(e=>e.experiment_id)).toEqual(fallback?[]:mode==='repair-chain'?[newest,fixed]:[fixed]);
 for(const event of repairs){
  expect(event.rendered_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(event.template_sha256).toMatch(/^[a-f0-9]{64}$/);
 }
 if(mode==='repair-chain'){
  expect(result.progress.repairChain!.bases.map(row=>row.experimentId)).toEqual([blocked,newest]);
  expect(result.progress.repairChain!.tried).toEqual([blocked,newest,fixed]);
 }
 if(mode==='tag-error'){
  expect(events.some(e=>e.type==='lead_blocked_champion_replacement_failed' && e.message.includes('lock'))).toBe(true);
  expect(result.progress.trials.find(row=>row.experimentId===fixed)?.feedbackRecorded).toBe(true);
 }
},180_000);
