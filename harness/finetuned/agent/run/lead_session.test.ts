import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runLeadSession, validationPassed, recoveryTrainingRoot, LeadInbox } from './lead_session.js';
import { readProgress, writeProgress, renderProgress, type LeadProgress } from './lead_progress.js';
import { loadPromptSnapshot } from '../prompts/loader.js';
import { ScoutBudget } from '../team/budget.js';
import { spamConfiguration } from '../pipeline/task_configuration.testing.js';
import { trialSupervisionDirectory } from '../training/results.js';
const prompts = loadPromptSnapshot();
function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'lead-contract-'));
 const solutionsRoot = join(root, 'solutions'); mkdirSync(solutionsRoot);
 const git = (...args: string[]) => execFileSync('git', ['-C', solutionsRoot, ...args], { encoding: 'utf8' }).trim();
 git('init'); git('config','user.name','Fixture'); git('config','user.email','fixture@example.test');
 writeFileSync(join(solutionsRoot,'INDEX.md'),'fixture'); git('add','.'); git('-c','commit.gpgsign=false','commit','-m','fixture');
 const commit = git('rev-parse','HEAD'); git('tag','-a','champion/spam1','-m', JSON.stringify({experimentId:'measured', balancedAccuracy:1}));
 const taskPath=join(root,'task.md'), devZip=join(root,'dev.zip'), sampleManifestPath=join(root,'manifest');
 writeFileSync(taskPath,'UNIT INTRO MARKER\nEXPLICIT TASK MARKER');writeFileSync(devZip,'fixture');writeFileSync(sampleManifestPath,'{}');
 const data:any={root, solutionsRoot, taskPath,devZip,sampleManifestPath,configuration:spamConfiguration(),datasetSha256:'d'.repeat(64),
  datasetPaths:[devZip],targets:sampleManifestPath,rowCount:4,targetSummary:'balanced', recommendation:{folds:2,repeats:1,scheme:'stratified_kfold'},split:{scheme:'none',sealedIds:[]}};
 return {root,solutionsRoot,data,commit, close:()=>rmSync(root,{recursive:true,force:true})};
}
test('budget admission is durable before execution, and recovery keeps its used calls', () => {
 const f=fixture(); try {
 const path=join(f.root,'PROGRESS.json');
 const progress:LeadProgress={schemaVersion:1,taskId:'spam1',runId:'original',trainingRoot:join(f.root,'training'),status:'running',startedAt:new Date().toISOString(),sessions:[],trials:[],holdout:[],budget:{limit:80,used:0},scoutCalls:0};
 const budget=new ScoutBudget(80,prompts,{onCharge:used=>{progress.budget.used=used;writeProgress(path,progress);}});
 budget.assistant({role:'assistant',content:[{type:'toolCall',id:'trial'}]});
 const saved=readProgress(path)!; expect(saved.budget.used).toBe(1);
 const resumed=new ScoutBudget(saved.budget.limit,prompts,{used:saved.budget.used});expect(resumed.used).toBe(1);
 expect(renderProgress(prompts,saved).text).toContain('1 of 80');
 } finally {f.close();}
});
test('recovery finds protected records and refuses worker-writable legacy records',()=>{
 const f=fixture();try {
 const trial=join(f.root,'training','original','trial');mkdirSync(trial,{recursive:true});
 const protectedRoot=trialSupervisionDirectory(trial);mkdirSync(protectedRoot,{recursive:true});writeFileSync(join(protectedRoot,'recovery.json'),JSON.stringify({lifecycle:'active'}));
 expect(recoveryTrainingRoot(join(f.root,'training'),'new')).toBe(join(f.root,'training','original'));
 rmSync(protectedRoot,{recursive:true});writeFileSync(join(trial,'recovery.json'),'{}');
 expect(()=>recoveryTrainingRoot(join(f.root,'training'),'new')).toThrow('Legacy worker-writable');
 }finally{f.close();}
});
for(const verdict of ['ok','fix','failed','empty'] as const) test(`budget-end handover validates champion: ${verdict}`,async()=>{
 const f=fixture();let validations=0,refits=0;
 try {
 const result=await runLeadSession('spam1',{taskConfiguration:spamConfiguration(),maxToolCalls:1,progressPath:join(f.root,'lead/PROGRESS.json'),dependencies:{
 prepareData:()=>f.data,readPython:()=>({prefix:f.root,executable:'/bin/false',fingerprint:'f'} as any),sandbox:()=>({executable:'/bin/false',cwd:f.root,mounts:[],env:{},agentRoot:join(f.root,'agent')} as any),
 prepareRepository:()=>({initialized:false,head:f.commit,branch:'master'}),environmentTool:()=>({name:'python_environment'} as any),
 createTraining:()=>({ready:async()=>{},close:async()=>{},tools:[],toolPrompts:[],service:{describe:()=>({})},supervisor:{list:()=>[]},bindSession:()=>{}} as any),
 scouts:()=>({tool:{name:'scout'} as any,report:async()=>{validations++;return {text:verdict==='ok'?'- ok: frozen trial [experiment: measured]':verdict==='fix'?'- fix: broken feature [experiment: measured]':'', roles:[{role:'validation',status:verdict==='ok'||verdict==='fix'?'completed':verdict,bullets:1}]};}}),
 runAgentSession:async options=>{
 expect(options.prompt).toContain('UNIT INTRO MARKER');expect(options.prompt).toContain('EXPLICIT TASK MARKER');
 expect(options.prompt).not.toContain('PRIVATE SCOUT TRANSCRIPT');
 if(verdict==='fix') {
  const handover=options.customTools!.find(tool=>tool.name==='hand_over')!;
  for(let attempt=0;attempt<2;attempt++) {
   const reply=await handover.execute('handover',{reason:'ready'},undefined,undefined,undefined as never);
   expect(JSON.stringify(reply)).toContain('not approved');
  }
 }
 const handlers:any={};for(const extension of options.extensionFactories??[]) {const factory=typeof extension==='function'?extension:(extension as any).factory;if(factory) factory({on:(name:string,fn:any)=>{(handlers[name]??=[]).push(fn);}});}
 for(const fn of handlers.message_end??[]) await fn({message:{role:'assistant',content:[{type:'toolCall',id:'unknown'}]}});
 return {output:'finished',agentRunId:'fixture'} as any;
 },
 refit:async()=>{refits++;return {artifacts:[],validation:{valid:true,errors:[]}};},collectResults:async()=>({valid:false,trials:[],artifacts:[],errors:[]}) as any,
 }});
 expect(validations).toBe(1);expect(refits).toBe(verdict==='ok'?1:0);expect(result.valid).toBe(verdict==='ok');expect(result.progress.budget.used).toBe(1);
 if(verdict!=='ok')expect(result.stopReason).toBe('validation_failed');
 }finally{f.close();}
});
test('validation requires completed labelled evidence',()=>{
 expect(validationPassed({status:'completed',fix:[],ok:[],advice:[]})).toBe(false);
 expect(validationPassed({status:'failed',fix:[],ok:['ok'],advice:[]})).toBe(false);
});
test('news wakes an idle lead, and healthy waiting does not fabricate messages',async()=>{
 const inbox=new LeadInbox();const waiting=inbox.wait(1000);inbox.push('trial completed');await waiting;expect(inbox.take()).toEqual(['trial completed']);expect(inbox.take()).toEqual([]);
});
test('interrupted lead resumes the same training root and budget, compacts from progress, and receives only scout bullets', async()=>{
 const f=fixture();const controller=new AbortController();const path=join(f.root,'lead/PROGRESS.json');let activeController=controller;let sessions=0,starts=0;const roots:string[]=[];
 const {createScouts}=await import('../team/scouts.js');
 const scouts=createScouts({prompts,taskId:'spam1',task:'UNIT INTRO\nTASK TEXT',dataPaths:'dev',resources:'none',journalPath:join(f.root,'findings/journal.jsonl'),datasetSha256:'d'.repeat(64),runId:'original',invocationId:'fixture',prepare:async()=>{},run:async()=> 'PRIVATE SCOUT TRANSCRIPT\n- sourced final observation (profile.rows)\nPRIVATE TOOL OUTPUT'});
 const dependencies:any={
 prepareData:()=>f.data,readPython:()=>({prefix:f.root,executable:'/bin/false',fingerprint:'f'}),sandbox:()=>({executable:'/bin/false',cwd:f.root,mounts:[],env:{},agentRoot:join(f.root,'agent')}),
 prepareRepository:()=>({initialized:false,head:f.commit,branch:'master'}),environmentTool:()=>({name:'python_environment'}),
 createTraining:(options:any)=>{roots.push(options.root);return {ready:async()=>{},close:async()=>{},tools:[],toolPrompts:[],service:{describe:()=>({})},supervisor:{list:()=>[]},bindSession:()=>{}};},
 scouts:()=>scouts,refit:async()=>{throw Error('must not refit a cancelled run');},collectResults:async()=>({valid:false,trials:[],artifacts:[],errors:[]}),
 runAgentSession:async(options:any)=>{
 const handlers:any={};for(const extension of options.extensionFactories) {const factory=typeof extension==='function'?extension:extension.factory;factory({on:(name:string,fn:any)=>{(handlers[name]??=[]).push(fn);}});}
 if(sessions++===0) {
  for(const fn of handlers.message_end??[]) await fn({message:{role:'assistant',content:[{type:'toolCall',id:'trial'}]}});
  // The controller restart must not reissue this admitted trial.
  starts++;
 } else {
  expect(options.prompt).toContain('1 of 80');
  expect(options.sessionContext()).toBe('');expect(options.sessionContext()).toContain('1 of 80');
  const tool=options.customTools.find((tool:any)=>tool.name==='scout');
  const reply=await tool.execute('scout-call',{role:'data',question:'inspect'},undefined,undefined,undefined);
  const leadContext=JSON.stringify(reply);
  expect(leadContext).toContain('sourced final observation');expect(leadContext).not.toContain('PRIVATE');
 }
 activeController.abort();return {output:'interrupted',agentRunId:'fixture'};
 }};
 try {
 const first=await runLeadSession('spam1',{taskConfiguration:spamConfiguration(),runId:'original',progressPath:path,signal:controller.signal,dependencies});
 expect(first.stopReason).toBe('cancelled');expect(readProgress(path)!.budget.used).toBe(1);
 // Use a new controller for the resumed process.
 const secondController=new AbortController();activeController=secondController;
 const second=await runLeadSession('spam1',{taskConfiguration:spamConfiguration(),runId:'replacement',progressPath:path,signal:secondController.signal,dependencies});
 expect(second.resumed).toBe(true);expect(second.progress.runId).toBe('original');expect(roots[1]).toBe(roots[0]);expect(starts).toBe(1);expect(second.progress.budget.used).toBe(1);
 }finally{f.close();}
});

