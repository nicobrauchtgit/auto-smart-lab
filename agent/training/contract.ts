/**
 * Layer 1 of request validation: structure only, before git, Python, or any
 * fit. Every problem is collected and reported together in the documented
 * `{path, problem, received, expected, hint}` shape; a rejected request never
 * reaches the budget.
 */

import { isAbsolute, posix } from "node:path";

import type {
	BuiltinCvRequest,
	CvRequest,
	ExperimentRequest,
	ExperimentScope,
	DiagnosticRequest,
	ProxyObjective,
	FactoryCvRequest,
	JsonScalar,
	JsonValue,
	PipelineRequest,
	SearchDistribution,
	SearchRequest,
	SearchSampler,
	ValidationIssue,
} from "./types.js";

type ObjectValue = Record<string, unknown>;

export const SEARCH_LIMITS = Object.freeze({
	maxParameters: 20,
	maxChoices: 50,
	maxConfigs: 500,
	maxGridSize: 5_000,
	maxFixedDepth: 8,
	maxFixedBytes: 64 * 1024,
	maxAcceptSeconds: 7 * 24 * 3_600,
});

const SAMPLERS: readonly SearchSampler[] = ["tpe", "random", "grid"];
const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FACTORY_PREFIX = "factory.";
const diagnosticMethod = (value: unknown) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(value)
	&& !["fit", "fit_predict", "fit_transform", "partial_fit", "set_params"].includes(value);

export class ExperimentRequestError extends Error {
	constructor(readonly issues: ValidationIssue[]) {
		super(formatIssues(issues));
		this.name = "ExperimentRequestError";
	}
}

export function formatIssues(issues: readonly ValidationIssue[]): string {
	return `experiment request rejected (${issues.length} problem${issues.length === 1 ? "" : "s"}):\n${issues
		.map((issue) => `- ${issue.path}: ${issue.problem}; received ${JSON.stringify(issue.received)}, expected ${issue.expected}. ${issue.hint}${issue.message ? ` Message: ${issue.message}` : ""}`)
		.join("\n")}`;
}

/** A JSON-safe, bounded rendering of what the agent actually sent. */
export function preview(value: unknown): JsonValue {
	if (value === undefined) return "(missing)";
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return typeof value === "string" && value.length > 200 ? `${value.slice(0, 200)}...` : value;
	}
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "bigint") return `${value}n`;
	if (typeof value === "function") return "(function)";
	try {
		const text = JSON.stringify(value);
		if (text === undefined) return `(${typeof value})`;
		return text.length > 200 ? `${text.slice(0, 200)}...` : JSON.parse(text);
	} catch {
		return `(${Object.prototype.toString.call(value).slice(8, -1)})`;
	}
}

/** Edit distance for "did you mean" suggestions. */
export function editDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i++) {
		let diagonal = previous[0];
		previous[0] = i;
		for (let j = 1; j <= right.length; j++) {
			const above = previous[j];
			previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
			diagonal = above;
		}
	}
	return previous[right.length];
}

export function closest(name: string, candidates: readonly string[]): string | undefined {
	let best: { candidate: string; distance: number } | undefined;
	for (const candidate of candidates) {
		const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
		if (!best || distance < best.distance) best = { candidate, distance };
	}
	return best && best.distance <= Math.max(2, Math.floor(name.length / 3)) ? best.candidate : undefined;
}

class Issues {
	readonly list: ValidationIssue[] = [];

	add(path: string, problem: string, received: unknown, expected: string, hint: string): void {
		this.list.push({ path, problem, received: preview(received), expected, hint });
	}
}

function join(path: string, key: string): string {
	return path ? `${path}.${key}` : key;
}

function objectAt(raw: unknown, path: string, issues: Issues, hint: string): ObjectValue | undefined {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		issues.add(path || "(request)", "not an object", raw, "a JSON object", hint);
		return undefined;
	}
	return raw as ObjectValue;
}

function rejectUnknown(value: ObjectValue, allowed: readonly string[], path: string, issues: Issues): void {
	for (const key of Object.keys(value)) {
		if (allowed.includes(key)) continue;
		const suggestion = closest(key, allowed);
		const hint = /seed/i.test(key)
			? "The harness supplies every seed; remove this key."
			: suggestion
				? `Did you mean ${suggestion}? Allowed keys: ${allowed.join(", ")}.`
				: `Remove it. Allowed keys: ${allowed.join(", ")}.`;
		issues.add(join(path, key), "unknown key", key, `one of ${allowed.join(", ")}`, hint);
	}
}

function requiredString(value: unknown, path: string, issues: Issues, hint: string): string | undefined {
	if (typeof value !== "string" || value.trim().length === 0) {
		issues.add(path, value === undefined ? "missing" : "not a non-empty string", value, "a non-empty string", hint);
		return undefined;
	}
	return value;
}

