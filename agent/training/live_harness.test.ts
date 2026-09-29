import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ExperimentSupervisor } from "../experiments/supervisor.js";
import { TrainingService } from "./service.js";
import { resolveCppRuntimeLibraryPath } from "./environment.js";
import type { Update } from "../experiments/types.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function until(predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await Bun.sleep(25);
	}
	return false;
}

function environment(): Record<string, string> {
	const values = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	const runtime = resolveCppRuntimeLibraryPath(values);
	if (runtime) values.LD_LIBRARY_PATH = runtime;
	return values;
}

test("a supervised pilot can be checked while running and produces non-promotable evidence", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "training-live-harness-"));
	const corpusRoot = join(temporary, "archive");
	const members = join(corpusRoot, "data", "train");
	mkdirSync(members, { recursive: true });
	const labels: string[] = [];
	for (let index = 0; index < 120; index++) {
		const label = index % 2;
		const id = `data/train/doc${String(index).padStart(3, "0")}.${label}`;
		const body = label === 1
			? `limited offer prize winner claim now reference ${index}`
			: `project meeting agenda minutes schedule reference ${index}`;
		writeFileSync(join(corpusRoot, id), `${body}\n`, "utf8");
		labels.push(`${id};${label}`);
	}
	const zipPath = join(temporary, "train.zip");
	execFileSync(join(PROJECT_ROOT, ".venv", "bin", "python"), [
		"-c",
		"import pathlib, zipfile; root = pathlib.Path('data'); archive = zipfile.ZipFile(__import__('sys').argv[1], 'w'); [archive.write(path, path.as_posix()) for path in root.rglob('*') if path.is_file()]; archive.close()",
		zipPath,
	], { cwd: corpusRoot });
	const labelsPath = join(temporary, "train.labels");
	writeFileSync(labelsPath, `${labels.join("\n")}\n`, "utf8");

	const updates: Update[] = [];
	const supervisor = new ExperimentSupervisor({
		root: join(temporary, "experiments"),
		env: environment(),
		deliver: (_text, update) => { updates.push(update); },
		limits: { sampleIntervalMs: 25, updateIntervalMs: 100, stopGraceMs: 1_000 },
	});
	try {
		const service = new TrainingService({
			supervisor,
			pythonExecutable: join(PROJECT_ROOT, ".venv", "bin", "python"),
			projectRoot: PROJECT_ROOT,
			trainingRoot: join(temporary, "experiments"),
			taskId: "synthetic-smoke",
			datasetSha256: createHash("sha256").update(readFileSync(zipPath)).update(readFileSync(labelsPath)).digest("hex"),
			rootSeed: 13,
			zipPath,
			labelsPath,
			allowedModuleRoots: ["agent/training/python/fixtures"],
		});
		const started = await service.start({
			schemaVersion: 1,
			hypothesis: "word and bigram features separate the synthetic classes",
			pipeline: {
				module: "agent/training/python/fixtures/smoke_pipeline.py",
				factory: "build_pipeline",
				parameters: { c: 1.0 },
			},
			cv: { kind: "builtin", scheme: "stratified_kfold", folds: 3, repeats: 1 },
			scope: { kind: "pilot", maxRows: 60, maxFolds: 2 },
		}, "live-smoke");

		// This is the behavior the old blocking fit could not provide.
		expect(supervisor.status(started.id).status).toBe("running");
		expect(await until(() => supervisor.status(started.id).linesEmitted > 0)).toBe(true);
		const during = supervisor.status(started.id);
		expect(during.linesEmitted).toBeGreaterThan(0);
		expect(await until(() => supervisor.status(started.id).status !== "running")).toBe(true);

		const result = JSON.parse(readFileSync(join(started.directory, "trial-result.json"), "utf8"));
		expect(result.status).toBe("completed");
		expect(result.scope).toBe("pilot");
		expect(result.completedFolds).toBe(2);
		expect(result.promotionEligible).toBe(false);
		expect(result.metrics.balancedAccuracy).toBe(1);
		const events = readFileSync(join(started.directory, "events.jsonl"), "utf8")
			.trim().split("\n").map((line) => JSON.parse(line));
		expect(events.findIndex((event) => event.type === "folds_materialized"))
			.toBeLessThan(events.findIndex((event) => event.type === "fold_started"));
		expect(updates.some((update) => update.kind === "progress" || update.kind === "exited")).toBe(true);
	} finally {
		await supervisor.close();
	}
}, 40_000);
