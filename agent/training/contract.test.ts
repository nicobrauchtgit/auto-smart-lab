import { describe, expect, test } from "bun:test";

import { ExperimentRequestError, parseExperimentRequest, validateExperimentRequest } from "./contract.js";
import type { ExperimentRequest, ValidationIssue } from "./types.js";

const validRequest = (): ExperimentRequest => ({
	schemaVersion: 1,
	hypothesis: "word bigrams improve minority recall",
	pipeline: {
		module: "solutions/tasks/spam1.py",
		factory: "build_pipeline",
		parameters: { C: 2.5, class_weight: null, enabled: true, ngrams: [1, 2] },
	},
	cv: { kind: "builtin", scheme: "stratified_kfold", folds: 5, repeats: 2 },
	scope: { kind: "pilot", maxRows: 2_000, maxFolds: 1 },
});

describe("parseExperimentRequest", () => {
	test("accepts a representative built-in CV pilot", () => {
		expect(parseExperimentRequest(validRequest())).toEqual(validRequest());
	});

	test("accepts a custom CV factory and promotion scope", () => {
		const request: ExperimentRequest = {
			schemaVersion: 1,
			hypothesis: "group-aware splits expose sender leakage",
			pipeline: { module: "solutions/spam.py", factory: "pipeline" },
			cv: {
				kind: "factory",
				module: "solutions/cv/grouped.py",
				factory: "make_splits",
				repeats: 3,
				options: { groupColumn: "sender", nested: [[true, null, 1.25]] },
			},
			scope: { kind: "promotion" },
		};
		expect(parseExperimentRequest(request)).toEqual(request);
	});

	test.each([
		["root", (request: any) => { request.extra = true; }],
		["pipeline", (request: any) => { request.pipeline.extra = true; }],
		["builtin CV", (request: any) => { request.cv.extra = true; }],
		["scope", (request: any) => { request.scope.extra = true; }],
	])("rejects unknown keys in %s", (_label, mutate) => {
		const request = validRequest();
		mutate(request);
		expect(() => parseExperimentRequest(request)).toThrow(/unknown key/);
	});

	test.each([
		["root", (request: any) => { request.seed = 13; }],
		["pipeline", (request: any) => { request.pipeline.seed = 13; }],
		["CV", (request: any) => { request.cv.seed = 13; }],
		["scope", (request: any) => { request.scope.seed = 13; }],
	])("rejects agent-owned seeds in %s", (_label, mutate) => {
		const request = validRequest();
		mutate(request);
		expect(() => parseExperimentRequest(request)).toThrow(/unknown key/);
	});

	test.each([
		"/tmp/pipeline.py",
		"../pipeline.py",
		"solutions/../pipeline.py",
		"./solutions/pipeline.py",
		"C:\\solutions\\pipeline.py",
		"solutions/pipeline.ts",
	])("rejects unsafe or non-Python pipeline module %s", (module) => {
		const request = validRequest();
		request.pipeline.module = module;
		expect(() => parseExperimentRequest(request)).toThrow(/safe project-relative \.py path/);
	});

	test("validates custom CV module paths too", () => {
		const request: any = validRequest();
		request.cv = {
			kind: "factory", module: "../outside.py", factory: "make_cv", repeats: 1,
		};
		expect(() => parseExperimentRequest(request)).toThrow(/cv\.module/);
	});

	test.each([
		["folds below two", (request: any) => { request.cv.folds = 1; }],
		["fractional folds", (request: any) => { request.cv.folds = 2.5; }],
		["repeats below one", (request: any) => { request.cv.repeats = 0; }],
		["pilot rows below two", (request: any) => { request.scope.maxRows = 1; }],
		["pilot folds below one", (request: any) => { request.scope.maxFolds = 0; }],
	])("rejects invalid numeric constraint: %s", (_label, mutate) => {
		const request = validRequest();
		mutate(request);
		expect(() => parseExperimentRequest(request)).toThrow(/must be an integer/);
	});

	test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"rejects non-finite JSON parameter %s",
		(value) => {
			const request = validRequest();
			request.pipeline.parameters = { nested: [value] };
			expect(() => parseExperimentRequest(request)).toThrow(/finite JSON values/);
		},
	);

	test("rejects non-JSON values in custom CV options", () => {
		const request: any = validRequest();
		request.cv = {
			kind: "factory",
			module: "solutions/cv.py",
			factory: "make_cv",
			repeats: 1,
			options: { callback: () => undefined },
		};
		expect(() => parseExperimentRequest(request)).toThrow(/finite JSON values/);
	});

	test.each([new Date(), new Map(), undefined, 1n])(
		"rejects runtime values that JSON cannot represent",
		(value) => {
			const request = validRequest();
			request.pipeline.parameters = value as any;
			expect(() => parseExperimentRequest(request)).toThrow(/finite JSON values/);
		},
	);

	test("rejects cyclic JSON-like objects", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const request = validRequest();
		request.pipeline.parameters = cyclic as any;
		expect(() => parseExperimentRequest(request)).toThrow(/finite JSON values/);
	});
});