function integerAtLeast(value: unknown, minimum: number, path: string, issues: Issues, hint: string): number | undefined {
	if (!Number.isInteger(value) || (value as number) < minimum) {
		issues.add(path, value === undefined ? "missing" : "must be an integer of at least " + minimum, value, `an integer >= ${minimum}`, hint);
		return undefined;
	}
	return value as number;
}

function pythonModule(value: unknown, path: string, issues: Issues): string | undefined {
	const module = requiredString(value, path, issues, "Name a project-relative .py file such as solutions/tasks/spam1.py.");
	if (module === undefined) return undefined;
	// Backslashes have platform-dependent path semantics. Requests use one
	// portable, project-relative representation regardless of harness host.
	if (
		module.includes("\\")
		|| module.includes("\0")
		|| isAbsolute(module)
		|| /^[A-Za-z]:/.test(module)
		|| posix.normalize(module) !== module
		|| module.split("/").some((part) => part === "" || part === "." || part === "..")
		|| !module.endsWith(".py")
	) {
		issues.add(path, "not a safe project-relative .py path", module, "a normalized relative path ending in .py, without '..'",
			"Use a forward-slash path relative to the project root, for example solutions/tasks/spam1.py.");
		return undefined;
	}
	return module;
}

interface JsonLimits {
	depth: number;
}

/** Validate and copy a JSON value. Returns undefined, with an issue, on the first non-JSON value. */
function jsonValue(raw: unknown, path: string, issues: Issues, limits?: JsonLimits, ancestors = new Set<object>(), depth = 0): JsonValue | undefined {
	const invalid = (at: string, received: unknown, problem = "not a finite JSON value") => {
		issues.add(at, problem, received, "finite JSON values: null, booleans, finite numbers, strings, arrays, and plain objects",
			"Replace it with a plain JSON value; NaN, Infinity, functions, dates, and cyclic objects cannot be persisted.");
		return undefined;
	};
	if (raw === null || typeof raw === "string" || typeof raw === "boolean") return raw;
	if (typeof raw === "number") return Number.isFinite(raw) ? raw : invalid(path, raw);
	if (typeof raw !== "object") return invalid(path, raw);
	if (ancestors.has(raw)) return invalid(path, "(cycle)", "contains a cycle");
	if (limits && depth >= limits.depth) {
		issues.add(path, "nested too deeply", "(nested value)", `at most ${limits.depth} levels of nesting`,
			"Flatten the structure; pass structural choices as short names the factory interprets.");
		return undefined;
	}

	ancestors.add(raw);
	try {
		if (Array.isArray(raw)) {
			const keys = Object.keys(raw);
			if (keys.length !== raw.length || keys.some((key, index) => key !== String(index))) return invalid(path, "(sparse array)");
			const values: JsonValue[] = [];
			let valid = true;
			for (const [index, entry] of raw.entries()) {
				const value = jsonValue(entry, `${path}[${index}]`, issues, limits, ancestors, depth + 1);
				if (value === undefined) valid = false;
				else values.push(value);
			}
			return valid ? values : undefined;
		}
		const prototype = Object.getPrototypeOf(raw);
		if (prototype !== Object.prototype && prototype !== null) return invalid(path, raw);
		const value: Record<string, JsonValue> = {};
		let valid = true;
		for (const [key, entry] of Object.entries(raw)) {
			const parsed = jsonValue(entry, `${path}.${key}`, issues, limits, ancestors, depth + 1);
			if (parsed === undefined) valid = false;
			else value[key] = parsed;
		}
		return valid ? value : undefined;
	} finally {
		ancestors.delete(raw);
	}
}

function boundedFixed(raw: unknown, path: string, issues: Issues): JsonValue | undefined {
	const before = issues.list.length;
	const value = jsonValue(raw, path, issues, { depth: SEARCH_LIMITS.maxFixedDepth });
	if (value === undefined || issues.list.length !== before) return undefined;
	const bytes = Buffer.byteLength(JSON.stringify(value));
	if (bytes > SEARCH_LIMITS.maxFixedBytes) {
		issues.add(path, "too large", `${bytes} bytes`, `at most ${SEARCH_LIMITS.maxFixedBytes} bytes of JSON`,
			"Keep fixed parameters small; put large data or vocabularies in a committed module under solutions/.");
		return undefined;
	}
	return value;
}

