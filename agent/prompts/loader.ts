import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROMPTS, type PromptId, type PromptVariables } from "./registry.js";
import { TOOL_PROMPTS_SHA256 } from "./tools.js";

const PROMPT_ROOT = dirname(fileURLToPath(import.meta.url));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export interface PromptReference {
	id: PromptId;
	template_sha256: string;
	rendered_sha256: string;
}

export interface RenderedPrompt {
	text: string;
	reference: PromptReference;
}

export interface PromptSnapshot {
	readonly fingerprint: string;
	render<Id extends PromptId>(id: Id, variables: PromptVariables<Id>): RenderedPrompt;
}

/** Load and validate every template once. Rendering never reads mutable files. */
export function loadPromptSnapshot(root = PROMPT_ROOT): PromptSnapshot {
	const templates = new Map<PromptId, { text: string; sha256: string }>();
	for (const [id, definition] of Object.entries(PROMPTS)) {
		const text = readFileSync(resolve(root, definition.file), "utf8");
		const placeholders = [...text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map(match => match[1]);
		const expected: readonly string[] = definition.variables;
		if (/\{\{|\}\}/.test(text.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, ""))) {
			throw new Error(`Invalid template ${id}: malformed variable placeholder`);
		}
		const unknown = placeholders.filter(key => !expected.includes(key));
		const missing = expected.filter(key => !placeholders.includes(key));
		if (unknown.length || missing.length) {
			throw new Error(`Invalid template ${id}: unknown variables [${unknown}], missing variables [${missing}]`);
		}
		templates.set(id as PromptId, { text, sha256: hash(text) });
	}
	const fingerprint = hash(JSON.stringify({
		templates: [...templates].map(([id, template]) => [id, template.sha256]),
		tools: TOOL_PROMPTS_SHA256,
	}));
	return Object.freeze({
		fingerprint,
		render<Id extends PromptId>(id: Id, variables: PromptVariables<Id>): RenderedPrompt {
			const template = templates.get(id);
			if (!template) throw new Error(`Unknown prompt ID: ${id}`);
			if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
				throw new Error(`Variables for ${id} must be an object`);
			}
			const expected: readonly string[] = PROMPTS[id].variables;
			const values = variables as Record<string, unknown>;
			const unknown = Object.keys(values).filter(key => !expected.includes(key));
			const missing = expected.filter(key => !Object.hasOwn(values, key) || typeof values[key] !== "string");
			if (unknown.length || missing.length) {
				throw new Error(`Invalid inputs for ${id}: unknown [${unknown}], missing or non-string [${missing}]`);
			}
			// One pass: braces in supplied task data are never interpreted as templates.
			const text = template.text.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g,
				(_, key: string) => values[key] as string).trim();
			return Object.freeze({ text, reference: Object.freeze({ id, template_sha256: template.sha256, rendered_sha256: hash(text) }) });
		},
	});
}
