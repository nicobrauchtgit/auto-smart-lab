/** Values that can be persisted in an experiment request without coercion. */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface PipelineRequest {
	/** Project-relative Python source file containing the pipeline factory. */
	module: string;
	factory: string;
	parameters?: JsonValue;
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

/**
 * The agent describes an experiment; harness-owned context supplies all seeds
 * when the request is executed.
 */
export interface ExperimentRequest {
	schemaVersion: 1;
	hypothesis: string;
	pipeline: PipelineRequest;
	cv: CvRequest;
	scope: ExperimentScope;
}
