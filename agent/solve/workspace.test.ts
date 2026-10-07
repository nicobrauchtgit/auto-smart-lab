import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareSolutionsWorkspace } from "./workspace.js";

describe("prepareSolutionsWorkspace", () => {
	test("creates the solutions task directory without authoring the agent's pipeline", () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "solve-project-"));
		try {
			const workspace = prepareSolutionsWorkspace(projectRoot, "spam1");
			expect(existsSync(join(projectRoot, "solutions", "tasks"))).toBe(true);
			expect(workspace.entrypointPath).toBe(join(projectRoot, "solutions", "tasks", "spam1.py"));
			expect(existsSync(workspace.entrypointPath)).toBe(false);
		} finally {
			rmSync(projectRoot, { recursive: true, force: true });
		}
	});
});