function parsePipeline(raw: unknown, version: 1 | 2, issues: Issues): PipelineRequest | undefined {
	const value = objectAt(raw, "pipeline", issues, "Provide {module, factory, parameters?}.");
	if (!value) return undefined;
	const allowed = version === 2 ? ["module", "factory", "parameters", "estimatorParams"] : ["module", "factory", "parameters"];
	if (version === 1 && Object.hasOwn(value, "estimatorParams")) {
		issues.add("pipeline.estimatorParams", "requires schemaVersion 2", "estimatorParams", "schemaVersion 2",
			"Set schemaVersion to 2 to fix set_params values.");
	}
	rejectUnknown(value, version === 1 ? [...allowed, "estimatorParams"] : allowed, "pipeline", issues);
	const module = pythonModule(value.module, "pipeline.module", issues);
	const factory = requiredString(value.factory, "pipeline.factory", issues, "Name the callable that builds the unfitted pipeline, e.g. build_pipeline.");
	const parameters = Object.hasOwn(value, "parameters") ? boundedFixed(value.parameters, "pipeline.parameters", issues) : undefined;
	let estimatorParams: Record<string, JsonValue> | undefined;
	if (version === 2 && Object.hasOwn(value, "estimatorParams")) {
		const params = objectAt(value.estimatorParams, "pipeline.estimatorParams", issues,
			"Map get_params() names to values, for example {\"model__C\": 0.5}.");
		if (params) {
			estimatorParams = {};
			for (const [name, entry] of Object.entries(params)) {
				const path = `pipeline.estimatorParams.${name}`;
				if (!parameterName(name)) {
					issues.add(path, "not a valid parameter name", name, "a get_params() name such as model__max_depth",
						"Use the names printed by pipeline.get_params(deep=True).keys().");
					continue;
				}
				if (isSeedParameter(name)) {
					issues.add(path, "seeds are harness-owned", name, "a parameter other than random_state", SEED_HINT);
					continue;
				}
				const parsed = boundedFixed(entry, path, issues);
				if (parsed !== undefined) estimatorParams[name] = parsed;
			}
			if (Object.keys(estimatorParams).length === Object.keys(params).length) {
				boundedFixed(estimatorParams, "pipeline.estimatorParams", issues);
			}
		}
	}
	if (module === undefined || factory === undefined) return undefined;
	return {
		module,
		factory,
		...(!Object.hasOwn(value, "parameters") || parameters === undefined ? {} : { parameters }),
		...(estimatorParams === undefined ? {} : { estimatorParams }),
	};
}

function parseCv(raw: unknown, issues: Issues): CvRequest | undefined {
	const value = objectAt(raw, "cv", issues, 'Use {"kind": "builtin", "scheme": "stratified_kfold", "folds": 5, "repeats": 1}.');
	if (!value) return undefined;
	if (value.kind === "builtin") {
		rejectUnknown(value, ["kind", "scheme", "folds", "repeats"], "cv", issues);
		if (!["stratified_kfold", "kfold", "group_kfold"].includes(String(value.scheme))) {
			issues.add("cv.scheme", "unsupported built-in scheme", value.scheme, '"stratified_kfold", "kfold", or "group_kfold"',
				"Choose a supported scheme, or a factory CV for any other splitting logic.");
		}
		const folds = integerAtLeast(value.folds, 2, "cv.folds", issues, "Use at least two folds.");
		const repeats = integerAtLeast(value.repeats, 1, "cv.repeats", issues, "Use 1 for a single partition.");
		if (folds === undefined || repeats === undefined || !["stratified_kfold", "kfold", "group_kfold"].includes(String(value.scheme))) return undefined;
		return { kind: "builtin", scheme: value.scheme as BuiltinCvRequest["scheme"], folds, repeats } satisfies BuiltinCvRequest;
	}
	if (value.kind === "factory") {
		rejectUnknown(value, ["kind", "module", "factory", "repeats", "options"], "cv", issues);
		const module = pythonModule(value.module, "cv.module", issues);
		const factory = requiredString(value.factory, "cv.factory", issues, "Name the callable that returns a splitter or split pairs.");
		const repeats = integerAtLeast(value.repeats, 1, "cv.repeats", issues, "Use 1 for a single partition.");
		const options = Object.hasOwn(value, "options") ? jsonValue(value.options, "cv.options", issues) : undefined;
		if (module === undefined || factory === undefined || repeats === undefined) return undefined;
		if (Object.hasOwn(value, "options") && options === undefined) return undefined;
		return {
			kind: "factory", module, factory, repeats,
			...(!Object.hasOwn(value, "options") ? {} : { options: options! }),
		} satisfies FactoryCvRequest;
	}
	issues.add("cv.kind", "unknown CV kind", value.kind, '"builtin" or "factory"',
		"Use builtin stratified K-fold, or point a factory CV at your own splitter module.");
	return undefined;
}

