import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { deliverRefit, type RefitOptions } from "./service.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "delivery-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function fixture(predictions: string, name: string) {
	const directory = join(base, name, "refit");
	const source = join(directory, "source/solutions");
	mkdirSync(join(source, ".git"), { recursive: true });
	mkdirSync(join(source, "tasks"), { recursive: true });
	writeFileSync(join(source, "tasks/spam1.py"), "code\n");
	writeFileSync(join(source, ".git/config"), "ignored\n");
	writeFileSync(join(directory, "predictions.csv"), predictions);
	writeFileSync(join(directory, "freeze.json"), JSON.stringify({ taskId: "spam1", identity: "abcdef0123456789", chosenExperimentId: "exp", source: { commit: "c1" },
		sourceRoot: join(directory, "source"), inputs: { task: { predictions: "binary" } }, data: { testIds: ["a.txt", "b.txt"] } }));
	const options = { taskId: "spam1", projectRoot: join(base, name), pythonExecutable: join(import.meta.dir, "../../.venv/bin/python"), env: {}, model: "m/x" } as unknown as RefitOptions;
	return { options, freeze: { directory, identity: "abcdef0123456789" } };
}

test("writes the official format, a code archive and a manifest", () => {
	const { options, freeze } = fixture("id,prediction\nb.txt,1\na.txt,0\n", "ok");
	const artifact = deliverRefit(options, freeze);
	expect(artifact.kind).toBe("final_delivery");
	expect(artifact.path).toBe(join(base, "ok/runs/deliveries/spam1/abcdef012345/output.csv"));
	expect(readFileSync(artifact.path, "utf8")).toBe("a.txt;0\nb.txt;1\n");
	const manifest = JSON.parse(readFileSync(join(artifact.path, "../manifest.json"), "utf8"));
	expect(manifest).toMatchObject({ arm: "harness", task: "spam1", model: "m/x", experiment: "exp", lines: 2, sha256: artifact.sha256 });
	const list = spawnSync(options.pythonExecutable, ["-m", "zipfile", "-l", join(artifact.path, "../source.zip")], { encoding: "utf8" }).stdout;
	expect(list).toContain("tasks/spam1.py");
	expect(list).not.toContain(".git");
});

test("records the advisory review, and whether it reviewed the delivered candidate", () => {
	const { options, freeze } = fixture("id,prediction\na.txt,0\nb.txt,1\n", "reviewed");
	const reviewPath = join(base, "reviewed/review.json");
	writeFileSync(reviewPath, JSON.stringify({ experimentId: "exp", validation: { valid: true }, review: { readinessScore: 3, status: "concerns",
		readinessRationale: "two medium concerns", concerns: [{ severity: "medium", finding: "gap unexplained", evidence: "e" }], recommendations: ["check duplicates"] } }));
	const artifact = deliverRefit({ ...options, reviewPath }, freeze);
	const manifest = JSON.parse(readFileSync(join(artifact.path, "../manifest.json"), "utf8"));
	expect(manifest.review).toMatchObject({ readinessScore: 3, status: "concerns", sameExperimentAsDelivered: true, advisoryOnly: true });
	expect(manifest.review.concerns[0].severity).toBe("medium");

	writeFileSync(reviewPath, JSON.stringify({ experimentId: "older", validation: { valid: true }, review: { readinessScore: 5, status: "reviewed", concerns: [], recommendations: [] } }));
	const other = deliverRefit({ ...options, projectRoot: join(base, "reviewed-other"), reviewPath }, freeze);
	expect(JSON.parse(readFileSync(join(other.path, "../manifest.json"), "utf8")).review.sameExperimentAsDelivered).toBe(false);
});

test("a run without evaluation records no review", () => {
	const { options, freeze } = fixture("id,prediction\na.txt,0\nb.txt,1\n", "unreviewed");
	const artifact = deliverRefit(options, freeze);
	expect(JSON.parse(readFileSync(join(artifact.path, "../manifest.json"), "utf8")).review).toBeNull();
});

test.each([
	["missing id", "id,prediction\na.txt,0\n"],
	["extra id", "id,prediction\na.txt,0\nb.txt,1\nc.txt,1\n"],
	["duplicate id", "id,prediction\na.txt,0\na.txt,1\nb.txt,1\n"],
	["bad label", "id,prediction\na.txt,0\nb.txt,2\n"],
	["bad columns", "name,label\na.txt,0\nb.txt,1\n"],
])("refuses predictions with a %s", (name, predictions) => {
	const { options, freeze } = fixture(predictions, name.replace(" ", "-"));
	expect(() => deliverRefit(options, freeze)).toThrow("Refit validation failed");
});
