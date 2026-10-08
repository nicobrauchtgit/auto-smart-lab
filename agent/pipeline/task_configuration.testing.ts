/** Test fixtures for task configurations; production reads them from pipeline.config.json. */
import type { TaskConfiguration } from "./task_configuration.js";

/** The binary text configuration of the spam tasks, as configured in pipeline.config.json. */
export function spamConfiguration(taskId = "spam1"): TaskConfiguration {
	const stem = taskId === "spam3" ? "webspam" : taskId;
	return {
		schemaVersion: 1,
		kind: "binary_classification",
		samples: { source: "zip_members", train: `${stem}-train.zip`, test: `${stem}-test.zip` },
		targets: { kind: "binary", file: `${stem}-train.labels` },
		execution: "inductive",
		holdout: "stratified",
		metric: "balanced_accuracy",
		refit: "fit_training_predict_test",
		submission: { format: "id_semicolon_prediction", predictions: "binary" },
	};
}
