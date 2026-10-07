/** Values that can be persisted in an experiment request without coercion. */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export type JsonScalar = null | boolean | number | string;

export interface PipelineRequest {
	/** Project-relative Python source file containing the pipeline factory. */
	module: string;
	factory: string;
	/** Fixed values passed to the factory as `context["parameters"]`. */
	parameters?: JsonValue;
	/**
	 * Fixed values applied to the constructed pipeline through `set_params`,
	 * such as `model__max_depth`. Schema version 2 only; this is how a
	 * confirmation trial fixes the winning searched values.
	 */
	estimatorParams?: Record<string, JsonValue>;
}

export interface BuiltinCvRequest {
	kind: "builtin";
	scheme: "stratified_kfold";
	folds: number;
	repeats: number;
}

export interface FactoryCvRequest {
	kind: "factory";
	/** Project-relative Python source file containing the CV factory. */
	module: string;
	factory: string;
	repeats: number;
	options?: JsonValue;
}

export type CvRequest = BuiltinCvRequest | FactoryCvRequest;

export interface PilotScope {
	kind: "pilot";
	maxRows?: number;
	maxFolds?: number;
}

export interface PromotionScope {
	kind: "promotion";
}

export type ExperimentScope = PilotScope | PromotionScope;

export interface IntDistribution {
	type: "int";
	low: number;
	high: number;
	step?: number;
	log?: boolean;
}

export interface FloatDistribution {
	type: "float";
	low: number;
	high: number;
	log?: boolean;
}

export interface CategoricalDistribution {
	type: "categorical";
	choices: JsonScalar[];
}

export type SearchDistribution = IntDistribution | FloatDistribution | CategoricalDistribution;

export type SearchSampler = "tpe" | "random" | "grid";

/**
 * A harness-run hyperparameter search. Plain names target `set_params`;
 * `factory.<name>` entries are merged into the factory's parameters.
 */
export interface SearchRequest {
	space: Record<string, SearchDistribution>;
	sampler?: SearchSampler;
	/** Required for `tpe` and `random`; a smaller grid ignores it. */
	maxConfigs?: number;
	pruning?: boolean;
	/** Acknowledges a projected runtime up to this many seconds. */
	acceptEstimatedSeconds?: number;
}

/**
 * The agent describes an experiment; harness-owned context supplies all seeds
 * when the request is executed.
 */
export interface ExperimentRequest {
	schemaVersion: 1 | 2;
	hypothesis: string;
	/** Revision in the solutions repository; defaults to `HEAD`. Schema version 2 only. */
	commit?: string;
	pipeline: PipelineRequest;
	search?: SearchRequest;
	cv: CvRequest;
	scope: ExperimentScope;
}

/** One rejected field, in the documented shape. All problems are reported together. */
export interface ValidationIssue {
	path: string;
	problem: string;
	received: JsonValue;
	expected: string;
	hint: string;
	/** A library's own message, verbatim, when one explains the rejection. */
	message?: string;
}
