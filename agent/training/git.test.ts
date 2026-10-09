import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	addWorktree, ensureSolutionsRepository, git, isRepositoryRoot, removeWorktree, resolveCommit, tagCommit,
	tagMessage, uncommittedFiles,
} from "./git.js";
import { TrainingService } from "./service.js";
import { commitAll, temporaryProject } from "./testing.js";
import type { ExperimentSpec, ExperimentView } from "../experiments/types.js";

function fakeSupervisor() {
	const started: ExperimentSpec[] = [];
	return {
		started,
		start(spec: ExperimentSpec, _tool?: string, id?: string): ExperimentView {
			started.push(spec);
			return { id: id!, status: "running", scope: spec.scope, hypothesis: spec.hypothesis,
				elapsedSeconds: 0, linesEmitted: 0, cursor: 0, logPath: "log" };
		},
	};
}

function service(project: ReturnType<typeof temporaryProject>, supervisor = fakeSupervisor()) {
	return new TrainingService({
		supervisor, pythonExecutable: "python", projectRoot: project.root,
		trainingRoot: join(project.root, "runs", "training"), taskId: "fixture",
		datasetSha256: project.datasetSha256, measurement: project.measurement, rootSeed: 13, zipPath: project.zipPath, labelsPath: project.labelsPath,
		solutionsRoot: project.solutionsRoot, validatePipeline: async () => [],
	});
}

const request = (extra: Record<string, unknown> = {}) => ({
	schemaVersion: 2, hypothesis: "tf-idf separates the fixture classes",
	pipeline: { module: "solutions/tasks/fixture.py", factory: "build_pipeline" },
	cv: { kind: "builtin", scheme: "stratified_kfold", folds: 2, repeats: 1 },
	scope: { kind: "pilot" },
	...extra,
});

describe("solutions repository", () => {
	test("setup initializes a nested repository once, commits existing files, and ignores caches", () => {
		const root = mkdtempSync(join(tmpdir(), "solutions-repo-"));
		const solutions = join(root, "solutions");
		mkdirSync(join(solutions, "tasks"), { recursive: true });
		writeFileSync(join(solutions, "tasks", "a.py"), "A = 1\n");
		const first = ensureSolutionsRepository(solutions);
		expect(first.initialized).toBe(true);
		expect(isRepositoryRoot(solutions)).toBe(true);
		expect(git(solutions, ["ls-files"]).stdout).toContain("tasks/a.py");
		mkdirSync(join(solutions, "__pycache__"));
		writeFileSync(join(solutions, "__pycache__", "a.pyc"), "");
		expect(uncommittedFiles(solutions)).toEqual([]);
		writeFileSync(join(solutions, "tasks", "a.py"), "A = 2\n");
		const second = ensureSolutionsRepository(solutions);
		expect(second).toEqual({ initialized: false, head: first.head, branch: "main" });
		// Existing uncommitted work is never touched by setup.
		expect(readFileSync(join(solutions, "tasks", "a.py"), "utf8")).toBe("A = 2\n");
		expect(uncommittedFiles(solutions)).toEqual(["tasks/a.py (modified)"]);
	});

	test("a subdirectory of another repository is not mistaken for the solutions repository", () => {
		const root = mkdtempSync(join(tmpdir(), "solutions-parent-"));
		ensureSolutionsRepository(root);
		const nested = join(root, "solutions");
		mkdirSync(nested);
		expect(isRepositoryRoot(nested)).toBe(false);
		expect(ensureSolutionsRepository(nested).initialized).toBe(true);
	});

	test("resolves commit identity and keeps worktrees and tags independent of the live tree", () => {
		const project = temporaryProject();
		const source = resolveCommit(project.solutionsRoot, "HEAD")!;
		expect(source.commit).toBe(project.head);
		expect(source.tree).toMatch(/^[0-9a-f]{40}$/);
		expect(source.branch).toBe("main");
		expect(source.subject).toBe("Starting point recorded by solve setup");
		expect(resolveCommit(project.solutionsRoot, "--output=/tmp/x")).toBeUndefined();
		expect(resolveCommit(project.solutionsRoot, "no-such-branch")).toBeUndefined();

		const worktree = join(project.root, "trial", "source", "solutions");
		addWorktree(project.solutionsRoot, worktree, source.commit);
		writeFileSync(join(project.solutionsRoot, "features.py"), "BROKEN = True\n");
		commitAll(project.solutionsRoot, "Break features");
		expect(readFileSync(join(worktree, "features.py"), "utf8")).toContain("class TextColumn");
		removeWorktree(project.solutionsRoot, worktree);
		expect(existsSync(worktree)).toBe(false);
		expect(git(project.solutionsRoot, ["worktree", "list"]).stdout.trim().split("\n")).toHaveLength(1);

		tagCommit(project.solutionsRoot, "champion", source.commit, JSON.stringify({ experimentId: "a" }));
		tagCommit(project.solutionsRoot, "champion", source.commit, JSON.stringify({ experimentId: "b" }), true);
		expect(tagMessage(project.solutionsRoot, "champion")).toEqual({ commit: source.commit, message: "{\"experimentId\":\"b\"}" });
	});
});