describe("schema version 2 structural validation", () => {
	const v2 = (search?: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
		schemaVersion: 2,
		hypothesis: "deeper trees help the minority class",
		commit: "HEAD",
		pipeline: { module: "solutions/tasks/spam1.py", factory: "build_pipeline", parameters: { features: "word" } },
		...(search ? { search } : {}),
		cv: { kind: "builtin", scheme: "stratified_kfold", folds: 5, repeats: 1 },
		scope: { kind: "pilot", maxRows: 4000 },
		...extra,
	});
	const issues = (raw: unknown) => validateExperimentRequest(raw).issues;
	const shape = (issue: ValidationIssue) => {
		expect(Object.keys(issue).filter((key) => key !== "message").sort()).toEqual(["expected", "hint", "path", "problem", "received"]);
		expect(issue.hint.length).toBeGreaterThan(10);
	};

	test("accepts the documented search request unchanged", () => {
		const request = v2({
			space: {
				model__n_estimators: { type: "int", low: 100, high: 800, step: 100 },
				model__max_depth: { type: "int", low: 4, high: 40, log: true },
				model__max_features: { type: "categorical", choices: ["sqrt", "log2", 0.3] },
				"factory.ngrams": { type: "categorical", choices: [1, 2] },
			},
			sampler: "tpe", maxConfigs: 40, pruning: true, acceptEstimatedSeconds: 600,
		});
		expect(parseExperimentRequest(request)).toEqual(request as any);
	});

	test.each([
		["unknown key at the root", v2(undefined, { searh: {} }), "searh", "unknown key"],
		["unknown key in search", v2({ space: { a: { type: "int", low: 1, high: 2 } }, maxConfigs: 2, samplr: "tpe" }), "search.samplr", "unknown key"],
		["unknown key in a distribution", v2({ space: { a: { type: "float", low: 1, high: 2, step: 0.1 } }, maxConfigs: 2 }), "search.space.a.step", "unknown key"],
		["non-finite bound", v2({ space: { a: { type: "float", low: 0, high: Number.POSITIVE_INFINITY } }, maxConfigs: 2 }), "search.space.a.high", "not a finite number"],
		["fractional int bound", v2({ space: { a: { type: "int", low: 1.5, high: 4 } }, maxConfigs: 2 }), "search.space.a.low", "not a finite integer"],
		["low not below high", v2({ space: { a: { type: "int", low: 5, high: 5 } }, maxConfigs: 2 }), "search.space.a.high", "must be greater than low"],
		["log with low <= 0", v2({ space: { a: { type: "float", low: 0, high: 1, log: true } }, maxConfigs: 2 }), "search.space.a.log", "log scale requires low > 0"],
		["step not dividing", v2({ space: { a: { type: "int", low: 100, high: 750, step: 100 } }, maxConfigs: 2 }), "search.space.a.step", "does not divide the range"],
		["non-positive step", v2({ space: { a: { type: "int", low: 1, high: 5, step: 0 } }, maxConfigs: 2 }), "search.space.a.step", "must be a positive integer"],
		["empty choices", v2({ space: { a: { type: "categorical", choices: [] } }, maxConfigs: 2 }), "search.space.a.choices", "must be a non-empty list"],
		["non-scalar choice", v2({ space: { a: { type: "categorical", choices: ["x", [1, 2]] } }, maxConfigs: 2 }), "search.space.a.choices[1]", "not a JSON scalar"],
		["duplicate choice", v2({ space: { a: { type: "categorical", choices: [1, true] } }, maxConfigs: 2 }), "search.space.a.choices[1]", "duplicate choice"],
		["too many parameters", v2({ space: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`p${i}`, { type: "int", low: 0, high: 1 }])), maxConfigs: 2 }), "search.space", "too many searched parameters"],
		["too many choices", v2({ space: { a: { type: "categorical", choices: Array.from({ length: 51 }, (_, i) => i) } }, maxConfigs: 2 }), "search.space.a.choices", "too many choices"],
		["maxConfigs above cap", v2({ space: { a: { type: "int", low: 0, high: 1 } }, maxConfigs: 501 }), "search.maxConfigs", "above the cap"],
		["maxConfigs missing for tpe", v2({ space: { a: { type: "int", low: 0, high: 1 } } }), "search.maxConfigs", "missing"],
		["grid too large", v2({ space: { a: { type: "int", low: 0, high: 99 }, b: { type: "int", low: 0, high: 99 } }, sampler: "grid" }), "search.space", "grid too large"],
		["float in grid", v2({ space: { a: { type: "float", low: 0, high: 1 } }, sampler: "grid" }), "search.space.a.type", "grid needs a finite space"],
		["unknown sampler", v2({ space: { a: { type: "int", low: 0, high: 1 } }, sampler: "tpee", maxConfigs: 2 }), "search.sampler", "unknown sampler"],
		["factory parameter fixed and searched", v2({ space: { "factory.features": { type: "categorical", choices: ["word", "char"] } }, maxConfigs: 2 }), "search.space.factory.features", "both fixed and searched"],
		["invalid plain name", v2({ space: { "model.max_depth": { type: "int", low: 1, high: 3 } }, maxConfigs: 2 }), "search.space.model.max_depth", "not a valid parameter name"],
		["deeply nested fixed parameters", v2(undefined, { pipeline: { module: "solutions/a.py", factory: "f", parameters: { a: { b: { c: { d: { e: { f: { g: { h: { i: 1 } } } } } } } } } } }), "pipeline.parameters.a.b.c.d.e.f.g.h", "nested too deeply"],
		["oversized fixed parameters", v2(undefined, { pipeline: { module: "solutions/a.py", factory: "f", parameters: { vocabulary: "x".repeat(70_000) } } }), "pipeline.parameters", "too large"],
		["search in schema version 1", { ...v2({ space: { a: { type: "int", low: 0, high: 1 } }, maxConfigs: 2 }), schemaVersion: 1, commit: undefined }, "search", "requires schemaVersion 2"],
		["commit option injection", v2(undefined, { commit: "--output=/tmp/x" }), "commit", "not a revision name"],
		["non-positive acceptEstimatedSeconds", v2({ space: { a: { type: "int", low: 0, high: 1 } }, maxConfigs: 2, acceptEstimatedSeconds: -5 }), "search.acceptEstimatedSeconds", "not a positive number of seconds"],
	])("%s produces the documented error shape with a hint", (_label, request, path, problem) => {
		const found = issues(JSON.parse(JSON.stringify(request, (_key, value) => value === Number.POSITIVE_INFINITY ? "__inf__" : value), (_key, value) => value === "__inf__" ? Number.POSITIVE_INFINITY : value));
		const issue = found.find((entry) => entry.path === path);
		expect(issue?.problem).toContain(problem);
		shape(issue!);
	});

	test("several errors are reported together, never only the first", () => {
		const found = issues(v2({
			space: {
				model__max_depth: { type: "int", low: 40, high: 4 },
				model__max_features: { type: "categorical", choices: [] },
				"factory.features": { type: "categorical", choices: ["word"] },
			},
			sampler: "grid",
			pruning: "yes",
		}, { seed: 7, scope: { kind: "pilot", maxRows: 1 } }));
		expect(found.map((issue) => issue.path).sort()).toEqual([
			"scope.maxRows",
			"search.pruning",
			"search.space.factory.features",
			"search.space.model__max_depth.high",
			"search.space.model__max_features.choices",
			"seed",
		]);
		for (const issue of found) shape(issue);
		expect(found.find((issue) => issue.path === "seed")?.hint).toContain("harness supplies every seed");
		expect(() => parseExperimentRequest(v2(undefined, { seed: 7 }))).toThrow(ExperimentRequestError);
	});

	test("unknown keys suggest the closest allowed name", () => {
		const issue = issues(v2({ space: { a: { type: "int", low: 0, high: 1 } }, maxConfig: 2 })).find((entry) => entry.path === "search.maxConfig");
		expect(issue?.hint).toStartWith("Did you mean maxConfigs?");
	});

	test("fixed estimator parameters are validated and conflict with searched names", () => {
		const found = issues(v2({ space: { model__C: { type: "float", low: 0.01, high: 10, log: true } }, maxConfigs: 5 }, {
			pipeline: { module: "solutions/a.py", factory: "f", estimatorParams: { model__C: 1, "bad name": 2, model__x: Number.NaN } },
		}));
		expect(found.map((issue) => issue.path).sort()).toEqual([
			"pipeline.estimatorParams.bad name", "pipeline.estimatorParams.model__x", "search.space.model__C",
		]);
	});
});
