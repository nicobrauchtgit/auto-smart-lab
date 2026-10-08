import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareSolveWorkspace } from "./workspace.js";
import { parseTaskConfiguration, type TaskConfiguration } from "../pipeline/task_configuration.js";
import { SetupSession, setupChecks } from "../pipeline/setup.js";
import { loadPromptSnapshot } from "../prompts/loader.js";

const configuration: TaskConfiguration = {
 schemaVersion: 1, kind: "anomaly_detection", samples: { source: "pcap_tcp_connections", train: "train.pcap.gz", test: "test.pcap.gz" },
 targets: { kind: "none" }, execution: "inductive", holdout: "none", metric: "none",
 anomaly: { scoreMethod: "score_samples", scoreDirection: "lower_is_anomalous", anomalyLabel: -1 },
 refit: "fit_training_predict_test", submission: { format: "id_semicolon_prediction", predictions: "binary" },
};
const python = join(resolve(process.env.VENV_DIR ?? ".venv"), "bin", "python");

test("pcap solve preparation produces opaque descriptors over an identical development capture", () => {
 const root = mkdtempSync(join(tmpdir(), "pcap-workspace-"));
 try {
  const taskDir = join(root, "task"); mkdirSync(join(taskDir, "data"), { recursive: true });
  writeFileSync(join(taskDir, "prompt.md"), "Inert network fixture.\n");
  execFileSync(python, ["-c", `import sys
sys.path.insert(0, 'agent/training/python')
from test_pcap_samples import capture, packet
from pathlib import Path
root = Path(sys.argv[1])
capture(root / 'train.pcap.gz', [packet(), packet(sport=1235)])
capture(root / 'test.pcap.gz', [packet(src='198.51.100.1'), packet(src='198.51.100.2')])`, join(taskDir, "data")]);
  expect(parseTaskConfiguration(configuration).samples.source).toBe("pcap_tcp_connections");
  const workspace = prepareSolveWorkspace("pcap-fixture", { configuration, projectRoot: root, taskDir, pythonExecutable: python });
  expect(workspace.rowCount).toBe(2); expect(workspace.split.sealedIds).toEqual([]);
  expect(readFileSync(workspace.devZip).equals(readFileSync(workspace.trainZip))).toBe(true);
  const document = JSON.parse(readFileSync(workspace.sampleManifestPath, "utf8"));
  expect(document.samples[0]).toEqual({ id: "192.0.2.1:1234->192.0.2.2:80", input: {
   pcap: workspace.devZip, packetIndices: [0], source: { ip: "192.0.2.1", port: 1234 }, destination: { ip: "192.0.2.2", port: 80 },
  } });
  expect(document.samples.every((sample: any) => !("target" in sample))).toBe(true);
 } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pcap prerequisite is scoped to selected source and missing parser prevents execution", async () => {
 const options = { taskId: "pcap-fixture", taskConfiguration: configuration, prompts: loadPromptSnapshot(), executables: { python: "/nonexistent-pcap-python" } };
 const checks = setupChecks(["task", "training"], options);
 expect(checks.some(check => check.id === "training-zip-command")).toBe(false);
 const parser = checks.find(check => check.id === "pcap-sample-runtime")!;
 expect(parser).toBeDefined();
 let executionStarted = false;
 await expect((async () => {
  await new SetupSession().check([parser], new AbortController().signal, () => {});
  executionStarted = true;
 })()).rejects.toThrow("dpkt");
 expect(executionStarted).toBe(false);
 const zip = { ...configuration, samples: { source: "zip_members" as const, train: "train.zip", test: "test.zip" } };
 expect(setupChecks(["task"], { ...options, taskConfiguration: zip }).some(check => check.id === "pcap-sample-runtime")).toBe(false);
});