describe("experiment start against the solutions repository", () => {
	test("an uncommitted file is rejected, named, and consumes no budget", async () => {
		const project = temporaryProject();
		const supervisor = fakeSupervisor();
		const training = service(project, supervisor);
		writeFileSync(join(project.solutionsRoot, "tasks", "draft.py"), "X = 1\n");
		writeFileSync(join(project.solutionsRoot, "features.py"), "# edited\n");
		let caught: any;
		await training.start(request()).catch((error) => { caught = error; });
		expect(caught?.name).toBe("ExperimentRequestError");
		const issue = caught.issues.find((entry: any) => entry.path === "commit");
		expect(issue.problem).toContain("uncommitted changes");
		expect(issue.received).toEqual(["features.py (modified)", "tasks/draft.py (untracked)"]);
		expect(issue.hint).toContain("Commit them first");
		expect(supervisor.started).toHaveLength(0);
		expect(readdirSync(join(project.root, "runs", "training"))).toEqual([".service.lock"]);

		commitAll(project.solutionsRoot, "Draft helper");
		const started = await training.start(request());
		expect(supervisor.started).toHaveLength(1);
		expect(started.source?.subject).toBe("Draft helper");
	});

	test("records commit, tree, branch, and subject and runs from a worktree of that commit", async () => {
		const project = temporaryProject();
		const training = service(project);
		const started = await training.start(request({ commit: "main" }));
		const invocation = JSON.parse(readFileSync(join(started.directory, "invocation.json"), "utf8"));
		expect(invocation.schemaVersion).toBe(2);
		expect(invocation.source).toMatchObject({ commit: project.head, branch: "main", subject: "Starting point recorded by solve setup" });
		expect(invocation.source.tree).toMatch(/^[0-9a-f]{40}$/);
		expect(invocation.inputs.sourceRoot).toBe(join(started.directory, "source"));
		expect(existsSync(join(started.directory, "source", "solutions", "tasks", "fixture.py"))).toBe(true);
		await training.finalize(started.id);
		expect(existsSync(join(started.directory, "source", "solutions"))).toBe(false);
	});

	test("an unknown commit and a module missing from the commit are reported together with fixes", async () => {
		const project = temporaryProject();
		const training = service(project);
		let caught: any;
		await training.start(request({ commit: "nope" })).catch((error) => { caught = error; });
		expect(caught.issues.map((issue: any) => issue.problem)).toEqual(["no such commit"]);
		writeFileSync(join(project.solutionsRoot, "tasks", "later.py"), "def build_pipeline(): pass\n");
		await training.start(request({ commit: "HEAD", pipeline: { module: "solutions/tasks/later.py", factory: "build_pipeline" } }))
			.catch((error) => { caught = error; });
		expect(caught.issues.map((issue: any) => issue.path)).toEqual(["commit", "pipeline.module"]);
		commitAll(project.solutionsRoot, "Later pipeline");
		await training.start(request({ commit: project.head, pipeline: { module: "solutions/tasks/later.py", factory: "build_pipeline" } }))
			.catch((error) => { caught = error; });
		expect(caught.issues[0]).toMatchObject({ path: "pipeline.module", problem: `does not exist in commit ${project.head.slice(0, 12)}` });
	});

	test("version 1 requests keep working and default to HEAD", async () => {
		const project = temporaryProject();
		const started = await service(project).start({ ...request(), schemaVersion: 1 });
		expect(started.source?.commit).toBe(project.head);
		const invocation = JSON.parse(readFileSync(join(started.directory, "invocation.json"), "utf8"));
		expect(invocation.request.schemaVersion).toBe(1);
	});
});
