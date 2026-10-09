import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { expect } from "bun:test";
import { loadPromptSnapshot } from "./loader.js";
import { PROMPTS, type PromptId } from "./registry.js";
import { prepareResearchPrompts } from "./research.js";
import { prepareSolvePrompts } from "./solve.js";
import { summarizeTrainingLabels } from "../research/startup_context.js";
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
	assert.throws(() => snapshot.render("solve.system", {} as never), /missing or non-string/);
	assert.throws(() => snapshot.render("solve.system", { taskId: "spam1", extra: "x" } as never), /unknown \[extra\]/);
	assert.throws(() => snapshot.render("solve.system", { taskId: 1 } as never), /missing or non-string/);
});

test("substitutes data once without interpreting braces or replacement tokens", () => {
	const rendered = loadPromptSnapshot().render("solve.system", { taskId: "{{taskId}} $&" });
	assert.match(rendered.text, /\{\{taskId\}\} \$&/);
});

test("snapshots survive file edits and reject missing files or malformed declarations on reload", () => {
	const root = mkdtempSync(join(tmpdir(), "prompt-snapshot-"));
	try {
		cpSync(new URL("./", import.meta.url), root, { recursive: true });
		const path = join(root, "solve/system.md");
		const original = readFileSync(path, "utf8");
		const first = loadPromptSnapshot(root);
		writeFileSync(path, `${original}\nChanged instructions.\n`);
		const second = loadPromptSnapshot(root);
		assert.notEqual(first.fingerprint, second.fingerprint);
		assert.doesNotMatch(first.render("solve.system", { taskId: "spam1" }).text, /Changed instructions/);
		assert.match(second.render("solve.system", { taskId: "spam1" }).text, /Changed instructions/);
		writeFileSync(path, "{{undeclared}}\n");
		assert.throws(() => loadPromptSnapshot(root), /Invalid template/);
		rmSync(path);
		assert.throws(() => loadPromptSnapshot(root), /ENOENT/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("research uses the same opening task and adds factual feedback only after an attempt", () => {
	const snapshot = loadPromptSnapshot();
	const input = { taskId: "spam1", contextHash: "abc" };
	const initial = prepareResearchPrompts(snapshot, input);
	const retry = prepareResearchPrompts(snapshot, { ...input, failedChecks: ["missing sources"] });
	assert.ok(retry.prompt.startsWith(initial.prompt));
	assert.equal(initial.system.text, retry.system.text);
	assert.match(initial.prompt, /leave sound existing work unchanged/);
	assert.doesNotMatch(initial.prompt, /Migrate|missing sources|currently fails/);
	assert.match(retry.prompt, /missing sources/);
	assert.equal(retry.promptReferences.at(-1)?.id, "research.validation-feedback");
});

test("profile injection changes rendered identity without changing the task template", () => {
	const snapshot = loadPromptSnapshot();
	const input = { taskId: "spam1", contextHash: "abc" };
	const without = prepareResearchPrompts(snapshot, input);
	const withProfile = prepareResearchPrompts(snapshot, { ...input,
		profile: summarizeTrainingLabels(Buffer.from("a;0\nb;1"), "train.labels", "balanced_accuracy") });
	const reference = (prepared: typeof without) => prepared.promptReferences.find(ref => ref.id === "research.start")!;
	assert.equal(reference(without).template_sha256, reference(withProfile).template_sha256);
	assert.notEqual(reference(without).rendered_sha256, reference(withProfile).rendered_sha256);
	assert.ok(withProfile.promptReferences.some(ref => ref.id === "research.startup-context"));
	assert.ok(!without.promptReferences.some(ref => ref.id === "research.startup-context"));
});

test("the solve opening carries the fit policy as its own identified template", () => {
	const snapshot = loadPromptSnapshot();
	const prepared = prepareSolvePrompts(snapshot, {
		taskId: "spam1", configuration: spamConfiguration(), workspace: "/tmp/ws", datasetPaths: ["/tmp/train.zip"],
		targets: "/tmp/train.labels", rowCount: 14995, targetSummary: "Class balance: 52/48.",
		foldRecommendation: "5-fold stratified, 1 repeat(s)", researchState: "none", maxIterations: 6,
	});
	// The policy is stable across tasks, so it stays a separate template rather
	// than prose inside the run-specific opening.
	const policy = prepared.promptReferences.find(reference => reference.id === "solve.observable-fits");
	assert.ok(policy);
	assert.match(prepared.prompt, /create it if it does not exist/);
	assert.match(prepared.prompt, /Do not write out-of-fold predictions or reported metrics yourself/);
	assert.match(prepared.prompt, /`experiment_start`/);
	assert.match(prepared.prompt, /`experiment_status`/);
	assert.match(prepared.prompt, /`experiment_output`/);
	assert.match(prepared.prompt, /`experiment_stop`/);
	assert.match(prepared.prompt, /The harness materializes your fold\s+design with harness-owned seeds/);
	assert.match(prepared.prompt, /A pilot should deliberately reduce work/);
	assert.equal(snapshot.render("solve.observable-fits", {}).reference.rendered_sha256, policy.rendered_sha256);
});

test("the solve opening selects the task contract of the configured kind", () => {
	const snapshot = loadPromptSnapshot();
	const base = { taskId: "apk", workspace: "/tmp/ws", datasetPaths: ["/tmp/dev.zip"], targets: "families", rowCount: 90,
		targetSummary: "Families: 9.", foldRecommendation: "5-fold group_kfold, 1 repeat(s)", researchState: "none", maxIterations: 3 };
	const binary = prepareSolvePrompts(snapshot, { ...base, configuration: spamConfiguration() });
	assert.match(binary.prompt, /Scored on balanced accuracy/);
	assert.ok(binary.promptReferences.some(reference => reference.id === "solve.task-binary_classification"));
	const clustering: TaskConfiguration = { schemaVersion: 1, kind: "clustering", samples: { source: "zip_members", train: "a-train.zip", test: "a-test.zip" },
		targets: { kind: "families", file: "a-train.labels" }, execution: "batch", holdout: "group", metric: "adjusted_rand_index",
		refit: "fit_predict_test_batch", submission: { format: "id_semicolon_prediction", predictions: "cluster_id" } };
	const clustered = prepareSolvePrompts(snapshot, { ...base, configuration: clustering });
	assert.match(clustered.prompt, /adjusted Rand index/);
	assert.match(clustered.prompt, /Execution for this task: `batch`/);
	assert.doesNotMatch(clustered.prompt, /balanced accuracy|`text` columns/);
	assert.ok(clustered.promptReferences.some(reference => reference.id === "solve.task-clustering"));
	assert.ok(!clustered.promptReferences.some(reference => reference.id === "solve.label-free"));
	const anomaly: TaskConfiguration = { ...clustering, kind: "anomaly_detection", targets: { kind: "none" }, execution: "inductive", holdout: "none",
		metric: "none", refit: "fit_training_predict_test", submission: { format: "id_semicolon_prediction", predictions: "binary" },
		anomaly: { scoreMethod: "score_samples", scoreDirection: "lower_is_anomalous", anomalyLabel: -1 } };
	const detected = prepareSolvePrompts(snapshot, { ...base, configuration: anomaly });
	assert.match(detected.prompt, /returning `-1` for anomalies/);
	assert.match(detected.prompt, /lower is anomalous/);
	assert.ok(detected.promptReferences.some(reference => reference.id === "solve.label-free"));
    const selected = prepareSolvePrompts(snapshot, { ...base, configuration: { ...anomaly,
        selection: { basis: "evidence", metric: "evidence_average_precision", direction: "maximize", population: "development" } },
        evidencePath: "/tmp/solve/agent/evidence.json" });
    assert.match(selected.prompt, /\/tmp\/solve\/agent\/evidence.json/);
    assert.match(selected.prompt, /evidence_average_precision/);
    assert.ok(selected.promptReferences.some(reference => reference.id === "solve.evidence-selection"));
    assert.ok(!selected.promptReferences.some(reference => reference.id === "solve.label-free"));
});

test("research always supplies the separate test-input pass and its evidence limits", () => {
 const prompts = loadPromptSnapshot();
 const prepared = prepareResearchPrompts(prompts, { taskId: 'spam1', contextHash: 'fixed-fixture' });
 const guide = prompts.render('research.test-distribution', {});
 assert.ok(prepared.promptReferences.some(ref => ref.id === 'research.test-distribution' && ref.rendered_sha256 === guide.reference.rendered_sha256));
 assert.ok(prepared.prompt.includes(guide.text));
 assert.match(guide.text, /after releasing the training\s+data/);
 assert.match(guide.text, /Do not\s+discard a useful training finding/);
 assert.match(guide.text, /check it in both\s+splits/);
 assert.match(guide.text, /do not treat absence from a sample as absence\s+from the whole split/);
 assert.match(guide.text, /Never\s+infer targets from them/);
 assert.match(guide.text, /split: "training".*split: "test"/);
});

test("opening guidance is optional with explicit empty compatibility, rejects unknown/non-string variables and preserves literal braces", () => {
 const prompts = loadPromptSnapshot();
 const base = { taskId: "fixture", contextHash: "hash", startupContext: "" };
 expect(prompts.render("research.start", base).text).toBe(prompts.render("research.start", { ...base, guidance: "" }).text);
 expect(prompts.render("research.start", { ...base, guidance: "Literal {{unknown}}" }).text).toContain("Literal {{unknown}}");
 expect(() => prompts.render("research.start", { ...base, guidance: 1 } as any)).toThrow();
 expect(() => prompts.render("research.start", { ...base, unexpected: "x" } as any)).toThrow();
});
