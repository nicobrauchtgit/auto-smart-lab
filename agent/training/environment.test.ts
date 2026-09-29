import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SupervisorOptions } from "../experiments/supervisor.js";
import type { PromptSnapshot } from "../prompts/loader.js";
import { sanitizeTrainingEnvironment } from "./environment.js";
import { createHarnessTraining } from "./index.js";

const roots: string[] = [];
const prompts = {
	fingerprint: "test-prompts",
	render: (id: string) => ({
		text: id,
		reference: { id, template_sha256: "template", rendered_sha256: "rendered" },
	}),
} as PromptSnapshot;

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const runtimeEnvironment = {
	PATH: "/venv/bin:/usr/bin",
	VENV_DIR: "/venv",
	VIRTUAL_ENV: "/venv",
	UV_PROJECT_ENVIRONMENT: "/venv",
	UV_PYTHON: "/venv/bin/python",
	UV_PYTHON_DOWNLOADS: "never",
	PYTHONNOUSERSITE: "1",
	LANG: "en_US.UTF-8",
	LANGUAGE: "en_US:en",
	LC_ALL: "C.UTF-8",
	LC_CTYPE: "C.UTF-8",
	LC_COLLATE: "C",
	LC_MESSAGES: "C",
	LC_MONETARY: "C",
	LC_NUMERIC: "C",
	LC_TIME: "C",
	TMPDIR: "/runtime/tmpdir",
	TMP: "/runtime/tmp",
	TEMP: "/runtime/temp",
	LD_LIBRARY_PATH: "/runtime/lib",
} as const;

const hostileEnvironment = {
	...runtimeEnvironment,
	SAIA_API_KEY: "saia-secret",
	LAB_USER: "lab-user",
	LAB_PASS: "lab-secret",
	TAVILY_API_KEY: "tavily-secret",
	ARBITRARY_CALLER_VALUE: "must-not-cross-boundary",
	PYTHONPATH: "/untrusted/imports",
	PYTHONUNBUFFERED: "caller-owned-value",
	PIPELINE_RUN_ID: "spoofed-run",
	PIPELINE_STAGE_INVOCATION_ID: "spoofed-stage",
};

describe("training worker environment", () => {
	test("keeps only required runtime keys and authoritative pipeline identity", () => {
		expect(sanitizeTrainingEnvironment(hostileEnvironment, {
			pipelineRunId: "run-123",
			stageInvocationId: "stage-456",
		})).toEqual({
			...runtimeEnvironment,
			PIPELINE_RUN_ID: "run-123",
			PIPELINE_STAGE_INVOCATION_ID: "stage-456",
		});
	});

	test("createHarnessTraining gives the supervisor the sanitized environment", async () => {
		const root = mkdtempSync(join(tmpdir(), "training-environment-"));
		roots.push(root);
		const training = createHarnessTraining({
			root: join(root, "experiments"),
			env: hostileEnvironment,
			prompts,
			pythonExecutable: runtimeEnvironment.UV_PYTHON,
			projectRoot: root,
			taskId: "task",
			datasetSha256: "a".repeat(64),
			rootSeed: 17,
			zipPath: join(root, "train.zip"),
			labelsPath: join(root, "train.labels"),
			pipelineRunId: "run-123",
			stageInvocationId: "stage-456",
		});
		try {
			// Constructor parameter properties are ordinary runtime fields. Reading
			// this one verifies the createHarnessTraining boundary without spawning.
			const options = (training.supervisor as unknown as { options: SupervisorOptions }).options;
			expect(options.env).toEqual({
				...runtimeEnvironment,
				PIPELINE_RUN_ID: "run-123",
				PIPELINE_STAGE_INVOCATION_ID: "stage-456",
			});
			expect(options.env.SAIA_API_KEY).toBeUndefined();
			expect(options.env.LAB_USER).toBeUndefined();
			expect(options.env.LAB_PASS).toBeUndefined();
			expect(options.env.TAVILY_API_KEY).toBeUndefined();
			expect(options.env.ARBITRARY_CALLER_VALUE).toBeUndefined();
			expect(options.env.PYTHONUNBUFFERED).toBeUndefined();
		} finally {
			await training.close();
		}
	});
});
