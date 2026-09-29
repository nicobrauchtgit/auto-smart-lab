import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { PROJECT_ROOT } from "../pipeline/resolve_task.js";
import type { PythonEnvironment } from "./python_environment.js";
import { runHarnessSolveSession, type HarnessSolveDependencies } from "./harness_solve_session.js";

const pythonEnvironment = (): PythonEnvironment => ({
	schema_version: 1, python_version: "3.13", executable: join(PROJECT_ROOT, ".venv/bin/python"),
	prefix: join(PROJECT_ROOT, ".venv"), packages: [], declared_dependencies: [],
	project_sha256: "a".repeat(64), lock_sha256: "b".repeat(64), fingerprint: "c".repeat(64),
	healthy: true, lock_current: true, environment_matches_lock: true, dependency_errors: "",
});

test("an agent-authored pipeline deliberately starts the harness-owned promotion fit", async () => {
	const root = mkdtempSync(join(tmpdir(), "agent-harness-live-"));
	const archiveRoot = join(root, "archive");
	const members = join(archiveRoot, "data", "train");
	mkdirSync(members, { recursive: true });
	const labels: string[] = [];
	for (let index = 0; index < 40; index++) {
		const label = index % 2;
		const id = `data/train/doc${String(index).padStart(3, "0")}.${label}`;
		writeFileSync(join(archiveRoot, id), label ? `winner prize offer ${index}\n` : `meeting agenda project ${index}\n`);
		labels.push(`${id};${label}`);
	}
	const zipPath = join(root, "train.zip");
	execFileSync(join(PROJECT_ROOT, ".venv/bin/python"), ["-c",
		"import pathlib,sys,zipfile; r=pathlib.Path('data'); z=zipfile.ZipFile(sys.argv[1],'w'); [z.write(p,p.as_posix()) for p in r.rglob('*') if p.is_file()]; z.close()",
		zipPath], { cwd: archiveRoot });
	const labelsPath = join(root, "train.labels");
	writeFileSync(labelsPath, `${labels.join("\n")}\n`);
	const taskPath = join(root, "task.md");
	const researchDir = join(root, "research");
	mkdirSync(researchDir);
	writeFileSync(taskPath, "Classify spam with balanced accuracy.\n");
	writeFileSync(join(researchDir, "research.md"), "# Research\n");

	const unique = basename(root).replace(/[^a-zA-Z0-9_]/g, "_");
	const module = `solutions/tasks/${unique}.py`;
	const modulePath = join(PROJECT_ROOT, module);
	mkdirSync(join(PROJECT_ROOT, "solutions/tasks"), { recursive: true });
	const workspace = {
		root, solutionsRoot: join(PROJECT_ROOT, "solutions"), entrypointPath: modulePath, taskPath, researchDir,
		devLabelsPath: labelsPath, fullLabelsPath: labelsPath, devZip: zipPath,
		sealedPath: join(root, "sealed.txt"), trainZip: zipPath, datasetPaths: [zipPath],
		split: { sealedIds: [], devRows: [], fraction: 0.1, seed: 13, sha256: "d".repeat(64) },
		recommendation: { scheme: "stratified_kfold" as const, folds: 2, repeats: 1, rationale: "fixture" },
		rowCount: 40, classBalance: "class 0 20, class 1 20", researchState: "research available",
		researchDocumentSha256: "e".repeat(64),
	};

	const dependencies: Partial<HarnessSolveDependencies> = {
		prepareWorkspace: () => workspace,
		readPython: pythonEnvironment,
		runAgentSession: async (options) => {
			// This write represents the model agent authoring the implementation.
			writeFileSync(modulePath, `from sklearn.feature_extraction.text import TfidfVectorizer\nfrom sklearn.linear_model import LogisticRegression\nfrom sklearn.pipeline import FunctionTransformer, Pipeline\n\ndef build_pipeline(context):\n    return Pipeline([("text", FunctionTransformer(lambda frame: frame["text"], validate=False)), ("tfidf", TfidfVectorizer()), ("model", LogisticRegression(max_iter=200))])\n`);
			const start = options.customTools?.find((tool) => tool.name === "experiment_start");
			const status = options.customTools?.find((tool) => tool.name === "experiment_status");
			expect(start).toBeDefined();
			expect(status).toBeDefined();
			const started = await start!.execute("agent-tool-1", {
				schemaVersion: 1,
				hypothesis: "word features separate the synthetic classes",
				pipeline: { module, factory: "build_pipeline", parameters: {} },
				cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 },
				scope: { kind: "promotion" },
			}, undefined as never);
			const id = JSON.parse(started.content[0].type === "text" ? started.content[0].text : "{}").id;
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				const view = await status!.execute("agent-tool-2", { id }, undefined as never);
				const state = JSON.parse(view.content[0].type === "text" ? view.content[0].text : "{}");
				if (state.status !== "running") break;
				await Bun.sleep(25);
			}
			return { output: "promotion complete", agentRunId: "agent-live" };
		},
	};

	try {
		const result = await runHarnessSolveSession("synthetic", undefined, {
			runId: "live-stage", maxTrials: 1, dependencies,
		});
		expect(result.valid).toBe(true);
		expect(result.collection.selected?.request?.pipeline.module).toBe(module);
		expect(result.collection.selected?.result?.promotionEligible).toBe(true);
		expect(result.collection.selected?.result?.completedFolds).toBe(2);
	} finally {
		try { unlinkSync(modulePath); } catch {}
	}
}, 40_000);