function parseScope(raw: unknown, issues: Issues): ExperimentScope | undefined {
	const value = objectAt(raw, "scope", issues, 'Use {"kind": "pilot", "maxRows": 2000} or {"kind": "promotion"}.');
	if (!value) return undefined;
	if (value.kind === "promotion") {
		rejectUnknown(value, ["kind"], "scope", issues);
		return { kind: "promotion" };
	}
	if (value.kind === "pilot") {
		rejectUnknown(value, ["kind", "maxRows", "maxFolds"], "scope", issues);
		const maxRows = value.maxRows === undefined ? undefined : integerAtLeast(value.maxRows, 2, "scope.maxRows", issues, "Use at least two rows so both classes can appear.");
		const maxFolds = value.maxFolds === undefined ? undefined : integerAtLeast(value.maxFolds, 1, "scope.maxFolds", issues, "Use at least one fold.");
		return {
			kind: "pilot",
			...(maxRows === undefined ? {} : { maxRows }),
			...(maxFolds === undefined ? {} : { maxFolds }),
		};
	}
	issues.add("scope.kind", "unknown scope", value.kind, '"pilot" or "promotion"',
		"Start with a pilot; request promotion only for complete validation.");
	return undefined;
}

const SEED_HINT = "The harness overwrites every random_state with derived seeds; remove it from the request.";

function isSeedParameter(name: string): boolean {
	return name === "random_state" || name.endsWith("__random_state");
}

function parameterName(name: string): boolean {
	return name.split("__").every((part) => PARAMETER_NAME.test(part));
}

function isScalar(value: unknown): value is JsonScalar {
	return value === null || typeof value === "string" || typeof value === "boolean"
		|| (typeof value === "number" && Number.isFinite(value));
}

/** Python compares True == 1 and False == 0, so those would collide in the sampler. */
function scalarKey(value: JsonScalar): string {
	if (typeof value === "boolean") return `n:${value ? 1 : 0}`;
	if (typeof value === "number") return `n:${value}`;
	return `${value === null ? "null" : "s"}:${value}`;
}

function parseDistribution(raw: unknown, path: string, issues: Issues, sampler: SearchSampler): SearchDistribution | undefined {
	const value = objectAt(raw, path, issues, 'Use {"type": "int"|"float", "low", "high"} or {"type": "categorical", "choices": [...]}.');
	if (!value) return undefined;
	const before = issues.list.length;
	if (value.type === "categorical") {
		rejectUnknown(value, ["type", "choices"], path, issues);
		const choices = value.choices;
		if (!Array.isArray(choices) || choices.length === 0) {
			issues.add(`${path}.choices`, "must be a non-empty list", choices, "a non-empty list of JSON scalars",
				"List the values to try, for example [\"sqrt\", \"log2\", 0.3].");
			return undefined;
		}
		if (choices.length > SEARCH_LIMITS.maxChoices) {
			issues.add(`${path}.choices`, "too many choices", `${choices.length} choices`, `at most ${SEARCH_LIMITS.maxChoices}`,
				"Search a numeric range with type int or float instead of enumerating values.");
		}
		const seen = new Map<string, number>();
		choices.forEach((choice, index) => {
			if (!isScalar(choice)) {
				issues.add(`${path}.choices[${index}]`, "not a JSON scalar", choice, "null, a boolean, a finite number, or a string",
					"Encode structured choices as a name the factory interprets, and search it with a factory. parameter.");
				return;
			}
			const key = scalarKey(choice);
			if (seen.has(key)) {
				issues.add(`${path}.choices[${index}]`, "duplicate choice", choice, "distinct values",
					`It repeats choices[${seen.get(key)}]${typeof choice === "boolean" || typeof choices[seen.get(key)!] === "boolean" ? " (Python treats true as 1 and false as 0)" : ""}; remove one.`);
				return;
			}
			seen.set(key, index);
		});
		return issues.list.length === before ? { type: "categorical", choices: choices as JsonScalar[] } : undefined;
	}
	if (value.type === "int" || value.type === "float") {
		const isInt = value.type === "int";
		rejectUnknown(value, isInt ? ["type", "low", "high", "step", "log"] : ["type", "low", "high", "log"], path, issues);
		const bound = (key: "low" | "high") => {
			const entry = value[key];
			const ok = isInt ? Number.isSafeInteger(entry) : typeof entry === "number" && Number.isFinite(entry);
			if (!ok) {
				issues.add(`${path}.${key}`, entry === undefined ? "missing" : `not a finite ${isInt ? "integer" : "number"}`, entry,
					isInt ? "a finite integer" : "a finite number", `Give the ${key === "low" ? "smallest" : "largest"} value to try.`);
				return undefined;
			}
			return entry as number;
		};
		const low = bound("low");
		const high = bound("high");
		if (low !== undefined && high !== undefined && !(low < high)) {
			issues.add(`${path}.high`, "must be greater than low", high, `a value above ${low}`,
				low === high ? "To fix one value, move it to pipeline.estimatorParams or pipeline.parameters." : "Swap low and high.");
		}
		if (value.log !== undefined && typeof value.log !== "boolean") {
			issues.add(`${path}.log`, "not a boolean", value.log, "true or false", "Use true to sample on a log scale.");
		}
		if (value.log === true && low !== undefined && !(low > 0)) {
			issues.add(`${path}.log`, "log scale requires low > 0", low, "low > 0 when log is true",
				"Raise low above zero, or set log to false.");
		}
		let step: number | undefined;
		if (isInt && value.step !== undefined) {
			if (!Number.isSafeInteger(value.step) || (value.step as number) <= 0) {
				issues.add(`${path}.step`, "must be a positive integer", value.step, "an integer >= 1", "Use 1 to try every integer.");
			} else {
				step = value.step as number;
				if (value.log === true) {
					issues.add(`${path}.step`, "step cannot be combined with log", step, "either step or log",
						"Remove step to sample on a log scale, or remove log to use evenly spaced values.");
				} else if (low !== undefined && high !== undefined && low < high && (high - low) % step !== 0) {
					issues.add(`${path}.step`, "does not divide the range", step, `a step dividing high - low = ${high - low}`,
						`Adjust high to ${low + Math.floor((high - low) / step) * step} or choose a step that divides ${high - low}.`);
				}
			}
		}
		if (!isInt && sampler === "grid") {
			issues.add(`${path}.type`, "grid needs a finite space", "float", "int or categorical parameters",
				"List explicit values with type categorical, or use the tpe or random sampler.");
		}
		if (issues.list.length !== before || low === undefined || high === undefined) return undefined;
		return isInt
			? { type: "int", low, high, ...(step === undefined ? {} : { step }), ...(value.log === undefined ? {} : { log: value.log as boolean }) }
			: { type: "float", low, high, ...(value.log === undefined ? {} : { log: value.log as boolean }) };
	}
	issues.add(`${path}.type`, value.type === undefined ? "missing" : "unknown search type", value.type, '"int", "float", or "categorical"',
		"Use int or float with low/high, or categorical with choices.");
	return undefined;
}