test('real Pi parallel batch uses hand_over as a barrier and blocks later training and mutations', async () => {
 const { fauxProvider, InMemoryCredentialStore, Type, fauxAssistantMessage, fauxToolCall, fauxText } = await import('@earendil-works/pi-ai');
 const { ModelRuntime, defineTool } = await import('@earendil-works/pi-coding-agent');
 const { createPiChildFactory } = await import('../subagents/pi.js');
 const f=fixture(); const events:string[]=[]; const counters:string[]=[]; let refits=0;
 try {
 const faux=fauxProvider({provider:'lead-barrier-fixture',tokensPerSecond:1000000});
 const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false});
 runtime.registerNativeProvider(faux.provider);
 const result=await runLeadSession('spam1',{taskConfiguration:spamConfiguration(),progressPath:join(f.root,'lead/PROGRESS.json'),dependencies:{
 prepareData:()=>f.data,readPython:()=>({prefix:f.root,executable:'/bin/false',fingerprint:'f'} as any),sandbox:()=>({executable:'/bin/false',cwd:f.root,mounts:[],env:{},agentRoot:join(f.root,'agent')} as any),
 prepareRepository:()=>({initialized:false,head:f.commit,branch:'master'}),environmentTool:()=>({name:'python_environment'} as any),
 createTraining:()=>({ready:async()=>{},close:async()=>{},tools:[],toolPrompts:[],service:{describe:()=>({})},supervisor:{list:()=>[]},bindSession:()=>{}} as any),
 scouts:()=>({tool:{name:'scout'} as any,report:async()=>{events.push('validation');return {text:'- ok: measured snapshot [experiment: measured]',roles:[{role:'validation',status:'completed',bullets:1}]};}}),
 runAgentSession:async options=>{
 const late=['start_training','write'].map(name=>defineTool({name,label:name,description:'fixture',parameters:Type.Object({}),async execute(){events.push(name);writeFileSync(join(f.root,'late-mutation'),'bad');return {content:[{type:'text',text:'ran'}],details:{}};}}));
 const tools=[options.customTools!.find(tool=>tool.name==='hand_over')!,...late];
 expect(tools[0].executionMode).toBe('sequential');
 faux.setResponses([()=>fauxAssistantMessage([fauxToolCall('hand_over',{reason:'ready'}),fauxToolCall('start_training',{}),fauxToolCall('write',{})],{stopReason:'toolUse'}),()=>fauxAssistantMessage([fauxText('done')])]);
 const child=await createPiChildFactory({cwd:f.root,agentDir:f.root,model:faux.getModel(),modelRuntime:runtime,prompts,sharedInstructions:[],childInstructions:prompts.render('team.shared',{}),customTools:tools,tools:tools.map(t=>t.name),extensionFactories:[...options.extensionFactories??[],{name:'capture-counters',factory:(pi:any)=>{pi.on('message_end',(event:any)=>{if(event.message.role==='toolResult')counters.push(JSON.stringify(event.message.content));});}}],env:{},inputs:[],observe:{identity:{},telemetry:{failures:[],record(){},async close(){}}} as any,turnTimeoutMs:null})({logicalAgentId:'lead',parentAgentRunId:'parent',spawnToolCallId:'call'},new AbortController().signal);
 try {await child.prompt(prompts.render('team.probe-question',{}));} finally {await child.close();}
 return {output:'done',agentRunId:'fixture'} as any;
 },
 refit:async()=>{events.push('refit');refits++;return {artifacts:[],validation:{valid:true,errors:[]}};},collectResults:async()=>({valid:false,trials:[],artifacts:[],errors:[]}) as any,
 }});
 expect(events).toEqual(['validation','refit']);expect(refits).toBe(1);expect(result.valid).toBe(true);
 // Admission charges emitted calls even when acceptance subsequently blocks execution.
 expect(result.progress.budget.used).toBe(3);
 expect(counters).toHaveLength(3);for(const text of counters)expect(text).toContain('3 of 80');
 expect((await import('node:fs')).existsSync(join(f.root,'late-mutation'))).toBe(false);
 } finally {f.close();}
},30000);

