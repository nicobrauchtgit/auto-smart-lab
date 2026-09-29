import { isAbsolute, posix } from "node:path";

import type {
	BuiltinCvRequest,
	CvRequest,
	ExperimentRequest,
	ExperimentScope,
	FactoryCvRequest,
	JsonValue,
	PipelineRequest,
} from "./types.js";

type ObjectValue = Record<string, unknown>;

function objectAt(raw: unknown, path: string): ObjectValue {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`${path} must be an object`);
	}
	return raw as ObjectValue;
}

function rejectUnknown(value: ObjectValue, allowed: readonly string[], path: string): void {
	const known = new Set(allowed);
	const unknown = Object.keys(value).filter((key) => !known.has(key));
	if (unknown.length > 0) throw new Error(`unknown ${path} keys: ${unknown.join(", ")}`);
}

function requiredString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`${path} must be a non-empty string`);
	}
	return value;
}

function integerAtLeast(value: unknown, minimum: number, path: string): number {
	if (!Number.isInteger(value) || (value as number) < minimum) {
		throw new Error(`${path} must be an integer of at least ${minimum}`);
	}
	return value as number;
}

function pythonModule(value: unknown, path: string): string {
	const module = requiredString(value, path);
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
		throw new Error(`${path} must be a safe project-relative .py path`);
	}
	return module;
}

function jsonValue(raw: unknown, path: string, ancestors = new Set<object>()): JsonValue {
	if (raw === null || typeof raw === "string" || typeof raw === "boolean") return raw;
	if (typeof raw === "number") {
		if (!Number.isFinite(raw)) throw new Error(`${path} must contain only finite JSON values`);
		return raw;
	}
	if (typeof raw !== "object") throw new Error(`${path} must contain only finite JSON values`);
	if (ancestors.has(raw)) throw new Error(`${path} must contain only finite JSON values`);

	ancestors.add(raw);
	try {
		if (Array.isArray(raw)) {
			const keys = Object.keys(raw);
			if (keys.length !== raw.length || keys.some((key, index) => key !== String(index))) {
				throw new Error(`${path} must contain only finite JSON values`);
			}
			return raw.map((entry, index) => jsonValue(entry, `${path}[${index}]`, ancestors));
		}
		const prototype = Object.getPrototypeOf(raw);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new Error(`${path} must contain only finite JSON values`);
		}
		const value: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(raw)) {
			value[key] = jsonValue(entry, `${path}.${key}`, ancestors);
		}
		return value;
	} finally {
		ancestors.delete(raw);
	}
}

function parsePipeline(raw: unknown): PipelineRequest {
	const value = objectAt(raw, "experiment.pipeline");
	rejectUnknown(value, ["module", "factory", "parameters"], "experiment.pipeline");
	return {
		module: pythonModule(value.module, "experiment.pipeline.module"),
		factory: requiredString(value.factory, "experiment.pipeline.factory"),
		...(!Object.hasOwn(value, "parameters")
			? {}
			: { parameters: jsonValue(value.parameters, "experiment.pipeline.parameters") }),
	};
}

function parseCv(raw: unknown): CvRequest {
	const value = objectAt(raw, "experiment.cv");
	if (value.kind === "builtin") {
		rejectUnknown(value, ["kind", "scheme", "folds", "repeats"], "experiment.cv");
		if (value.scheme !== "stratified_kfold") {
			throw new Error('experiment.cv.scheme must be "stratified_kfold"');
		}
		return {
			kind: "builtin",
			scheme: "stratified_kfold",
			folds: integerAtLeast(value.folds, 2, "experiment.cv.folds"),
			repeats: integerAtLeast(value.repeats, 1, "experiment.cv.repeats"),
		} satisfies BuiltinCvRequest;
	}
	if (value.kind === "factory") {
		rejectUnknown(value, ["kind", "module", "factory", "repeats", "options"], "experiment.cv");
		return {
			kind: "factory",
			module: pythonModule(value.module, "experiment.cv.module"),
			factory: requiredString(value.factory, "experiment.cv.factory"),
			repeats: integerAtLeast(value.repeats, 1, "experiment.cv.repeats"),
			...(!Object.hasOwn(value, "options")
				? {}
				: { options: jsonValue(value.options, "experiment.cv.options") }),
		} satisfies FactoryCvRequest;
	}
	throw new Error('experiment.cv.kind must be "builtin" or "factory"');
}

function parseScope(raw: unknown): ExperimentScope {
	const value = objectAt(raw, "experiment.scope");
	if (value.kind === "promotion") {
		rejectUnknown(value, ["kind"], "experiment.scope");
		return { kind: "promotion" };
	}
	if (value.kind === "pilot") {
		rejectUnknown(value, ["kind", "maxRows", "maxFolds"], "experiment.scope");
		return {
			kind: "pilot",
			...(value.maxRows === undefined
				? {}
				: { maxRows: integerAtLeast(value.maxRows, 2, "experiment.scope.maxRows") }),
			...(value.maxFolds === undefined
				? {}
				: { maxFolds: integerAtLeast(value.maxFolds, 1, "experiment.scope.maxFolds") }),
		};
	}
	throw new Error('experiment.scope.kind must be "pilot" or "promotion"');
}

/** Parse untrusted agent input into the versioned, seed-free experiment contract. */
export function parseExperimentRequest(raw: unknown): ExperimentRequest {
	const value = objectAt(raw, "experiment");
	rejectUnknown(value, ["schemaVersion", "hypothesis", "pipeline", "cv", "scope"], "experiment");
	if (value.schemaVersion !== 1) throw new Error("experiment.schemaVersion must be 1");
	return {
		schemaVersion: 1,
		hypothesis: requiredString(value.hypothesis, "experiment.hypothesis"),
		pipeline: parsePipeline(value.pipeline),
		cv: parseCv(value.cv),
		scope: parseScope(value.scope),
	};
}