export function distributionSize(distribution: SearchDistribution): number {
	if (distribution.type === "categorical") return distribution.choices.length;
	if (distribution.type === "int") return Math.floor((distribution.high - distribution.low) / (distribution.step ?? 1)) + 1;
	return Number.POSITIVE_INFINITY;
}

function parseSearch(raw: unknown, pipeline: PipelineRequest | undefined, issues: Issues): SearchRequest | undefined {
	const value = objectAt(raw, "search", issues, "Provide {space, sampler, maxConfigs, pruning}.");
	if (!value) return undefined;
	rejectUnknown(value, ["space", "sampler", "maxConfigs", "pruning", "acceptEstimatedSeconds", "objective"], "search", issues);
	const before = issues.list.length;
	let objective: ProxyObjective | undefined;
	if (value.objective !== undefined) {
		const raw = objectAt(value.objective, "search.objective", issues, "Declare the proxy metric and its direction.");
		if (raw) {
			rejectUnknown(raw, ["kind", "metric", "direction"], "search.objective", issues);
			if (raw.kind !== "proxy") issues.add("search.objective.kind", "unsupported objective", raw.kind, "proxy", "Trusted primary scoring is supplied by the controller; omit objective to use it.");
			if (!["silhouette", "calinskiHarabasz", "daviesBouldin", "dbcv", "estimator_score", "evidence_roc_auc", "evidence_average_precision"].includes(String(raw.metric)))
				issues.add("search.objective.metric", "unsupported metric", raw.metric, "a supported proxy metric", "Choose geometry or the estimator's explicit score().");
			if (!["maximize", "minimize"].includes(String(raw.direction))) issues.add("search.objective.direction", "missing or invalid direction", raw.direction, "maximize or minimize", "Declare which direction is preferable.");
			objective = raw as unknown as ProxyObjective;
		}
	}
	let sampler: SearchSampler = "tpe";
	if (value.sampler !== undefined) {
		if (!SAMPLERS.includes(value.sampler as SearchSampler)) {
			issues.add("search.sampler", "unknown sampler", value.sampler, '"tpe", "random", or "grid"',
				`${closest(String(value.sampler), SAMPLERS) ? `Did you mean ${closest(String(value.sampler), SAMPLERS)}? ` : ""}Use tpe for guided search, random as a baseline, or grid for small finite spaces.`);
		} else {
			sampler = value.sampler as SearchSampler;
		}
	}
	const space: Record<string, SearchDistribution> = {};
	const rawSpace = objectAt(value.space, "search.space", issues,
		'Map parameter names to distributions, e.g. {"model__max_depth": {"type": "int", "low": 4, "high": 40}}.');
	if (rawSpace) {
		const names = Object.keys(rawSpace);
		if (names.length === 0) {
			issues.add("search.space", "empty", {}, "at least one searched parameter",
				"Add a parameter, or omit search to run a single configuration.");
		}
		if (names.length > SEARCH_LIMITS.maxParameters) {
			issues.add("search.space", "too many searched parameters", `${names.length} parameters`, `at most ${SEARCH_LIMITS.maxParameters}`,
				"Fix the parameters a pilot showed to matter little and search the rest.");
		}
		const fixedFactory = pipeline?.parameters;
		for (const name of names) {
			const path = `search.space.${name}`;
			if (name.startsWith(FACTORY_PREFIX)) {
				const key = name.slice(FACTORY_PREFIX.length);
				if (!PARAMETER_NAME.test(key)) {
					issues.add(path, "not a valid factory parameter name", name, "factory.<identifier>",
						"Use the key your factory reads from context[\"parameters\"], e.g. factory.features.");
					continue;
				}
				if (fixedFactory !== undefined && (fixedFactory === null || typeof fixedFactory !== "object" || Array.isArray(fixedFactory))) {
					issues.add("pipeline.parameters", "must be an object when factory. parameters are searched", fixedFactory, "a JSON object",
						"Searched factory values are merged into pipeline.parameters, so it must be an object.");
				} else if (fixedFactory && Object.hasOwn(fixedFactory, key)) {
					issues.add(path, "both fixed and searched", name, `${key} in either pipeline.parameters or the search space`,
						`Remove ${key} from pipeline.parameters to search it, or remove ${name} to keep it fixed.`);
				}
			} else {
				if (!parameterName(name)) {
					const suggestion = name.includes(".") ? ` For a factory input, write factory.${name.split(".").pop()}.` : "";
					issues.add(path, "not a valid parameter name", name, "a get_params() name such as model__max_depth, or factory.<name>",
						`Use the names printed by pipeline.get_params(deep=True).keys().${suggestion}`);
					continue;
				}
				if (isSeedParameter(name)) {
					issues.add(path, "seeds are harness-owned", name, "a parameter other than random_state", SEED_HINT);
					continue;
				}
				if (pipeline?.estimatorParams && Object.hasOwn(pipeline.estimatorParams, name)) {
					issues.add(path, "both fixed and searched", name, `${name} in either pipeline.estimatorParams or the search space`,
						`Remove ${name} from pipeline.estimatorParams to search it, or remove it from the space to keep it fixed.`);
				}
			}
			const distribution = parseDistribution(rawSpace[name], path, issues, sampler);
			if (distribution) space[name] = distribution;
		}
	}
	let maxConfigs: number | undefined;
	if (value.maxConfigs !== undefined) {
		maxConfigs = integerAtLeast(value.maxConfigs, 1, "search.maxConfigs", issues, "Use a small number first; a search counts as one experiment.");
		if (maxConfigs !== undefined && maxConfigs > SEARCH_LIMITS.maxConfigs) {
			issues.add("search.maxConfigs", "above the cap", maxConfigs, `at most ${SEARCH_LIMITS.maxConfigs}`,
				"Narrow the space or split the idea into separate searches.");
			maxConfigs = undefined;
		}
	} else if (sampler !== "grid") {
		issues.add("search.maxConfigs", "missing", undefined, `an integer from 1 to ${SEARCH_LIMITS.maxConfigs}`,
			`The ${sampler} sampler needs an explicit number of configurations; start with 10-20 on a pilot scope.`);
	}
	if (sampler === "grid" && Object.keys(space).length === Object.keys(rawSpace ?? {}).length && Object.keys(space).length > 0) {
		const size = Object.values(space).reduce((product, distribution) => product * distributionSize(distribution), 1);
		if (size > SEARCH_LIMITS.maxGridSize) {
			issues.add("search.space", "grid too large", `${size} configurations`, `at most ${SEARCH_LIMITS.maxGridSize}`,
				"Use fewer values per parameter, a step for int ranges, or the tpe sampler with maxConfigs.");
		}
	}
	if (value.pruning !== undefined && typeof value.pruning !== "boolean") {
		issues.add("search.pruning", "not a boolean", value.pruning, "true or false", "Set true to stop clearly worse configurations early.");
	}
	const accept = value.acceptEstimatedSeconds;
	if (accept !== undefined && !(typeof accept === "number" && Number.isFinite(accept) && accept > 0 && accept <= SEARCH_LIMITS.maxAcceptSeconds)) {
		issues.add("search.acceptEstimatedSeconds", "not a positive number of seconds", accept, `a number in (0, ${SEARCH_LIMITS.maxAcceptSeconds}]`,
			"Copy the projected seconds from the runtime guard's explanation after deciding the cost is worth it.");
	}
	if (issues.list.length !== before) return undefined;
	return {
		space,
		...(objective ? { objective } : {}),
		...(value.sampler === undefined ? {} : { sampler }),
		...(maxConfigs === undefined ? {} : { maxConfigs }),
		...(value.pruning === undefined ? {} : { pruning: value.pruning as boolean }),
		...(accept === undefined ? {} : { acceptEstimatedSeconds: accept as number }),
	};
}