test('resume reconciles completion gap, authoritative champion and noise once with restricted holdout feedback', async()=>{
 const f=fixture();const path=join(f.root,'lead/PROGRESS.json');let feedback=0,confirmations=0;let finished:any;let active=new AbortController();
 const progress:LeadProgress={schemaVersion:1,taskId:'spam1',datasetSha256:undefined,runId:'original',trainingRoot:join(f.root,'training'),status:'running',startedAt:new Date().toISOString(),sessions:[],champion:{experimentId:'obsolete'},trials:[{experimentId:'measured',hypothesis:'recovered trial',status:'running',startedAt:new Date().toISOString()}],holdout:[],budget:{limit:80,used:7},scoutCalls:0};
 writeProgress(path,progress);
 f.data.holdoutSeedPlan={};f.data.split.sealedIds=['sealed'];
 const view:any={id:'measured',status:'exited',elapsedSeconds:1};
 const dependencies:any={prepareData:()=>f.data,readPython:()=>({prefix:f.root,executable:'/bin/false',fingerprint:'f'}),sandbox:()=>({executable:'/bin/false',cwd:f.root,mounts:[],env:{},agentRoot:join(f.root,'agent')}),prepareRepository:()=>({initialized:false,head:f.commit,branch:'master'}),environmentTool:()=>({name:'python_environment'}),
 createTraining:(opts:any)=>{finished=opts.onTrialFinished;return {ready:async()=>{await finished('measured',view);await finished('measured',view);},close:async()=>{},tools:[],toolPrompts:[],service:{describe:()=>({status:'completed',balancedAccuracy:1,noiseVerdict:'clear improvement',championComparison:{status:'completed'},foldScores:[{metrics:{balancedAccuracy:1}}]})},supervisor:{list:()=>[view]},bindSession:()=>{}};},
 confirm:async()=>{confirmations++;return {summary:{status:'completed',verdict:'no significant improvement',queryCount:1},privateScore:0.123456,scoutTranscript:'PRIVATE SCOUT'};},
 scouts:()=>({tool:{name:'scout'},report:async()=>{throw Error('cancelled lead must not validate');}}),refit:async()=>{throw Error('cancelled lead must not refit');},collectResults:async()=>({valid:false,trials:[],artifacts:[],errors:[]}),
 runAgentSession:async(opts:any)=>{expect(opts.prompt).toContain('clear improvement');expect(opts.prompt).toContain('measured (1.0000)');expect(opts.prompt).not.toContain('0.123456');expect(opts.prompt).not.toContain('PRIVATE SCOUT');active.abort();return {output:'cancelled',agentRunId:'fixture'};}};
 try {for(let resume=0;resume<2;resume++) {
 active=new AbortController();
 const result=await runLeadSession('spam1',{taskConfiguration:spamConfiguration(),progressPath:path,signal:active.signal,dependencies,report:{event:(type:string)=>{if(type==='lead_trial_feedback')feedback++;},input(){},agentIdentity(){return {};},observation(){return {};} } as any});
 expect(result.progress.trials).toHaveLength(1);expect(result.progress.trials[0].status).toBe('completed');expect(result.progress.trials[0].feedbackRecorded).toBe(true);expect(result.progress.champion?.experimentId).toBe('measured');expect(result.progress.budget.used).toBe(7);expect(result.progress.holdout).toHaveLength(1);
 } expect(feedback).toBe(1);expect(confirmations).toBe(1);
 }finally{f.close();}
});
