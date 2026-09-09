import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPromptSnapshot } from "./loader.js";
import { PROMPTS, type PromptId } from "./registry.js";
import { prepareResearchPrompts } from "./research.js";
import { summarizeTrainingLabels } from "../research/startup_context.js";

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
	assert.throws(() => snapshot.render("evaluation.start", {} as never), /missing or non-string/);
	assert.throws(() => snapshot.render("evaluation.start", { taskId: "spam1", extra: "x" } as never), /unknown \[extra\]/);
	assert.throws(() => snapshot.render("evaluation.start", { taskId: 1 } as never), /missing or non-string/);
});

test("substitutes data once without interpreting braces or replacement tokens", () => {
	const rendered = loadPromptSnapshot().render("evaluation.start", { taskId: "{{taskId}} $&" });
	assert.match(rendered.text, /\{\{taskId\}\} \$&/);
});

test("snapshots survive file edits and reject missing files or malformed declarations on reload", () => {
	const root = mkdtempSync(join(tmpdir(), "prompt-snapshot-"));
	try {
		cpSync(new URL("./", import.meta.url), root, { recursive: true });
		const path = join(root, "evaluation/start.md");
		const original = readFileSync(path, "utf8");
		const first = loadPromptSnapshot(root);
		writeFileSync(path, `${original}\nChanged instructions.\n`);
		const second = loadPromptSnapshot(root);
		assert.notEqual(first.fingerprint, second.fingerprint);
		assert.doesNotMatch(first.render("evaluation.start", { taskId: "spam1" }).text, /Changed instructions/);
		assert.match(second.render("evaluation.start", { taskId: "spam1" }).text, /Changed instructions/);
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
