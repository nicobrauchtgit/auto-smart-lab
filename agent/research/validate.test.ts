import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { researchContextHash, type ResearchContext } from "./context.js";
import { validateResearchDocument, validateResearchFile } from "./validate.js";

const context: ResearchContext = {
	schema_version: 1,
	generated_at: "2026-09-01T00:00:00.000Z",
	run_date: "2026-09-01",
	task: { id: "spam1", title: "Spam", unit: "Spam", task_dir: "units/spam", prompt_file: "task.md" },
	dataset: {
		data_dir: "units/spam/data",
		total_files: 2,
		total_bytes: 20,
		file_types: { ".txt": { files: 2, bytes: 20 } },
		primary_inputs: [],
		snapshot_sha256: "dataset-hash",
	},
	limits: { web_search_calls: 3, max_report_bytes: 40960, max_analysis_artifact_bytes: 65536, max_feature_recommendations: 10 },
};

const validDocument = `# Research: Spam

## Scope

Context snapshot: \`sha256:${researchContextHash(context)}\`

## Evidence-backed findings

- **Measured:** There are two documents. [D001]

## Guidance for the solver

1. Test word tokens as a baseline. [D001] [S001]

## Risks and unknowns

- Test distribution is unknown.

## Sources

- [D001] Full-corpus count — script: \`analysis/analyze.py\`; artifact: \`analysis/summary.json\`
- [S001] Example specification — https://example.com/spec

## Revision log

- 2026-09-01: Created the report.
`;

describe("validateResearchDocument", () => {
	test("accepts traceable dataset and web research", () => {
		expect(validateResearchDocument(validDocument, context)).toEqual({ valid: true, errors: [] });
	});

	test("rejects legacy and undefined citations", () => {
		const invalid = validDocument
			.replace("[D001]", "[E001]")
			.replace("https://example.com/spec", "no-url");
		const result = validateResearchDocument(invalid, context);
		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("legacy controller-generated");
		expect(result.errors.join("\n")).toContain("[S001] is not defined with a URL");
	});
});

describe("validateResearchFile", () => {
	test("checks the scope and snapshot of cited dataset evidence", () => {
		const workspace = mkdtempSync(join(tmpdir(), "research-validation-"));
		try {
			mkdirSync(join(workspace, "analysis"));
			writeFileSync(join(workspace, "research.md"), validDocument);
			writeFileSync(join(workspace, "analysis", "analyze.py"), "# portable analysis\n");
			writeFileSync(join(workspace, "analysis", "summary.json"), JSON.stringify({
				dataset_snapshot_sha256: context.dataset.snapshot_sha256,
				evidence: {
					D001: { scope: "full", population: 2, method: "Counted every document.", values: { documents: 2 } },
				},
			}));

			expect(validateResearchFile(join(workspace, "research.md"), context)).toEqual({ valid: true, errors: [] });

			writeFileSync(join(workspace, "analysis", "summary.json"), JSON.stringify({
				dataset_snapshot_sha256: "stale-dataset",
				evidence: {
					D001: { scope: "sampled", population: 2, method: "Sampled two documents.", values: { documents: 2 } },
				},
			}));
			const result = validateResearchFile(join(workspace, "research.md"), context);
			expect(result.valid).toBe(false);
			expect(result.errors.join("\n")).toContain("current dataset snapshot");
			expect(result.errors.join("\n")).toContain("Measured without citing full-scope evidence");
		} finally {
			rmSync(workspace, { recursive: true, force: true });
		}
	});
});
