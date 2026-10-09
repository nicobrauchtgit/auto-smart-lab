import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createSeedPlan, deriveTrialSeed, serializeSeedPlan } from "../training/seeds.js";
import { collectTrainingResults } from "../training/results.js";
import { artifact, prepareEvidence } from "./evidence.js";
import { championSelection } from "../training/development_selection.js";
import { git, tagCommit } from "../training/git.js";
import { commitAll } from "../training/testing.js";
import { curveSvg } from "./curves.js";

// Actual harness fits a tiny fixed dummy model; evaluation itself never fits.
test("real harness trial becomes verified review evidence; changed artifacts and wrong task fail", async () => {
 const root = mkdtempSync(join(tmpdir(), 'evaluation-evidence-'));
 const python = resolve(process.env.VENV_DIR ?? '.venv', 'bin/python');
 const worker = resolve('agent/training/python/worker.py');
 try {
  const directory = join(root, 'training', 'fixture');
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(root, 'solutions'));
  writeFileSync(join(root, 'solutions/model.py'), 'from sklearn.dummy import DummyClassifier\ndef build_pipeline():\n return DummyClassifier(strategy="most_frequent")\n');
  const repository = join(root, 'solutions');
  git(repository, ['init', '--quiet', '-b', 'main']); git(repository, ['config', 'user.email', 'fixture@example.invalid']); git(repository, ['config', 'user.name', 'fixture']);
  const commit = commitAll(repository, 'Fixture pipeline'), tree = git(repository, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
  const zip = join(root, 'train.zip'), labels = join(root, 'dev.labels');
  writeFileSync(labels, Array.from({ length: 8 }, (_, i) => `row-${i};${i % 2}\n`).join(''));
  const made = spawnSync(python, ['-c', 'import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1], "w") as z:\n for i in range(8): z.writestr(f"row-{i}", f"text {i}")', zip], { encoding: 'utf8' });
  expect(made.status).toBe(0);
  const manifest = join(root, 'samples.json');
  writeFileSync(manifest, JSON.stringify({ schemaVersion: 1, samples: Array.from({ length: 8 }, (_, i) =>
   ({ id: `row-${i}`, input: { archive: zip, member: `row-${i}` }, target: i % 2 })) }));
  const measurement = { kind: 'classification', execution: 'inductive', sampleManifestPath: manifest, sampleManifestSha256: createHash('sha256').update(readFileSync(manifest)).digest('hex'), hasTargets: true };
  const request = { schemaVersion: 1, hypothesis: 'fixture', pipeline: { module: 'solutions/model.py', factory: 'build_pipeline' }, cv: { kind: 'builtin', scheme: 'stratified_kfold', folds: 2, repeats: 1 }, scope: { kind: 'promotion' } };
  const seeds = createSeedPlan({ rootSeed: 1, taskId: 'fixture-task', datasetSha256: 'a'.repeat(64), experimentId: 'fixture' });
  writeFileSync(join(directory, 'seed-plan.json'), serializeSeedPlan(seeds));
  writeFileSync(join(directory, 'request.json'), JSON.stringify(request));
  writeFileSync(join(directory, 'invocation.json'), JSON.stringify({ schemaVersion: 1, experimentId: 'fixture', request, measurement,
   inputs: { projectRoot: root, zipPath: zip, labelsPath: labels, outputDir: directory }, source: { commit, tree, repository },
   seeds: { experiment: seeds.experimentSeed, trial: deriveTrialSeed(seeds, 0) } }));
  const trained = spawnSync(python, [worker, '--invocation', join(directory, 'invocation.json')], { encoding: 'utf8', timeout: 30_000 });
  if (trained.status !== 0) throw new Error(trained.stderr);
  // Evaluation reviews only the tagged champion.
  await expect(prepareEvidence([artifact('training_selected_result', join(directory, 'trial-result.json'))], new AbortController().signal, 'fixture-task')).rejects.toThrow('not the current champion');
  tagCommit(repository, 'champion/fixture-task', commit, JSON.stringify({ experimentId: 'fixture', pipeline: request.pipeline, trainingRoot: join(root, 'training') }), true);
  const collection = await championSelection(await collectTrainingResults(join(root, 'training')), repository, 'fixture-task');
  expect(collection.selected?.experimentId).toBe('fixture');
  const upstream = [...collection.artifacts, artifact('training_selected_result', join(directory, 'trial-result.json'))];
  const evidence = await prepareEvidence(upstream, new AbortController().signal, 'fixture-task');
  expect(evidence.diagnostics.summary.balancedAccuracy).toBe(.5);
  expect(evidence.diagnostics.summary.uniqueRows).toBe(8);
  expect(evidence.diagnostics.curves.rocAuc).toBe(.5);
  expect(curveSvg(evidence.diagnostics.curves)).toContain('<svg');
  expect(curveSvg({ available: false })).toBeUndefined();
  await expect(prepareEvidence(upstream, new AbortController().signal, 'wrong-task')).rejects.toThrow('not the current champion');
  const oof = join(directory, 'oof_predictions.csv');
  writeFileSync(oof, readFileSync(oof, 'utf8') + '\n');
  await expect(prepareEvidence(upstream, new AbortController().signal, 'fixture-task')).rejects.toThrow('changed upstream');
 } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
