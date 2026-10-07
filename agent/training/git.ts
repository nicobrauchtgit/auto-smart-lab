/**
 * The solutions repository: agent-owned history, harness-owned checks.
 *
 * `solutions/` is its own git repository so the code behind every measured
 * trial survives later edits. The agent commits and branches; the harness only
 * reads history, materializes detached worktrees for trials, and maintains the
 * `trial/<experimentId>` and `champion` tags.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Committer identity for harness-created commits and annotated tags only. */
const HARNESS_IDENTITY = ["-c", "user.name=SmartLab harness", "-c", "user.email=harness@smartlab.invalid"] as const;

/** Never let a parent repository, hook, or pager leak into harness git calls. */
function gitEnvironment(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
	}
	return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0" };
}

export interface GitResult {
	status: number;
	stdout: string;
	stderr: string;
}

export function git(repository: string, args: readonly string[], options: { timeoutMs?: number } = {}): GitResult {
	const result = spawnSync("git", ["-C", repository, ...args], {
		encoding: "utf8",
		env: gitEnvironment(),
		timeout: options.timeoutMs ?? 30_000,
		maxBuffer: 16 * 1024 * 1024,
	});
	if (result.error) throw new Error(`git ${args[0]} could not run: ${result.error.message}`);
	return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function gitOrThrow(repository: string, args: readonly string[]): string {
	const result = git(repository, args);
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim().split("\n").slice(-3).join(" ")}`);
	}
	return result.stdout;
}

/** True only when `path` is itself a repository root, never a subdirectory of the project repository. */
export function isRepositoryRoot(path: string): boolean {
	if (!existsSync(path)) return false;
	const result = git(path, ["rev-parse", "--show-toplevel"]);
	if (result.status !== 0) return false;
	try {
		return realpathSync(result.stdout.trim()) === realpathSync(path);
	} catch {
		return false;
	}
}

export interface RepositoryPreparation {
	initialized: boolean;
	head?: string;
	branch?: string;
}

/** Files git would otherwise report as untracked after ordinary local runs. */
const DEFAULT_IGNORES = ["__pycache__/", "*.py[cod]", ".ipynb_checkpoints/", ".pytest_cache/", ""].join("\n");

/**
 * Initialize `solutions/` as an independent repository if needed and commit
 * whatever already exists as the starting point. An existing repository is left
 * exactly as it is, including uncommitted work.
 */
export function ensureSolutionsRepository(root: string): RepositoryPreparation {
	mkdirSync(root, { recursive: true });
	if (isRepositoryRoot(root)) {
		const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
		const branch = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
		return {
			initialized: false,
			...(head.status === 0 ? { head: head.stdout.trim() } : {}),
			...(branch.status === 0 ? { branch: branch.stdout.trim() } : {}),
		};
	}
	gitOrThrow(root, ["init", "--quiet", "--initial-branch=main"]);
	// The agent commits under its own identity. Give the repository a local one
	// only when none resolves, so `git commit` never fails on configuration.
	if (git(root, ["config", "user.email"]).status !== 0) {
		gitOrThrow(root, ["config", "user.name", "SmartLab solve agent"]);
		gitOrThrow(root, ["config", "user.email", "solve-agent@smartlab.invalid"]);
	}
	if (!existsSync(join(root, ".gitignore"))) writeFileSync(join(root, ".gitignore"), DEFAULT_IGNORES);
	gitOrThrow(root, ["add", "-A"]);
	gitOrThrow(root, [...HARNESS_IDENTITY, "commit", "--quiet", "--allow-empty", "-m", "Starting point recorded by solve setup"]);
	return {
		initialized: true,
		head: gitOrThrow(root, ["rev-parse", "HEAD"]).trim(),
		branch: "main",
	};
}

/** Staged, unstaged, and untracked non-ignored paths. */
export function uncommittedFiles(root: string): string[] {
	const output = gitOrThrow(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
	const files: string[] = [];
	const entries = output.split("\0").filter((entry) => entry.length > 0);
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index];
		const status = entry.slice(0, 2);
		files.push(`${entry.slice(3)} (${status.trim() === "??" ? "untracked" : status.includes("D") ? "deleted" : "modified"})`);
		// Renames and copies carry their source path as a separate entry.
		if (status.startsWith("R") || status.startsWith("C")) index++;
	}
	return files;
}

/** Revision syntax accepted from the agent. Options and shell metacharacters never reach git. */
export function isSafeRevision(value: string): boolean {
	return value.length > 0 && value.length <= 200 && !value.startsWith("-") && /^[A-Za-z0-9._/@^~{}-]+$/.test(value);
}

export interface SourceIdentity {
	commit: string;
	tree: string;
	/** A branch that pointed at the commit when the trial started, if any. */
	branch?: string;
	subject: string;
	/** What the agent asked for, before resolution. */
	requested: string;
}

export function resolveCommit(root: string, revision: string): SourceIdentity | undefined {
	if (!isSafeRevision(revision)) return undefined;
	const resolved = git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`]);
	if (resolved.status !== 0) return undefined;
	const commit = resolved.stdout.trim();
	const tree = gitOrThrow(root, ["rev-parse", `${commit}^{tree}`]).trim();
	const subject = gitOrThrow(root, ["log", "-1", "--format=%s", commit]).trim();
	const current = git(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
	const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
	let branch: string | undefined;
	if (current.status === 0 && head.status === 0 && head.stdout.trim() === commit) {
		branch = current.stdout.trim();
	} else {
		const pointing = git(root, ["branch", "--points-at", commit, "--format=%(refname:short)"]);
		branch = pointing.status === 0 ? pointing.stdout.split("\n").map((line) => line.trim()).find(Boolean) : undefined;
	}
	return { commit, tree, subject, requested: revision, ...(branch ? { branch } : {}) };
}

/** A detached checkout of exactly `commit`, isolated from later edits and branch switches. */
export function addWorktree(root: string, path: string, commit: string): void {
	mkdirSync(dirname(path), { recursive: true });
	gitOrThrow(root, ["worktree", "add", "--quiet", "--detach", path, commit]);
}

/** Remove a trial worktree; the commit stays in the repository. Safe to repeat. */
export function removeWorktree(root: string, path: string): void {
	if (existsSync(path)) {
		const result = git(root, ["worktree", "remove", "--force", "--force", path]);
		if (result.status !== 0) rmSync(path, { recursive: true, force: true });
	}
	git(root, ["worktree", "prune"]);
}

export function tagCommit(root: string, name: string, commit: string, message?: string, move = false): void {
	const args = [...HARNESS_IDENTITY, "tag", ...(move ? ["-f"] : []), ...(message === undefined ? [] : ["-a", "-m", message]), name, commit];
	gitOrThrow(root, args);
}

/** The message of an annotated tag, or undefined when the tag does not exist. */
export function tagMessage(root: string, name: string): { commit: string; message: string } | undefined {
	const commit = git(root, ["rev-parse", "--verify", "--quiet", `refs/tags/${name}^{commit}`]);
	if (commit.status !== 0) return undefined;
	const message = git(root, ["tag", "-l", "--format=%(contents)", name]);
	return { commit: commit.stdout.trim(), message: message.status === 0 ? message.stdout.trim() : "" };
}
