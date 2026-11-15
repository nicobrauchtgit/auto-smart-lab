/** Task declarations for scout probes; code2 has a probe-only declaration from its supplied task text. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ARM_ROOT } from "../paths.js";
import type { TaskConfiguration } from "../pipeline/task_configuration.js";

const CODE2 = {
 schemaVersion: 1, kind: "clustering", samples: {source: "zip_members", train: "php-train.zip", test: "php-test.zip"},
 targets: {kind: "families", file: "php-train.labels"}, execution: "batch", holdout: "group", metric: "adjusted_rand_index",
 refit: "fit_predict_test_batch", submission: {format: "id_semicolon_prediction", predictions: "cluster_id"},
};
/** pipeline.config.json's declaration, or code2's probe-only one; pipeline.config.json is never changed. */
export function probeConfiguration(taskId: string): TaskConfiguration {
 const config = JSON.parse(readFileSync(resolve(ARM_ROOT, "pipeline.config.json"), "utf8"));
 const configuration = config.pipeline.tasks[taskId] ?? (taskId === "code2" ? CODE2 : undefined);
 if (!configuration) throw new Error("Probe requires declared task configuration");
 return configuration as TaskConfiguration;
}
