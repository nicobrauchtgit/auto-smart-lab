import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { buildResearchLaunchPrompt, renderStartupContext, summarizeTrainingLabels } from "./startup_context.js";

test("counts all unique training labels and distinguishes ordinary accuracy from BACC", () => {
	const content = Buffer.from("\uFEFFa;0\r\nb;0\r\nc;0\r\nd;1\r\n\r\n");
	const profile = summarizeTrainingLabels(content, "data/train.labels", "balanced_accuracy");
	assert.equal(profile.status, "available");
	assert.deepEqual(profile.training_labels, {
		rows: 4,
		classes: [{ label: 0, count: 3, fraction: 0.75 }, { label: 1, count: 1, fraction: 0.25 }],
		majority_class_accuracy: 0.75,
		constant_prediction_balanced_accuracy: 0.5,
	});
	assert.equal(profile.source?.sha256, createHash("sha256").update(content).digest("hex"));
	const text = renderStartupContext(profile);
	assert.match(text, /Class 0: 3 \(75.00%\)/);
	assert.match(text, /0.5 balanced accuracy/);
	assert.match(text, /test class balance are unverified/);
});

test("does not publish partial counts for malformed or duplicate records", () => {
	for (const content of ["a;0\nb;2", "a;0\nb", "a;0\n;1", "a;0\na;1", "a;0\na;0", "", "a;NaN", "a;0\nb;1 extra"]) {
		const profile = summarizeTrainingLabels(Buffer.from(content), "labels", null);
		assert.equal(profile.status, "unavailable", content);
		assert.equal(profile.training_labels, undefined, content);
		assert.ok(profile.reason);
	}
});

test("rejects invalid UTF-8 rather than counting replacement characters as paths", () => {
	const profile = summarizeTrainingLabels(Buffer.from([0xff, 59, 48]), "labels", null);
	assert.equal(profile.status, "unavailable");
});

test("does not report a two-class baseline when only one class is present", () => {
	const profile = summarizeTrainingLabels(Buffer.from("a;1\nb;1"), "labels", "balanced_accuracy");
	assert.equal(profile.training_labels?.constant_prediction_balanced_accuracy, null);
	assert.match(renderStartupContext(profile), /Only one class is present/);
	assert.doesNotMatch(renderStartupContext(profile), /gives 0.5/);
});

test("does not infer a metric when the task metric is unknown", () => {
	const profile = summarizeTrainingLabels(Buffer.from("a;0\nb;1"), "labels", null);
	assert.match(renderStartupContext(profile), /Task metric: not identified/);
	assert.doesNotMatch(renderStartupContext(profile), /Task metric: balanced_accuracy|gives 0.5 balanced accuracy/);
});

test("injects a bounded summary before the research request and supports no injection", () => {
	const content = Buffer.from(Array.from({ length: 200000 }, (_, i) => `private-document-${i};${i % 2}`).join("\n"));
	const profile = summarizeTrainingLabels(content, "labels", "balanced_accuracy");
	const request = "Research the task and verify claims.";
	const prompt = buildResearchLaunchPrompt(request, "spam1", "hash", profile);
	assert.ok(prompt.indexOf("Training label records: 200000") < prompt.indexOf(request));
	assert.doesNotMatch(prompt, /private-document-/);
	assert.ok(Buffer.byteLength(prompt) < 1800);
	assert.equal(buildResearchLaunchPrompt(request, "spam1", "hash"), `${request}\n\nTask ID: spam1. Context SHA-256: hash.`);
	assert.deepEqual(JSON.parse(JSON.stringify(profile)), profile);
});
