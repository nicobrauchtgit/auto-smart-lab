import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadPromptSnapshot } from "../prompts/loader.js";
import { classifyCommand, createGitHistoryGuard, gitHistoryBlock, type GitBlockRule } from "./git_guard.js";
import { temporaryProject } from "./testing.js";

const prompts = loadPromptSnapshot();

const BLOCKED: [string, GitBlockRule, RegExp][] = [
	["git reset --hard HEAD~1", "reset", /git revert <commit>/],
	["cd solutions && git reset --keep main", "reset", /git revert <commit>/],
	["git commit --amend -m 'better message'", "amend", /new commit/],
	["git -C solutions commit --amend --no-edit", "amend", /new commit/],
	["git rebase main", "rebase", /git merge <branch>/],
	["git rebase -i HEAD~3", "rebase", /git merge <branch>/],
	["git filter-branch --tree-filter 'rm x' HEAD", "filter", /git rm <file>/],
	["git filter-repo --path secret.py --invert-paths", "filter", /git rm <file>/],
	["git push --force origin main", "force-push", /push new commits normally/],
	["git push -f", "force-push", /push new commits normally/],
	["git push origin +main", "force-push", /push new commits normally/],
	["git branch -D char-ngrams", "delete-ref", /git branch -d <branch>/],
	["git branch --delete --force random-forest", "delete-ref", /git branch -d <branch>/],
	["git tag -d trial/123", "delete-ref", /new tag name/],
	["git tag -f champion HEAD", "delete-ref", /new tag name/],
	["git update-ref -d refs/heads/main", "delete-ref", /git branch -d <branch>/],
	["git reflog expire --expire=now --all", "recovery", /git reflog/],
	["git gc --prune=now", "recovery", /git reflog/],
	["git prune", "recovery", /git reflog/],
	["rm -rf solutions/.git", "remove-git", /git revert/],
	["rm -rf .git/", "remove-git", /git revert/],
	["mv .git ../backup", "remove-git", /git revert/],
	["bash -c 'git reset --hard'", "reset", /git revert <commit>/],
	["ls; GIT_DIR=x git reset --hard", "reset", /git revert <commit>/],
	["echo ok $(git commit --amend -m x)", "amend", /new commit/],
];

const ALLOWED = [
	"git status",
	"git add -A && git commit -m 'Try char n-grams'",
	"git commit -am 'reset the vectorizer'",
	"git switch -c char-ngrams",
	"git checkout main",
	"git merge char-ngrams",
	"git revert --no-edit HEAD",
	"git tag ideas/char-ngrams",
	"git log --oneline --all",
	"git diff trial/abc champion",
	"git branch -d char-ngrams",
	"git reset HEAD features.py",
	"echo 'git reset --hard is blocked'",
	"rm -rf __pycache__",
	"git rebase --abort",
];

describe("git history guard", () => {
	test.each(BLOCKED)("blocks %s with its reason and an allowed alternative", (command, rule, alternative) => {
		expect(classifyCommand(command)).toBe(rule);
		const block = gitHistoryBlock("bash", { command }, prompts);
		expect(block?.rule).toBe(rule);
		expect(block?.reason).toMatch(/^Blocked:/);
		expect(block?.reason).toMatch(alternative);
	});

	test("blocks direct writes into .git through file tools", () => {
		expect(gitHistoryBlock("write", { path: "solutions/.git/refs/heads/main", content: "x" }, prompts)?.rule).toBe("remove-git");
		expect(gitHistoryBlock("edit", { path: "solutions/tasks/spam1.py" }, prompts)).toBeUndefined();
	});

	test("allowed commands pass the guard and still work", () => {
		const project = temporaryProject("git-guard-");
		const run = (command: string) => execSync(command, { cwd: project.solutionsRoot, stdio: "pipe", env: { ...process.env, GIT_EDITOR: "true" } });
		for (const command of ALLOWED) expect(gitHistoryBlock("bash", { command }, prompts)).toBeUndefined();
		writeFileSync(join(project.solutionsRoot, "features.py"), "# char n-grams\n");
		run("git switch -c char-ngrams");
		run("git add -A && git commit -m 'Try char n-grams'");
		run("git checkout main");
		run("git merge char-ngrams");
		run("git revert --no-edit HEAD");
		run("git tag ideas/char-ngrams");
		run("git branch -d char-ngrams");
		expect(run("git log --oneline").toString().split("\n").filter(Boolean)).toHaveLength(3);
	});

	test("registers as a Pi tool_call extension that returns block and reason", async () => {
		const recorded: Record<string, unknown>[] = [];
		const extension = createGitHistoryGuard(prompts, (_type, payload) => recorded.push(payload));
		let handler: ((event: any) => unknown) | undefined;
		const factory = typeof extension === "function" ? extension : extension.factory;
		await factory({ on(event: string, fn: (event: any) => unknown) { if (event === "tool_call") handler = fn; } } as any);
		expect(await handler!({ type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command: "git status" } })).toBeUndefined();
		const result = await handler!({ type: "tool_call", toolCallId: "c2", toolName: "bash", input: { command: "git rebase main" } }) as any;
		expect(result.block).toBe(true);
		expect(result.reason).toBe(prompts.render("git.block-rebase", {}).text);
		expect(recorded).toEqual([{ tool_call_id: "c2", tool: "bash", rule: "rebase", prompt_id: "git.block-rebase" }]);
	});
});
