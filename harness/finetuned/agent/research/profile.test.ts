import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectPython } from "../pipeline/task_configuration.js";
import { spamConfiguration } from "../pipeline/task_configuration.testing.js";
import { setupChecks } from "../pipeline/setup.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { buildDataProfile, DATA_PROFILE_PATH } from "./profile.js";

function fixtureTask(): { root: string; taskDir: string; workspace: string } {
	const root = mkdtempSync(join(tmpdir(), "profile-"));
	const taskDir = join(root, "task");
	const data = join(taskDir, "data");
	mkdirSync(data, { recursive: true });
	const script = `
import sys, zipfile
data = sys.argv[1]
train = {f"data/train/m{i}.{i % 2}": (b"<html><a href='http://a'>x</a></html>" if i % 2 else b"From: a\\n\\nhi") + bytes([65 + i]) for i in range(8)}
with zipfile.ZipFile(f"{data}/spam1-train.zip", "w") as z:
    for k, v in train.items(): z.writestr(k, v)
with zipfile.ZipFile(f"{data}/spam1-test.zip", "w") as z:
    for i in range(4): z.writestr(f"data/test/t{i}.x", b"plain text " + bytes([65 + i]))
open(f"{data}/spam1-train.labels", "w").write("".join(f"{k};{k[-1]}\\n" for k in train))
`;
	const done = spawnSync(projectPython(), ["-c", script, data], { encoding: "utf8" });
	if (done.status !== 0) throw new Error(done.stderr);
	return { root, taskDir, workspace: join(root, "workspace") };
}

test("the harness profile is written to the workspace with the dataset snapshot", () => {
	const { root, taskDir, workspace } = fixtureTask();
	try {
		const status = buildDataProfile({ taskId: "spam1", configuration: spamConfiguration(), workspace, taskDir, datasetSnapshotSha256: "snap" });
		expect(status.status).toBe("available");
		expect(status.path).toBe(DATA_PROFILE_PATH);
		expect(status.layers).toEqual(["generic", "text"]);
		const profile = JSON.parse(readFileSync(join(workspace, DATA_PROFILE_PATH), "utf8"));
		expect(profile.dataset_snapshot_sha256).toBe("snap");
		expect(profile.evidence["training.name_leakage"]).toBeUndefined();
		expect(profile.evidence["training.targets"].values.counts).toEqual({ "0": 4, "1": 4 });
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed profile is reported as unavailable and leaves no stale profile behind", () => {
	const { root, taskDir, workspace } = fixtureTask();
	try {
		expect(buildDataProfile({ taskId: "spam1", configuration: spamConfiguration(), workspace, taskDir, datasetSnapshotSha256: "old" }).status).toBe("available");
		rmSync(join(taskDir, "data", "spam1-test.zip"));
		const status = buildDataProfile({ taskId: "spam1", configuration: spamConfiguration(), workspace, taskDir, datasetSnapshotSha256: "new" });
		expect(status.status).toBe("unavailable");
		expect(status.reason).toContain("Data profile failed");
		expect(existsSync(join(workspace, DATA_PROFILE_PATH))).toBe(false);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("without a task configuration the profile is unavailable, not an error", () => {
	const root = mkdtempSync(join(tmpdir(), "profile-"));
	try {
		writeFileSync(join(root, "x"), "");
		const status = buildDataProfile({ taskId: "spam1", workspace: root, datasetSnapshotSha256: "snap" });
		expect(status).toMatchObject({ status: "unavailable", reason: expect.stringContaining("No task configuration") });
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("the data-profile preflight checks the profiler scripts", () => {
	const check = setupChecks(["data-profile"], { taskId: "spam1", prompts: loadPromptSnapshot() }).find(c => c.id === "data-profile");
	expect(check).toBeDefined();
	expect(check!.phase).toBe("local");
});
