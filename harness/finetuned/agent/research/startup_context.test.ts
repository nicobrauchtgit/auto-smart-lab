import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { summarizeTrainingLabels } from "./startup_context.js";

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
});