const V1_KEYS = ["schemaVersion", "hypothesis", "pipeline", "cv", "scope"] as const;
function parseDiagnostics(raw: unknown, issues: Issues): DiagnosticRequest | undefined {
	const value = objectAt(raw, "diagnostics", issues, "Declare only the extra measurements you need.");
	if (!value) return undefined;
	rejectUnknown(value, ["representation", "predictionStrength", "modelSignals", "challenge", "volume", "contamination"], "diagnostics", issues);
	if (value.predictionStrength !== undefined && typeof value.predictionStrength !== "boolean")
		issues.add("diagnostics.predictionStrength", "not a boolean", value.predictionStrength, "true or false", "This requests one additional harness-owned fit per fold.");
	if (value.representation !== undefined) {
		const spec = objectAt(value.representation, "diagnostics.representation", issues, "Choose pipeline_features or a fitted-estimator method.");
		if (spec) {
			rejectUnknown(spec, ["source", "method", "metric", "maxRows", "dbcv"], "diagnostics.representation", issues);
			if (!["pipeline_features", "method"].includes(String(spec.source))) issues.add("diagnostics.representation.source", "unsupported source", spec.source, "pipeline_features or method", "Use the already fitted feature prefix or a custom measurement method.");
			if (spec.source === "method" && !diagnosticMethod(spec.method))
				issues.add("diagnostics.representation.method", "missing or invalid method", spec.method, "a public Python method name", "The method returns features for the supplied frame without fitting.");
			if (spec.source === "pipeline_features" && spec.method !== undefined) issues.add("diagnostics.representation.method", "does not apply", spec.method, "no method for pipeline_features", "Remove method.");
			if (spec.metric !== undefined && !["euclidean", "cosine"].includes(String(spec.metric))) issues.add("diagnostics.representation.metric", "unsupported distance", spec.metric, "euclidean or cosine", "Match the representation's geometry.");
			if (spec.maxRows !== undefined && (!Number.isInteger(spec.maxRows) || (spec.maxRows as number) < 3 || (spec.maxRows as number) > 2048))
				issues.add("diagnostics.representation.maxRows", "outside diagnostic bounds", spec.maxRows, "integer from 3 to 2048", "This bounds pairwise diagnostic cost, without limiting model inputs.");
			if (spec.dbcv !== undefined && typeof spec.dbcv !== "boolean") issues.add("diagnostics.representation.dbcv", "not a boolean", spec.dbcv, "true or false", "Enable density validation explicitly.");
		}
	}
	for (const key of ["modelSignals", "challenge"] as const) {
		if (value[key] === undefined) continue;
		const path = `diagnostics.${key}`;
		const spec = objectAt(value[key], path, issues, "Name a public method on the fitted estimator.");
		if (!spec) continue;
		rejectUnknown(spec, key === "modelSignals" ? ["method", "maxRows", "compareTrain", "units"] : ["method", "maxRows"], path, issues);
		if (!diagnosticMethod(spec.method)) issues.add(`${path}.method`, "invalid method", spec.method, "a public read-only Python method", "The method must not fit models.");
		if (spec.maxRows !== undefined && (!Number.isInteger(spec.maxRows) || (spec.maxRows as number) < 2 || (spec.maxRows as number) > 2048)) issues.add(`${path}.maxRows`, "outside diagnostic bounds", spec.maxRows, "integer from 2 to 2048", "Bound diagnostic cost independently of fitting.");
		if (spec.compareTrain !== undefined && typeof spec.compareTrain !== "boolean") issues.add(`${path}.compareTrain`, "not a boolean", spec.compareTrain, "true or false", "Train-row measurements are advisory resubstitution evidence.");
		if (spec.units !== undefined && (typeof spec.units !== "string" || !spec.units.length || spec.units.length > 200)) issues.add(`${path}.units`, "invalid units", spec.units, "nonempty string up to 200 characters", "Declare the output scale.");
	}
	if (value.volume !== undefined) {
		const spec = objectAt(value.volume, "diagnostics.volume", issues, "Declare bounded support in the fitted feature space.");
		if (spec) {
			rejectUnknown(spec, ["bounds", "scoreSource", "scoreMethod", "uniformSamples"], "diagnostics.volume", issues);
			if (!["pipeline_model", "method"].includes(String(spec.scoreSource))) issues.add("diagnostics.volume.scoreSource", "unsupported source", spec.scoreSource, "pipeline_model or method", "Score uniform reference points with the fitted model.");
			if (!diagnosticMethod(spec.scoreMethod)) issues.add("diagnostics.volume.scoreMethod", "invalid method", spec.scoreMethod, "a public read-only Python method", "The method accepts a feature matrix and returns row-aligned scores.");
			if (!Array.isArray(spec.bounds) || spec.bounds.length < 1 || spec.bounds.length > 6 || spec.bounds.some(pair => !Array.isArray(pair) || pair.length !== 2 || !pair.every(x => typeof x === "number" && Number.isFinite(x)) || pair[0] >= pair[1]))
				issues.add("diagnostics.volume.bounds", "invalid support", spec.bounds, "one to six finite increasing bound pairs", "Volume diagnostics are scoped to this declared low-dimensional box.");
			if (spec.uniformSamples !== undefined && (!Number.isInteger(spec.uniformSamples) || (spec.uniformSamples as number) < 32 || (spec.uniformSamples as number) > 8192)) issues.add("diagnostics.volume.uniformSamples", "outside diagnostic bounds", spec.uniformSamples, "integer from 32 to 8192", "Use bounded Monte Carlo sampling.");
			if (value.representation === undefined) issues.add("diagnostics.volume", "missing representation", spec, "diagnostics.representation", "Declare the feature space used for volume.");
		}
	}
	if (value.contamination !== undefined) {
		const spec = objectAt(value.contamination, "diagnostics.contamination", issues, "Declare the estimator parameter and nearby contamination fractions.");
		if (spec) {
			rejectUnknown(spec, ["parameter", "values"], "diagnostics.contamination", issues);
			if (typeof spec.parameter !== "string" || !parameterName(spec.parameter) || isSeedParameter(spec.parameter)) issues.add("diagnostics.contamination.parameter", "invalid or seed parameter", spec.parameter, "a non-seed set_params name", "The harness retains control of randomness.");
			if (!Array.isArray(spec.values) || spec.values.length < 1 || spec.values.length > 5 || spec.values.some(x => typeof x !== "number" || !Number.isFinite(x) || x <= 0 || x >= 1) || new Set(spec.values).size !== spec.values.length)
				issues.add("diagnostics.contamination.values", "invalid fractions", spec.values, "one to five unique fractions in (0,1)", "Each value may request an additional harness-owned fit.");
		}
	}
	return value as DiagnosticRequest;
}

