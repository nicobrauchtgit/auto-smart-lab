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
