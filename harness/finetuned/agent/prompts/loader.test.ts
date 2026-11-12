import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { expect } from "bun:test";
import { loadPromptSnapshot } from "./loader.js";
import { PROMPTS, type PromptId } from "./registry.js";
import { prepareLeadPrompts } from "./lead.js";
import { spamConfiguration } from "../pipeline/task_configuration.testing.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";

test("every registered template loads and renders with its declared inputs", () => {
	const snapshot = loadPromptSnapshot();
	for (const [id, definition] of Object.entries(PROMPTS)) {
		const variables = Object.fromEntries(definition.variables.map(key => [key, `example-${key}`]));
		const rendered = snapshot.render(id as PromptId, variables as never);
		assert.ok(rendered.text.length > 0);
		assert.equal(rendered.reference.id, id);
		assert.equal(rendered.reference.rendered_sha256, createHash("sha256").update(rendered.text).digest("hex"));
	}
});

test("rejects unknown IDs, missing inputs, extra inputs, and wrong input types", () => {
	const snapshot = loadPromptSnapshot();
	assert.throws(() => snapshot.render("unknown" as PromptId, {} as never), /Unknown prompt/);
	assert.throws(() => snapshot.render("team.lead-system", {} as never), /missing or non-string/);
	assert.throws(() => snapshot.render("team.lead-system", { budget: "80", taskId: "spam1", extra: "x" } as never), /unknown \[extra\]/);
	assert.throws(() => snapshot.render("team.lead-system", { budget: "80", taskId: 1 } as never), /missing or non-string/);
});

test("substitutes data once without interpreting braces or replacement tokens", () => {
	const rendered = loadPromptSnapshot().render("team.lead-system", { budget: "80", taskId: "{{taskId}} $&" });
	assert.match(rendered.text, /\{\{taskId\}\} \$&/);
});

test("snapshots survive file edits and reject missing files or malformed declarations on reload", () => {
	const root = mkdtempSync(join(tmpdir(), "prompt-snapshot-"));
	try {
		cpSync(new URL("./", import.meta.url), root, { recursive: true });
		const path = join(root, "team/lead-system.md");
		const original = readFileSync(path, "utf8");
		const first = loadPromptSnapshot(root);
		writeFileSync(path, `${original}\nChanged instructions.\n`);
		const second = loadPromptSnapshot(root);
		assert.notEqual(first.fingerprint, second.fingerprint);
		assert.doesNotMatch(first.render("team.lead-system", { budget: "80", taskId: "spam1" }).text, /Changed instructions/);
		assert.match(second.render("team.lead-system", { budget: "80", taskId: "spam1" }).text, /Changed instructions/);
		writeFileSync(path, "{{undeclared}}\n");
		assert.throws(() => loadPromptSnapshot(root), /Invalid template/);
		rmSync(path);
		assert.throws(() => loadPromptSnapshot(root), /ENOENT/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the solve opening selects the task contract of the configured kind", () => {
	const snapshot = loadPromptSnapshot();
	const base = { taskId: "apk", workspace: "/tmp/ws", datasetPaths: ["/tmp/dev.zip"], targets: "families", rowCount: 90,
		targetSummary: "Families: 9.", foldRecommendation: "5-fold group_kfold, 1 repeat(s)", maxIterations: 3 };
	const binary = prepareLeadPrompts(snapshot, { ...base, configuration: spamConfiguration() });
	assert.match(binary.prompt, /Scored on balanced accuracy/);
	assert.ok(binary.promptReferences.some(reference => reference.id === "team.lead-task-binary_classification"));
	const clustering: TaskConfiguration = { schemaVersion: 1, kind: "clustering", samples: { source: "zip_members", train: "a-train.zip", test: "a-test.zip" },
		targets: { kind: "families", file: "a-train.labels" }, execution: "batch", holdout: "group", metric: "adjusted_rand_index",
		refit: "fit_predict_test_batch", submission: { format: "id_semicolon_prediction", predictions: "cluster_id" } };
	const clustered = prepareLeadPrompts(snapshot, { ...base, configuration: clustering });
	assert.match(clustered.prompt, /adjusted Rand index/);
	assert.match(clustered.prompt, /Execution for this task: `batch`/);
	assert.doesNotMatch(clustered.prompt, /balanced accuracy|`text` columns/);
	assert.ok(clustered.promptReferences.some(reference => reference.id === "team.lead-task-clustering"));
	assert.ok(!clustered.promptReferences.some(reference => reference.id === "team.lead-label-free"));
	const anomaly: TaskConfiguration = { ...clustering, kind: "anomaly_detection", targets: { kind: "none" }, execution: "inductive", holdout: "none",
		metric: "none", refit: "fit_training_predict_test", submission: { format: "id_semicolon_prediction", predictions: "binary" },
		anomaly: { scoreMethod: "score_samples", scoreDirection: "lower_is_anomalous", anomalyLabel: -1 } };
	const detected = prepareLeadPrompts(snapshot, { ...base, configuration: anomaly });
	assert.match(detected.prompt, /returning `-1` for anomalies/);
	assert.match(detected.prompt, /lower is anomalous/);
	assert.ok(detected.promptReferences.some(reference => reference.id === "team.lead-label-free"));
    const selected = prepareLeadPrompts(snapshot, { ...base, configuration: { ...anomaly,
        selection: { basis: "evidence", metric: "evidence_average_precision", direction: "maximize", population: "development" } },
        evidencePath: "/tmp/solve/agent/evidence.json" });
    assert.match(selected.prompt, /\/tmp\/solve\/agent\/evidence.json/);
    assert.match(selected.prompt, /evidence_average_precision/);
    assert.ok(selected.promptReferences.some(reference => reference.id === "team.lead-evidence-selection"));
    assert.ok(!selected.promptReferences.some(reference => reference.id === "team.lead-label-free"));
});

test("scout skill IDs reject missing files and undeclared variables", () => {
 const root = mkdtempSync(join(tmpdir(), "scout-skill-prompts-"));
 try {
  cpSync(new URL("./", import.meta.url), root, { recursive: true });
  for (const id of ["team.skill-data", "team.skill-ideas", "team.skill-validation"] as const) {
   const path = join(root, PROMPTS[id].file), original = readFileSync(path, "utf8");
   assert.throws(() => loadPromptSnapshot().render(id, { unexpected: "x" } as never), /unknown/);
   writeFileSync(path, `${original}\n{{unexpected}}`);
   assert.throws(() => loadPromptSnapshot(root), /Invalid template/);
   rmSync(path);
   assert.throws(() => loadPromptSnapshot(root), /ENOENT/);
   writeFileSync(path, original);
  }
 } finally { rmSync(root, { recursive: true, force: true }); }
});
