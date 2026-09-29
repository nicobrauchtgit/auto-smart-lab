import { describe, expect, test } from "bun:test";

import { parseExperimentRequest } from "./contract.js";

const validRequest = () => ({
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
		const request = {
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
		expect(() => parseExperimentRequest(request)).toThrow(/unknown experiment/);
	});

	test.each([
		["root", (request: any) => { request.seed = 13; }],
		["pipeline", (request: any) => { request.pipeline.seed = 13; }],
		["CV", (request: any) => { request.cv.seed = 13; }],
		["scope", (request: any) => { request.scope.seed = 13; }],
	])("rejects agent-owned seeds in %s", (_label, mutate) => {
		const request = validRequest();
		mutate(request);
		expect(() => parseExperimentRequest(request)).toThrow(/unknown experiment/);
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
		expect(() => parseExperimentRequest(request)).toThrow(/experiment\.cv\.module/);
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
