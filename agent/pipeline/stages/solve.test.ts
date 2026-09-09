import { describe, expect, test } from "bun:test";

import { solveStage } from "./solve.js";
import { PROJECT_ROOT } from "../resolve_task.js";
import { join } from "node:path";

const RESEARCH = join(PROJECT_ROOT, "runs", "spam1", "research", "research.md");

describe("solve stage options", () => {
	test("applies defaults", () => {
		expect(solveStage.parseOptions(undefined)).toEqual({
			maxIterations: 6, sealedFraction: 0.1, seed: 13, foldPolicy: "auto",
		});
	});

	test("accepts an explicit fold policy", () => {
		expect(solveStage.parseOptions({ foldPolicy: { folds: 10, repeats: 3 } }).foldPolicy)
			.toEqual({ folds: 10, repeats: 3 });
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
		expect(() => solveStage.parseOptions({ foldPolicy: { folds: 1, repeats: 1 } })).toThrow(/at least 2/);
		expect(() => solveStage.parseOptions("auto")).toThrow(/must be an object/);
	});

	test("is wired into the chain after research", () => {
		expect(solveStage.name).toBe("solve");
		expect(solveStage.next).toBe("evaluate");
	});
});

describe("solve stage input contract", () => {
	test("rejects a task with no local dataset", () => {
		expect(() => solveStage.checkInput({ taskId: "does-not-exist", upstream: [] })).toThrow();
	});

	test("rejects a run with no research document upstream", () => {
		expect(() => solveStage.checkInput({ taskId: "spam1", upstream: [] }))
			.toThrow(/no research document upstream/);
	});

	test("rejects an upstream research document that is not on disk", () => {
		expect(() => solveStage.checkInput({
			taskId: "spam1",
			upstream: [{ kind: "research_document", path: "/nonexistent/research.md" }],
		})).toThrow(/no research document upstream/);
	});

	test("accepts a task with data and a real research document", () => {
		expect(() => solveStage.checkInput({
			taskId: "spam1",
			upstream: [{ kind: "research_document", path: RESEARCH }],
		})).not.toThrow();
	});
});
