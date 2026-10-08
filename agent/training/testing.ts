/** Fixtures for live training tests: a tiny corpus and a temporary project with a solutions repository. */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureSolutionsRepository, git } from "./git.js";

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PYTHON = join(resolve(PROJECT_ROOT, process.env.VENV_DIR ?? ".venv"), "bin", "python");
export const WORKER = join(PROJECT_ROOT, "agent", "training", "python", "worker.py");

export async function until(predicate: () => boolean, timeoutMs = 30_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await Bun.sleep(25);
	}
	return false;
}

export function trainingEnvironment(): Record<string, string> {
	const values = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	);
	return values;
}

/** A separable two-class corpus zipped like the real development archive. */
export function writeCorpus(root: string, rows = 120): { zipPath: string; labelsPath: string; datasetSha256: string } {
	const corpusRoot = join(root, "archive");
	const members = join(corpusRoot, "data", "train");
	mkdirSync(members, { recursive: true });
	const labels: string[] = [];
	for (let index = 0; index < rows; index++) {
		const label = index % 2;
		const id = `data/train/doc${String(index).padStart(3, "0")}.${label}`;
		const body = label === 1
			? `limited offer prize winner claim now reference ${index}`
			: `project meeting agenda minutes schedule reference ${index}`;
		writeFileSync(join(corpusRoot, id), `${body}\n`, "utf8");
		labels.push(`${id};${label}`);
	}
	const zipPath = join(root, "train.zip");
	execFileSync(PYTHON, [
		"-c",
		"import pathlib, sys, zipfile; root = pathlib.Path('data'); archive = zipfile.ZipFile(sys.argv[1], 'w'); [archive.write(path, path.as_posix()) for path in sorted(root.rglob('*')) if path.is_file()]; archive.close()",
		zipPath,
	], { cwd: corpusRoot });
	const labelsPath = join(root, "train.labels");
	writeFileSync(labelsPath, `${labels.join("\n")}\n`, "utf8");
	const datasetSha256 = createHash("sha256").update(readFileSync(zipPath)).update(readFileSync(labelsPath)).digest("hex");
	return { zipPath, labelsPath, datasetSha256 };
}

/**
 * Raw sample input for a corpus: an `{archive, member}` manifest with 0/1
 * targets, as solve writes it, and the matching training measurement.
 */
export function writeSampleManifest(root: string, zipPath: string, labelsPath: string) {
	const samples = readFileSync(labelsPath, "utf8").trim().split("\n").map(line => {
		const [id, label] = [line.slice(0, line.lastIndexOf(";")), line.slice(line.lastIndexOf(";") + 1)];
		return { id, input: { archive: zipPath, member: id }, target: Number(label) };
	});
	const sampleManifestPath = join(root, "development-samples.json");
	writeFileSync(sampleManifestPath, `${JSON.stringify({ schemaVersion: 1, samples })}\n`);
	const datasetSha256 = createHash("sha256").update(readFileSync(zipPath)).update(readFileSync(sampleManifestPath)).digest("hex");
	return { sampleManifestPath, datasetSha256, measurement: { kind: "classification" as const, execution: "inductive" as const, sampleManifestPath } };
}

/** A text pipeline whose feature helper lives in a separate module, imported as `solutions.features`. */
export const FEATURES_MODULE = `
import time
from sklearn.base import BaseEstimator, TransformerMixin

class TextColumn(BaseEstimator, TransformerMixin):
    def __init__(self, delay=0.0):
        self.delay = delay

    def fit(self, frame, y=None):
        if self.delay:
            time.sleep(self.delay)
        return self

    def transform(self, frame):
        # Raw sample input: read each member's bytes, as agent code does in production.
        if "input" in frame:
            import zipfile
            texts = []
            for descriptor in frame["input"]:
                with zipfile.ZipFile(descriptor["archive"]) as archive:
                    texts.append(archive.read(descriptor["member"]).decode("utf-8", "replace"))
            return texts
        return frame["text"]
`;

/**
 * `jobs > 1` fits the feature union in joblib worker processes, which
 * re-import `solutions.features` from disk.
 */
export const PIPELINE_MODULE = `
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import FeatureUnion, Pipeline

from solutions.features import TextColumn


def build_pipeline(context):
    parameters = context["parameters"] if isinstance(context.get("parameters"), dict) else {}
    words = Pipeline([
        ("text", TextColumn(delay=parameters.get("delay", 0.0))),
        ("tfidf", TfidfVectorizer(ngram_range=(1, parameters.get("ngrams", 1)))),
    ])
    return Pipeline([
        ("features", FeatureUnion([("words", words)], n_jobs=parameters.get("jobs", 1))),
        ("model", LogisticRegression(C=parameters.get("c", 1.0), max_iter=200)),
    ])
`;

/** A temporary project whose `solutions/` is a fresh repository with the fixture pipeline committed. */
export function temporaryProject(prefix = "training-project-") {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const solutionsRoot = join(root, "solutions");
	mkdirSync(join(solutionsRoot, "tasks"), { recursive: true });
	writeFileSync(join(solutionsRoot, "__init__.py"), "");
	writeFileSync(join(solutionsRoot, "features.py"), FEATURES_MODULE);
	writeFileSync(join(solutionsRoot, "tasks", "fixture.py"), PIPELINE_MODULE);
	const repository = ensureSolutionsRepository(solutionsRoot);
	return { root, solutionsRoot, head: repository.head!, ...writeCorpus(root) };
}

export function commitAll(solutionsRoot: string, message: string): string {
	for (const args of [["add", "-A"], ["commit", "--quiet", "-m", message]]) {
		const result = git(solutionsRoot, args);
		if (result.status !== 0) throw new Error(result.stderr);
	}
	return git(solutionsRoot, ["rev-parse", "HEAD"]).stdout.trim();
}
