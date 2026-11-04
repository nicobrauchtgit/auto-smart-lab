import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { researchContextHash, type ResearchContext } from "./context.js";
import { extractSources, statedNumbers, validateResearchFile, WEB_SOURCES_LOG } from "./validate.js";

const context: ResearchContext = {
	schema_version: 1,
	generated_at: "2026-11-03T00:00:00.000Z",
	run_date: "2026-11-03",
	task: { id: "spam1", title: "Spam", unit: "Spam", task_dir: "units/spam", prompt_file: "task.md" },
	dataset: {
		data_dir: "units/spam/data", total_files: 2, total_bytes: 20,
		file_types: { ".zip": { files: 2, bytes: 20 } }, primary_inputs: [], snapshot_sha256: "dataset-hash",
	},
	limits: { web_search_calls: 3, max_report_bytes: 16384, max_analysis_artifact_bytes: 65536, max_facts: 8, max_alternates: 2, max_improvements: 3 },
};
const URL = "https://scikit-learn.org/stable/modules/feature_extraction.html";

function brief(parts: Partial<Record<"facts" | "pipeline" | "alternates" | "improvements" | "risks" | "sources", string>> = {}): string {
	return `# Brief: Spam

Context snapshot: \`sha256:${researchContextHash(context)}\`

## Dataset facts

${parts.facts ?? `- Training has 3,007 normal and 554 spam pages (15.56% spam) [profile:training.targets].
- Spam pages have a median of 25 URLs [analysis/text.json#urls_median.spam].`}

## Recommended pipeline

${parts.pipeline ?? `Word and character TF-IDF with a linear SVM, class weights balanced, 5-fold stratified CV [profile:training.targets; ${URL}].`}

## Alternates

${parts.alternates ?? `- Gradient boosting on structural HTML counts [analysis/text.json].`}

## Next improvements

${parts.improvements ?? `- Add URL-count features; measure balanced accuracy on the hold-out.`}

## Leakage and risks

${parts.risks ?? `- Member-name suffixes predict the label with accuracy 1.0 in training [profile:training.name_leakage]; never use names as features.`}

## Sources

${parts.sources ?? `- ${URL} — scikit-learn text feature extraction`}
`;
}

function workspace(document: string, options: { urls?: string[]; snapshot?: string } = {}) {
	const root = mkdtempSync(join(tmpdir(), "brief-"));
	mkdirSync(join(root, "profile")); mkdirSync(join(root, "analysis")); mkdirSync(join(root, ".harness"));
	writeFileSync(join(root, "profile/profile.json"), JSON.stringify({
		dataset_snapshot_sha256: options.snapshot ?? "dataset-hash",
		evidence: {
			"training.targets": { values: { counts: { "0": 3007, "1": 554 }, fractions: { "0": 0.8444, "1": 0.1556 } } },
			"training.name_leakage": { values: { suffix: { majority_accuracy: 1.0 } } },
		},
	}));
	writeFileSync(join(root, "analysis/text.json"), JSON.stringify({ urls_median: { spam: 25, ham: 9 } }));
	writeFileSync(join(root, WEB_SOURCES_LOG), `${JSON.stringify({ query: "q", urls: options.urls ?? [URL] })}\n`);
	writeFileSync(join(root, "research.md"), document);
	return { path: join(root, "research.md"), close: () => rmSync(root, { recursive: true, force: true }) };
}

function check(document: string, options?: Parameters<typeof workspace>[1]) {
	const fixture = workspace(document, options);
	try { return validateResearchFile(fixture.path, context); } finally { fixture.close(); }
}

describe("solution brief", () => {
	test("a brief with resolvable sources and supported numbers passes", () => {
		expect(check(brief())).toEqual({ valid: true, errors: [] });
	});

	test("routes are capped: alternates, facts and improvements", () => {
		const result = check(brief({
			alternates: "- A [analysis/text.json]\n- B [analysis/text.json]\n- C [analysis/text.json]",
			improvements: "- one\n- two\n- three\n- four",
		}));
		expect(result.errors).toContain("Alternates has 3 alternates; at most 2. Keep only the strongest");
		expect(result.errors).toContain("Next improvements has 4 improvements; at most 3. Keep only the strongest");
	});

	test("a number not in the cited data is reported against its fact", () => {
		const result = check(brief({ facts: "- Training has 3,100 normal pages [profile:training.targets]." }));
		expect(result.valid).toBe(false);
		expect(result.errors.some(error => /3,100 is not in the cited data/.test(error))).toBe(true);
	});

	test("percentages, thousands separators and rounding match the cited fractions and counts", () => {
		expect(check(brief({ facts: "- 15.6% of 3,561 is spam: 554 pages [profile:training.targets; analysis/text.json]." })).errors
			.filter(error => error.includes("3,561"))).toHaveLength(1);
		expect(check(brief({ facts: "- 84.4% are normal and 15.6% spam [profile:training.targets]." })).valid).toBe(true);
	});

	test("a fact without a dataset source is rejected, and a web source does not count as one", () => {
		const result = check(brief({ facts: `- Spam is common in this corpus [${URL}].` }));
		expect(result.errors.some(error => /Fact .* cites no dataset source/.test(error))).toBe(true);
	});

	test("URLs must come from this workspace's web searches", () => {
		const invented = "https://example.org/made-up-paper";
		const result = check(brief({ pipeline: `TF-IDF with a linear SVM [profile:training.targets; ${invented}].` }));
		expect(result.errors).toContain(`[${invented}] was not returned by web_search in this workspace; cite a URL from your search results`);
		expect(check(brief({ sources: `- [scikit-learn docs](${URL}#section)` })).valid).toBe(true);
	});

	test("unknown keys, missing files and a profile from another snapshot do not resolve", () => {
		expect(check(brief({ facts: "- 554 spam pages [profile:training.missing]." })).errors)
			.toContain("[profile:training.missing]: no key 'training.missing' in profile/profile.json");
		expect(check(brief({ facts: "- 554 spam pages [analysis/absent.json]." })).errors)
			.toContain("[analysis/absent.json]: file does not exist");
		expect(check(brief(), { snapshot: "older" }).errors)
			.toContain("[profile:training.targets]: the data profile belongs to another dataset snapshot");
		expect(check(brief({ facts: "- 554 spam pages [../outside.json]." })).errors)
			.toContain("[../outside.json] points outside the research workspace");
	});

	test("the recommended pipeline must be tied to dataset sources", () => {
		expect(check(brief({ pipeline: `TF-IDF with a linear SVM [${URL}].` })).errors)
			.toContain("Recommended pipeline cites no dataset source; tie it to the profile or your analysis artifacts");
	});

	test("structure, placeholders, size and the context snapshot are checked", () => {
		const skeleton = brief({ alternates: "Pending." }).replace("## Sources", "## Extra\n\nx\n\n## Sources");
		const result = check(skeleton.replace(researchContextHash(context), "stale"));
		expect(result.errors).toContain("document still contains placeholder content");
		expect(result.errors).toContain("unexpected section '## Extra'");
		expect(result.errors.some(error => error.startsWith("the brief does not state the current context snapshot"))).toBe(true);
		expect(check(brief({ risks: `- ${"x".repeat(17000)}` })).errors.some(error => /safety limit is 16384\. Condense it/.test(error))).toBe(true);
	});
});

describe("source and number extraction", () => {
	test("sources: profile keys, artifacts with keys, URLs and markdown links; plain brackets are ignored", () => {
		expect(extractSources(`[profile:a.b; analysis/x.json#k, ${URL}] [see above] [docs](${URL})`).map(source => source.kind))
			.toEqual(["profile", "artifact", "url", "url"]);
	});

	test("numbers: code spans, sources, identifiers and small integers are not claims", () => {
		const numbers = statedNumbers("Use `spam1-train.zip` with 5-fold CV on 3,561 rows, 14.8 KB median, label 1 [profile:x.2048].");
		expect(numbers.map(number => [number.value, number.scale])).toEqual([[3561, 1], [14.8, 1000]]);
	});
});
