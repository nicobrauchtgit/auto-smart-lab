import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { archivePreviousRun, RUN_OUTPUTS } from "./workspace.js";

function workspaceWithPreviousRun(): string {
	const root = mkdtempSync(join(tmpdir(), "solve-workspace-"));
	for (const name of RUN_OUTPUTS) writeFileSync(join(root, name), `previous ${name}\n`);
	mkdirSync(join(root, "iterations", "2", "solutions"), { recursive: true });
	writeFileSync(join(root, "iterations", "2", "solutions", "task.py"), "champion\n");
	return root;
}

describe("archivePreviousRun", () => {
	test("moves every file the evaluator reads by name out of the way", () => {
		const root = workspaceWithPreviousRun();
		const previous = archivePreviousRun(root);
		expect(previous).toBe(join(root, "previous"));
		for (const name of RUN_OUTPUTS) {
			expect(existsSync(join(root, name))).toBe(false);
			expect(readFileSync(join(previous!, name), "utf8")).toBe(`previous ${name}\n`);
		}
	});

	test("a stale metrics.json cannot be graded as the new run's result", () => {
		const root = workspaceWithPreviousRun();
		archivePreviousRun(root);
		expect(existsSync(join(root, "metrics.json"))).toBe(false);
	});

	test("champion snapshots move with the run that produced them", () => {
		const root = workspaceWithPreviousRun();
		archivePreviousRun(root);
		expect(existsSync(join(root, "iterations"))).toBe(false);
		expect(readFileSync(join(root, "previous", "iterations", "2", "solutions", "task.py"), "utf8")).toBe("champion\n");
	});

	test("a workspace with nothing to displace is left alone", () => {
		const root = mkdtempSync(join(tmpdir(), "solve-workspace-"));
		expect(archivePreviousRun(root)).toBeUndefined();
		expect(existsSync(join(root, "previous"))).toBe(false);
	});

	test("only one generation is kept, so the archive cannot grow without bound", () => {
		const root = workspaceWithPreviousRun();
		archivePreviousRun(root);
		writeFileSync(join(root, "metrics.json"), "second run\n");
		archivePreviousRun(root);
		expect(readFileSync(join(root, "previous", "metrics.json"), "utf8")).toBe("second run\n");
		// The first generation's other files went with it rather than lingering.
		expect(existsSync(join(root, "previous", "oof_predictions.csv"))).toBe(false);
	});

	test("data and research are preserved, being rewritten rather than inherited", () => {
		const root = workspaceWithPreviousRun();
		mkdirSync(join(root, "data"), { recursive: true });
		writeFileSync(join(root, "data", "sealed_ids.txt"), "id\n");
		archivePreviousRun(root);
		expect(existsSync(join(root, "data", "sealed_ids.txt"))).toBe(true);
	});
});
