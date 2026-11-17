import {mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, statfsSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {ExperimentSupervisor} from '../../../harness/finetuned/agent/experiments/supervisor.ts';
const root=resolve(import.meta.dir,'../../..'), arm=process.argv[2];
if(!['minimal','finetuned'].includes(arm))throw new Error('Expected arm');
const here=join(import.meta.dir,process.argv[3],arm);mkdirSync(here,{recursive:true});
const tasks=[process.argv[3]];
if(!['documents1','documents2','documents3','documents4','code1','code2','code3','attacks1'].includes(tasks[0]))throw new Error('Unexpected task');
const sharedBytes=readFileSync(join(root,'experiment.config.json'));
const shared=JSON.parse(sharedBytes.toString());
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const codeSHA=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
if(shared.online!==false || shared.model.provider!=='mythllm' || shared.model.id!=='qwen3.8-flash-next-a5b')throw new Error('Unexpected experiment configuration');
// 'resume' (4th argument) continues an interrupted lead run in place: PROGRESS.json must say running.
const resume=process.argv[4]==='resume';
for(const name of tasks)if(arm==='finetuned' && existsSync(join(root,'runs/finetuned',name)) && !(resume && JSON.parse(readFileSync(join(root,'runs/finetuned',name,'lead/PROGRESS.json'),'utf8')).status==='running'))throw new Error('Prior task/solutions state present; refusing resume');
const write=(name:string,value:unknown)=>{const dest=join(here,name);writeFileSync(dest+'.tmp',JSON.stringify(value,null,2)+'\n');renameSync(dest+'.tmp',dest);};
const status:any={controllerPid:process.pid,startedAt:new Date().toISOString(),state:'running',codeSHA,online:false,model:shared.model,sharedConfigSHA256:sha(sharedBytes),tasks:[],arm,policy:'Continue original minimal spam state in place; configured budgets; no extra deadline; no uploads/submissions; 2 GiB disk reserve; supervised descendants only'};
mkdirSync(join(here,'tmp'),{recursive:true});
const env=Object.fromEntries(Object.entries(process.env).filter((x):x is [string,string]=>x[1]!==undefined));env.TMPDIR=join(here,'tmp');
const supervisor=new ExperimentSupervisor({root:join(here,'supervision'),env,deliver:()=>{},record:(event,payload)=>appendFileSync(join(here,'controller-events.jsonl'),JSON.stringify({at:new Date().toISOString(),event,payload})+'\n')});
let requestedStop=false;
for(const signal of ['SIGTERM','SIGINT'] as const)process.once(signal,()=>{requestedStop=true;});
write('launch.json',status);write('status.json',status);
try{
 for(const task of tasks){
  if(requestedStop)throw new Error('operator stop');
  if(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()!==codeSHA || sha(readFileSync(join(root,'experiment.config.json')))!==status.sharedConfigSHA256)throw new Error('Source/config changed between tasks; no next task launched');
  const run=supervisor.start({argv:arm==='minimal'?['./dev','bun','run','experiment','--','--arm','minimal','--continue','runs/minimal/2026-11-11T08-29-56','--only',task]:['./dev','bun','run','experiment','--','--arm','finetuned','--no-fetch',task],cwd:root,hypothesis:`Complete offline ${task} with configured ${arm} harness`,scope:'Full task completion under configured harness budgets; no additional diagnostic deadline'});
  const row:any={task,startedAt:new Date().toISOString(),state:'running',supervisorId:run.id,logPath:run.logPath};status.tasks.push(row);status.currentTask=task;write('status.json',status);
  for(;;){
   let view=supervisor.status(run.id);row.view=view;
   const disk=statfsSync(root),memory=readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+)/m);
   appendFileSync(join(here,'health.jsonl'),JSON.stringify({at:new Date().toISOString(),task,diskAvailableBytes:disk.bavail*disk.bsize,memAvailableKiB:memory?.[1],rssMb:view.rssMb,processes:view.processes})+'\n');
   status.updatedAt=new Date().toISOString();write('status.json',status);
   if(view.status!=='running')break;
   if(requestedStop || disk.bavail*disk.bsize<2*1024**3){view=await supervisor.stop(run.id,requestedStop?'operator stop':'disk reserve below 2 GiB');row.view=view;row.safetyStop=true;break;}
   await new Promise(r=>setTimeout(r,5000));
  }
  row.finishedAt=new Date().toISOString();row.state='exited';
  if(arm==='minimal'){
   const text=readFileSync(row.logPath,'utf8');const match=text.match(/^\[experiment\] run location: (.+)$/m);
   row.validated=false;
   if(match){
    const runRoot=resolve(match[1]);if(dirname(runRoot)!==join(root,'runs/minimal'))throw new Error('Unexpected run boundary');row.runLocation=runRoot;
    const summaryRoot=join(runRoot,'logs/solve-units');
    const summaries=existsSync(summaryRoot)?(await import('node:fs')).readdirSync(summaryRoot).map(name=>join(summaryRoot,name,'summary.json')).filter(existsSync):[];
    if(summaries.length){
     summaries.sort().reverse();
     const summary=JSON.parse(readFileSync(summaries[0],'utf8'));const result=summary.results?.find((r:any)=>r.id===task);row.outcome=result?.outcome;
     if(result?.delivery){
      const folder=resolve(runRoot,result.delivery.dir),manifest=JSON.parse(readFileSync(join(folder,'manifest.json'),'utf8'));
      row.delivery=join(folder,'output.csv');row.deliveryRows=manifest.lines;row.localScore=result.delivery.local;row.manifestPath=join(folder,'manifest.json');
      row.validated=row.view.status==='exited' && row.view.exitCode===0 && result.outcome==='delivered' && result.exitCode===0 && folder.startsWith(runRoot+'/logs/deliveries/') && existsSync(join(folder,'source.zip')) && manifest.task===task && sha(readFileSync(row.delivery))===manifest.sha256;
     }
    }
   }
  }else{
  const progressPath=join(root,'runs/finetuned',task,'lead/PROGRESS.json');
  const progress=existsSync(progressPath)?JSON.parse(readFileSync(progressPath,'utf8')):{};
  row.runId=progress.runId;row.progressPath=progressPath;row.progressStatus=progress.status;row.delivery=progress.delivery;
  const delivery=typeof progress.delivery==='string'?resolve(progress.delivery):'';
  const deliveryRoot=join(root,'runs/finetuned/deliveries',task)+ '/';
  row.validated=false;
  if(row.view.status==='exited' && row.view.exitCode===0 && progress.status==='handed_over' && delivery.startsWith(deliveryRoot)){
   const folder=dirname(delivery), manifestPath=join(folder,'manifest.json');
   if(existsSync(delivery)&&existsSync(manifestPath)&&existsSync(join(folder,'source.zip'))){
    const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));const bytes=readFileSync(delivery);const lines=bytes.toString().trim().split('\n');
    row.validated=manifest.task===task && manifest.arm==='harness' && sha(bytes)===manifest.sha256 && lines.length===manifest.lines && lines.every(line=>(task.startsWith('code')?/;-?\d+$/:/;[01]$/).test(line)) && readFileSync(row.logPath,'utf8').includes('[pipeline] Outcome: success');
    row.deliveryIdentity=manifest.identity;row.deliveryRows=lines.length;row.solutionCommit=manifest.solutionCommit;
   }
  }
  }
  row.state=row.validated?'succeeded':'failed';write(`${task}-receipt.json`,row);write('status.json',status);
  if(!row.validated)throw new Error(`${task} failed setup, execution or delivery verification; no later task launched`);
 }
 status.state='succeeded';
}catch(error){status.state=requestedStop?'stopped':'failed';status.reason=error instanceof Error&&/^(operator stop|Source\/config changed|documents1 failed)/.test(error.message)?error.message:'Controller stopped on a local error; inspect retained execution receipts';}
finally{await supervisor.close();status.finishedAt=new Date().toISOString();write('status.json',status);write('exit.json',{state:status.state,finishedAt:status.finishedAt,exitCode:status.state==='succeeded'?0:1});}
process.exitCode=status.state==='succeeded'?0:1;
