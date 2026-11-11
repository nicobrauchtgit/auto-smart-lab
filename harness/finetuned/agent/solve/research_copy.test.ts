import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { copyResearch } from "./workspace.js";

test("solve receives the brief together with the data profile its sources cite", () => {
	const project = mkdtempSync(join(tmpdir(), "research-copy-"));
	try {
		const research = join(project, "runs", "finetuned", "spam1", "research");
		mkdirSync(join(research, "profile"), { recursive: true });
		mkdirSync(join(research, "analysis"));
		mkdirSync(join(research, "resources"));
		writeFileSync(join(research, "resources", "slides.txt"), "Course slides\n");
		writeFileSync(join(research, "research.md"), "# Brief: Spam\n[profile:training.targets]\n");
		writeFileSync(join(research, "profile", "profile.json"), '{"evidence":{}}');
		writeFileSync(join(research, "analysis", "text.json"), "{}");
		const target = join(project, "solve", "research");
		mkdirSync(target, { recursive: true });
		const state = copyResearch(target, "spam1", [], project);
		expect(readFileSync(join(target, "profile", "profile.json"), "utf8")).toBe('{"evidence":{}}');
		expect(existsSync(join(target, "analysis", "text.json"))).toBe(true);
		expect(state).toContain("Harness data profile cited by the brief");
		expect(readFileSync(join(target, "resources", "slides.txt"), "utf8")).toBe("Course slides\n");
		expect(state).toContain("Course resources cited by the brief");
	} finally { rmSync(project, { recursive: true, force: true }); }
});

test("solve is told when it receives a partial brief", () => {
	const project = mkdtempSync(join(tmpdir(), "research-copy-"));
	try {
		const research = join(project, "runs", "finetuned", "spam1", "research");
		mkdirSync(join(research, ".harness"), { recursive: true });
		writeFileSync(join(research, "research.md"), "# Brief: Spam\n");
		writeFileSync(join(research, ".harness", "status.json"), JSON.stringify({ valid: false, partial: true, errors: ["missing '## Alternates' section"] }));
		const target = join(project, "solve", "research");
		mkdirSync(target, { recursive: true });
		expect(copyResearch(target, "spam1", [], project)).toContain("The brief is partial: 1 checks failed (for example: missing '## Alternates' section)");
	} finally { rmSync(project, { recursive: true, force: true }); }
});
