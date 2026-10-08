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
	scheme: "stratified_kfold" | "kfold" | "group_kfold";
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

/** Controller metadata, never an agent request or a model-design constraint. */
export type MeasurementConfig = {
	kind: "clustering";
	sampleManifestPath: string;
	execution: "inductive" | "batch";
} | {
	kind: "anomaly_detection";
	sampleManifestPath: string;
	execution: "inductive" | "batch";
	scoreMethod: "score_samples" | "decision_function" | "negative_outlier_factor_";
	scoreDirection: "higher_is_anomalous" | "lower_is_anomalous";
	anomalyLabel: number;
	evidence?: { path: string; source: "trusted" | "agent_provided" };
};

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

export interface DiagnosticRequest {
	representation?: { source: "pipeline_features" | "method"; method?: string;
		metric?: "euclidean" | "cosine"; maxRows?: number; dbcv?: boolean };
	predictionStrength?: boolean;
	modelSignals?: { method: string; maxRows?: number; compareTrain?: boolean; units?: string };
	challenge?: { method: string; maxRows?: number };
	volume?: { bounds: [number, number][]; scoreSource: "pipeline_model" | "method"; scoreMethod: string; uniformSamples?: number };
	contamination?: { parameter: string; values: number[] };
	slices?: { method: string; maxGroups?: number };
	robustness?: { method: string; maxRows?: number; maxVariants?: number };
	learningCurve?: { fractions: number[] };
}

export interface ProxyObjective {
	kind: "proxy";
	metric: "silhouette" | "calinskiHarabasz" | "daviesBouldin" | "dbcv" | "estimator_score"
		| "evidence_roc_auc" | "evidence_average_precision";
	direction: "maximize" | "minimize";
}

/**
 * A harness-run hyperparameter search. Plain names target `set_params`;
 * `factory.<name>` entries are merged into the factory's parameters.
 */
export interface SearchRequest {
	/** Explicit advisory objective; never changes the controller's promotion metric. */
	objective?: ProxyObjective;
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
	diagnostics?: DiagnosticRequest;
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
