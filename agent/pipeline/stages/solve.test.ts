import { describe, expect, test } from "bun:test";
import { spamConfiguration } from "../task_configuration.testing.js";

import { listTasks } from "../resolve_task.js";
import { entrypointArtifact, solveStage } from "./solve.js";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { temporaryProject } from "../../training/testing.js";
import type { TrainingTrialResult } from "../../training/results.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RESEARCH = join(mkdtempSync(join(tmpdir(), "solve-stage-research-")), "research.md");
writeFileSync(RESEARCH, "# Research\n");

describe("solve stage options", () => {
	test("applies defaults", () => {
		expect(solveStage.parseOptions(undefined)).toEqual({
			maxIterations: 6, seed: 13, foldPolicy: "auto",
			experimentUpdateIntervalSeconds: 30,
		});
	});

	test("accepts an explicit fold policy", () => {
		expect(solveStage.parseOptions({ foldPolicy: { folds: 10, repeats: 3 } }).foldPolicy)
			.toEqual({ folds: 10, repeats: 3 });
	});

	test("accepts a routine experiment update interval", () => {
		expect(solveStage.parseOptions({ experimentUpdateIntervalSeconds: 45 }).experimentUpdateIntervalSeconds).toBe(45);
	});

	test("rejects unknown options rather than ignoring them", () => {
		expect(() => solveStage.parseOptions({ maxIteration: 3 })).toThrow(/unknown solve options: maxIteration/);
		expect(() => solveStage.parseOptions({ foldPolicy: { folds: 5, repeat: 1 } })).toThrow(/foldPolicy keys/);
	});

	test("rejects values that would produce an unusable run", () => {
		expect(() => solveStage.parseOptions({ maxIterations: 0 })).toThrow(/maxIterations/);
		expect(() => solveStage.parseOptions({ maxIterations: 1.5 })).toThrow(/maxIterations/);
		expect(() => solveStage.parseOptions({ sealedFraction: 0 })).toThrow(/sealedFraction/);
		expect(() => solveStage.parseOptions({ sealedFraction: 0.6 })).toThrow(/sealedFraction/);
		expect(() => solveStage.parseOptions({ seed: 1.5 })).toThrow(/seed/);
		expect(() => solveStage.parseOptions({ experimentUpdateIntervalSeconds: 0 })).toThrow(/experimentUpdateIntervalSeconds/);
		expect(() => solveStage.parseOptions({ experimentUpdateIntervalSeconds: 1.5 })).toThrow(/experimentUpdateIntervalSeconds/);
		expect(() => solveStage.parseOptions({ foldPolicy: { folds: 1, repeats: 1 } })).toThrow(/at least 2/);
		expect(() => solveStage.parseOptions("auto")).toThrow(/must be an object/);
	});

	test("is wired into the chain after research", () => {
		expect(solveStage.name).toBe("solve");
		expect(solveStage.next).toBe("evaluate");
	});
});

const hasSpamData = listTasks().some(task => task.taskId === "spam1" && task.hasData);
const fetchReason = "requires fetched units/01-spam: ./dev bun run fetch-unit -- 01-spam";

describe("solve stage input contract", () => {
	test("rejects a task with no local dataset", () => {
		expect(() => solveStage.checkInput({ taskId: "does-not-exist", upstream: [] })).toThrow();
	});

	test.skipIf(!hasSpamData)(`rejects a run with no research document upstream (${fetchReason})`, () => {
		expect(() => solveStage.checkInput({ taskId: "spam1", taskConfiguration: spamConfiguration(), upstream: [] }))
			.toThrow(/no research document upstream/);
	});

	test.skipIf(!hasSpamData)(`rejects an upstream research document that is not on disk (${fetchReason})`, () => {
		expect(() => solveStage.checkInput({
			taskId: "spam1", taskConfiguration: spamConfiguration(),
			upstream: [{ kind: "research_document", path: "/nonexistent/research.md" }],
		})).toThrow(/no research document upstream/);
	});

	test.skipIf(!hasSpamData)(`accepts a task with data and a real research document (${fetchReason})`, () => {
		expect(() => solveStage.checkInput({
			taskId: "spam1", taskConfiguration: spamConfiguration(),
			upstream: [{ kind: "research_document", path: RESEARCH }],
		})).not.toThrow();
	});
});

describe("solve entrypoint artifact", () => {
	test("is hashed while it matches the selected trial's commit, and withheld once edited", () => {
		const project = temporaryProject("solve-entrypoint-");
		const module = "solutions/tasks/fixture.py";
		const selected = {
			experimentId: "trial", directory: project.root, valid: true, eligible: true, errors: [], artifacts: [],
			request: { pipeline: { module, factory: "build_pipeline" } },
			invocation: { source: { commit: project.head, repository: project.solutionsRoot } },
		} as unknown as TrainingTrialResult;
		const path = join(project.root, module);
		expect(entrypointArtifact(selected)).toEqual({
			kind: "solve_entrypoint", path, bytes: readFileSync(path).length,
			sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
		});
		writeFileSync(path, `${readFileSync(path, "utf8")}\n# edited after the trial\n`);
		expect(entrypointArtifact(selected)).toEqual({ mismatch: `${module} differs from commit ${project.head.slice(0, 12)}` });
		expect(entrypointArtifact(undefined)).toBeUndefined();
	});
});