const V2_KEYS = ["schemaVersion", "hypothesis", "commit", "pipeline", "search", "diagnostics", "cv", "scope"] as const;

/** Collect every structural problem. `request` is set only when there are none. */
export function validateExperimentRequest(raw: unknown): { request?: ExperimentRequest; issues: ValidationIssue[] } {
	const issues = new Issues();
	const value = objectAt(raw, "", issues, "Send the experiment as one JSON object.");
	if (!value) return { issues: issues.list };
	let version: 1 | 2 = 1;
	if (value.schemaVersion === 2) version = 2;
	else if (value.schemaVersion !== 1) {
		issues.add("schemaVersion", value.schemaVersion === undefined ? "missing" : "unsupported version", value.schemaVersion, "1 or 2",
			"Use 2; version 1 remains accepted for single-configuration requests without commit or search.");
	}
	if (version === 1) {
		for (const key of ["commit", "search"] as const) {
			if (Object.hasOwn(value, key)) {
				issues.add(key, "requires schemaVersion 2", key, "schemaVersion 2", `Set schemaVersion to 2 to use ${key}.`);
			}
		}
	}
	rejectUnknown(value, version === 2 ? V2_KEYS : [...V1_KEYS, "commit", "search"], "", issues);
	const hypothesis = requiredString(value.hypothesis, "hypothesis", issues, "State what this experiment tests and why.");
	let commit: string | undefined;
	if (version === 2 && value.commit !== undefined) {
		commit = requiredString(value.commit, "commit", issues, "Use HEAD, a branch name, or a commit hash from the solutions repository.");
		if (commit !== undefined && !/^[A-Za-z0-9._/@^~{}-]{1,200}$/.test(commit) || commit?.startsWith("-")) {
			issues.add("commit", "not a revision name", commit, "HEAD, a branch name, a tag, or a commit hash",
				"Use a plain revision such as HEAD, main, or 3f2a9c1.");
			commit = undefined;
		}
	}
	const pipeline = parsePipeline(value.pipeline, version, issues);
	const search = version === 2 && value.search !== undefined ? parseSearch(value.search, pipeline, issues) : undefined;
	const diagnostics = version === 2 && value.diagnostics !== undefined ? parseDiagnostics(value.diagnostics, issues) : undefined;
	const cv = parseCv(value.cv, issues);
	const scope = parseScope(value.scope, issues);
	if (issues.list.length > 0 || hypothesis === undefined || pipeline === undefined || cv === undefined || scope === undefined) {
		return { issues: issues.list };
	}
	return {
		request: {
			schemaVersion: version,
			hypothesis,
			...(commit === undefined ? {} : { commit }),
			pipeline,
			...(search === undefined ? {} : { search }),
			...(diagnostics === undefined ? {} : { diagnostics }),
			cv,
			scope,
		},
		issues: [],
	};
}

/** Parse untrusted agent input into the versioned, seed-free experiment contract. */
export function parseExperimentRequest(raw: unknown): ExperimentRequest {
	const { request, issues } = validateExperimentRequest(raw);
	if (!request) throw new ExperimentRequestError(issues);
	return request;
}
