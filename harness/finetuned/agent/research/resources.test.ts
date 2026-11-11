import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCourseResources, reportCourseResources, stageCourseResources } from "./resources.js";
import { resolveSource, type Source } from "./validate.js";
import type { ResearchContext } from "./context.js";
import { courseResourcesSetupCheck, SetupSession, type SetupCheck } from "../pipeline/setup.js";
import { invokeStage } from "../pipeline/executor.js";
import { createPipelineTrace } from "../pipeline/trace.js";
import { resolvePipelineSettings } from "../pipeline/config.js";
import { STAGE_REGISTRY } from "../pipeline/registry.js";
import { testTelemetry } from "../telemetry/testing.js";
import { spamConfiguration } from "../pipeline/task_configuration.testing.js";

const base = mkdtempSync(join(tmpdir(), "course-resources-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
function fixture() {
	const root = mkdtempSync(join(base, "case-"));
	const directory = join(root, "01-spam");
	mkdirSync(directory);
	const text = "--- Page 1 ---\nCourse evaluation definitions.\n";
	writeFileSync(join(directory, "slides.txt"), text);
	const entry = { file: "slides.txt", title: "Course slides", media_type: "text/plain", pages: 1,
		sha256: createHash("sha256").update(text).digest("hex") };
	const save = (files: unknown[] = [entry]) => writeFileSync(join(directory, "manifest.json"), JSON.stringify({ version: 1, files }));
	save();
	return { root, directory, entry, save };
}

test("course resources are optional per unit and snapshots retain their content identity", () => {
	const f = fixture();
	expect(readCourseResources("02-other", f.root)).toEqual([]);
	const inputs = readCourseResources("01-spam", f.root);
	const workspace = join(f.root, "research");
	stageCourseResources(workspace, inputs);
	expect(readFileSync(join(workspace, "resources/slides.txt"), "utf8")).toContain("Page 1");
	expect(inputs[0]!.resource.sha256).toBe(f.entry.sha256);
	const supplied: unknown[] = [];
	reportCourseResources({ input: value => supplied.push(value) }, workspace, inputs.map(input => input.resource));
	expect(supplied).toMatchObject([{ kind: "course_resource", delivery: "workspace_file", content_sha256: f.entry.sha256,
		artifact: join(workspace, "resources/slides.txt"), pages: 1, media_type: "text/plain" }]);
	stageCourseResources(workspace, []);
	expect(existsSync(join(workspace, "resources"))).toBe(false);
});

test("declared missing, changed and linked resources are rejected", () => {
	const f = fixture();
	const file = join(f.directory, "slides.txt");
	writeFileSync(file, "changed");
	expect(() => readCourseResources("01-spam", f.root)).toThrow("checksum mismatch");
	rmSync(file);
	expect(() => readCourseResources("01-spam", f.root)).toThrow();
	symlinkSync(join(f.directory, "manifest.json"), file);
	expect(() => readCourseResources("01-spam", f.root)).toThrow("Invalid course resource");
});

test("manifest paths cannot expose unrelated files or escape the selected unit", () => {
	const f = fixture();
	f.save([{ ...f.entry, file: "../slides.txt" }]);
	expect(() => readCourseResources("01-spam", f.root)).toThrow("Invalid course resource entry");
	f.save([f.entry, f.entry]);
	expect(() => readCourseResources("01-spam", f.root)).toThrow("Invalid course resource entry");
	expect(() => readCourseResources("../01-spam", f.root)).toThrow("Invalid course resource unit");
	rmSync(join(f.directory, "manifest.json"));
	expect(() => readCourseResources("01-spam", f.root)).toThrow();
});

test("course citations require declared unchanged text and supply no dataset measurements", () => {
	const f = fixture();
	const inputs = readCourseResources("01-spam", f.root);
	const workspace = join(f.root, "research");
	stageCourseResources(workspace, inputs);
	const context = { resources: inputs.map(input => input.resource), limits: { max_analysis_artifact_bytes: 65536 } } as ResearchContext;
	const source: Source = { kind: "artifact", text: "resources/slides.txt", path: "resources/slides.txt" };
	expect(resolveSource(source, workspace, context)).toEqual({ source, values: [] });
	expect(resolveSource(source, workspace, { ...context, resources: [] }).error).toContain("declared in context.json");
	writeFileSync(join(workspace, "resources/slides.txt"), "tampered");
	expect(resolveSource(source, workspace, context).error).toContain("unchanged text resource");
});

test("missing or invalid declared course material blocks the research stage before it starts", async () => {
	const f = fixture();
	const check = courseResourcesSetupCheck(() => "01-spam", f.root);
	class ResourceSetup extends SetupSession {
		async check(checks: SetupCheck[], signal: AbortSignal, record: (type: string, payload: Record<string, unknown>) => void) {
			expect(checks.some(item => item.id === check.id)).toBe(true);
			return super.check([check], signal, record);
		}
	}
	const original = STAGE_REGISTRY.research!;
	let ran = false;
	try {
		STAGE_REGISTRY.research = { ...original, checkInput() {}, async run() { ran = true; return { artifacts: [] }; } };
		const config = resolvePipelineSettings({ pipeline: { entryStage: "research", stages: { research: { enabled: true } } },
			agent: { cwd: ".", agentDir: ".", initialPrompt: "" }, providers: {}, defaultModel: "fixture/model" } as any);
		for (const fault of ["changed", "missing"]) {
			if (fault === "changed") writeFileSync(join(f.directory, "slides.txt"), "changed");
			else rmSync(join(f.directory, "slides.txt"));
			const trace = await createPipelineTrace({ telemetry: testTelemetry(), taskId: "fixture", pipelineRunId: crypto.randomUUID(), runsDir: f.root });
			try {
				const result = await invokeStage({ stage: "research", input: { taskId: "fixture", taskConfiguration: spamConfiguration(), upstream: [] }, config, trace, setupSession: new ResourceSetup() });
				expect(result.outcome).toBe("failure");
				expect(result.error).toContain("course-resources");
				expect(ran).toBe(false);
			} finally { await trace.close(); }
		}
	} finally { STAGE_REGISTRY.research = original; }
});
