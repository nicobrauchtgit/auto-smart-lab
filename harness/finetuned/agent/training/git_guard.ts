/**
 * Block shell commands that rewrite or destroy solutions history.
 *
 * Every measured trial records the commit it ran, so rewriting history would
 * orphan evidence. This guards against mistakes; it is not a security boundary:
 * aliases, scripts, and other tools can still reach the repository.
 */

import type { InlineExtension } from "@earendil-works/pi-coding-agent";

import type { PromptSnapshot } from "../prompts/loader.js";

export type GitBlockRule =
	| "reset" | "amend" | "rebase" | "filter" | "force-push" | "delete-ref" | "recovery" | "remove-git";

const PROMPTS = {
	"reset": "git.block-reset",
	"amend": "git.block-amend",
	"rebase": "git.block-rebase",
	"filter": "git.block-filter",
	"force-push": "git.block-force-push",
	"delete-ref": "git.block-delete-ref",
	"recovery": "git.block-recovery",
	"remove-git": "git.block-remove-git",
} as const satisfies Record<GitBlockRule, string>;

export const GIT_BLOCK_PROMPT_IDS = Object.values(PROMPTS);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const WRAPPERS = new Set(["sudo", "env", "command", "nohup", "time", "exec", "nice"]);
/** git global options that consume the following token. */
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

/** Split at unquoted command separators, including substitutions and subshells. */
function segments(command: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: "'" | "\"" | undefined;
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === "\"" && index + 1 < command.length) {
				current += char + command[++index];
				continue;
			}
			current += char;
			continue;
		}
		if (char === "'" || char === "\"") {
			quote = char;
			current += char;
			continue;
		}
		if (char === "\\" && index + 1 < command.length) {
			current += char + command[++index];
			continue;
		}
		if (";|&\n()`".includes(char) || (char === "$" && command[index + 1] === "(")) {
			parts.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	parts.push(current);
	return parts.map((part) => part.trim()).filter(Boolean);
}

/** Whitespace tokens with shell quoting removed. */
function words(segment: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let started = false;
	let quote: "'" | "\"" | undefined;
	for (let index = 0; index < segment.length; index++) {
		const char = segment[index];
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === "\"" && index + 1 < segment.length) current += segment[++index];
			else current += char;
			continue;
		}
		if (char === "'" || char === "\"") {
			quote = char;
			started = true;
			continue;
		}
		if (char === "\\" && index + 1 < segment.length) {
			current += segment[++index];
			started = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (started) tokens.push(current);
			current = "";
			started = false;
			continue;
		}
		current += char;
		started = true;
	}
	if (started) tokens.push(current);
	return tokens;
}

function basename(path: string): string {
	return path.replace(/\/+$/, "").split("/").pop() ?? path;
}

function shortFlags(args: readonly string[]): string {
	return args.filter((arg) => /^-[A-Za-z]+$/.test(arg)).map((arg) => arg.slice(1)).join("");
}

function isGitDirectory(path: string): boolean {
	const cleaned = path.replace(/\/+$/, "");
	return basename(cleaned) === ".git" || /(^|\/)\.git\//.test(cleaned) || /(^|\/)\.git\*$/.test(cleaned);
}

function classifyGit(args: readonly string[]): GitBlockRule | undefined {
	let index = 0;
	while (index < args.length && args[index].startsWith("-")) {
		index += GIT_OPTIONS_WITH_VALUE.has(args[index]) ? 2 : 1;
	}
	const subcommand = args[index];
	const rest = args.slice(index + 1);
	const flags = shortFlags(rest);
	const has = (...names: string[]) => rest.some((arg) => names.some((name) => arg === name || arg.startsWith(`${name}=`)));
	switch (subcommand) {
		case "reset":
			return has("--hard", "--keep") ? "reset" : undefined;
		case "commit":
			return has("--amend") ? "amend" : undefined;
		case "rebase":
			return has("--abort", "--quit") ? undefined : "rebase";
		case "filter-branch":
		case "filter-repo":
			return "filter";
		case "push":
			return has("--force", "--force-with-lease", "--force-if-includes", "--mirror", "--delete", "--prune")
				|| /[fd]/.test(flags)
				|| rest.some((arg) => /^[+:]/.test(arg))
				? "force-push"
				: undefined;
		case "branch":
			return flags.includes("D") || flags.includes("M") || (has("--delete", "-d") && has("--force", "-f"))
				|| (flags.includes("d") && flags.includes("f"))
				? "delete-ref"
				: undefined;
		case "tag":
			return has("--delete", "--force") || /[df]/.test(flags) ? "delete-ref" : undefined;
		case "update-ref":
			return has("-d", "--delete") || /d/.test(flags) ? "delete-ref" : undefined;
		case "reflog":
			return rest[0] === "expire" || rest[0] === "delete" ? "recovery" : undefined;
		case "gc":
			return has("--prune") ? "recovery" : undefined;
		case "prune":
			return "recovery";
		default:
			return undefined;
	}
}

/** The first history-destroying operation in a shell command, if any. */
export function classifyCommand(command: string, depth = 0): GitBlockRule | undefined {
	for (const segment of segments(command)) {
		let tokens = words(segment);
		while (tokens.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || WRAPPERS.has(basename(tokens[0])))) {
			tokens = tokens.slice(1);
		}
		if (tokens.length === 0) continue;
		const program = basename(tokens[0]);
		const args = tokens.slice(1);
		if (SHELLS.has(program) && depth < 3) {
			const script = args[args.indexOf("-c") + 1];
			if (args.includes("-c") && script !== undefined) {
				const nested = classifyCommand(script, depth + 1);
				if (nested) return nested;
			}
			continue;
		}
		if (program === "git") {
			const rule = classifyGit(args);
			if (rule) return rule;
			continue;
		}
		if ((program === "rm" || program === "rmdir" || program === "mv" || program === "shred" || program === "unlink")
			&& args.some((arg) => !arg.startsWith("-") && isGitDirectory(arg))) {
			return "remove-git";
		}
		if (program === "find" && args.some((arg) => isGitDirectory(arg)) && args.some((arg) => arg === "-delete" || arg === "-exec")) {
			return "remove-git";
		}
	}
	return undefined;
}

export interface GitBlock {
	rule: GitBlockRule;
	reason: string;
}

/** Decide one Pi tool call. Bash commands and direct writes into `.git` are checked. */
export function gitHistoryBlock(toolName: string, input: Record<string, unknown>, prompts: PromptSnapshot): GitBlock | undefined {
	let rule: GitBlockRule | undefined;
	if (toolName === "bash" && typeof input.command === "string") {
		rule = classifyCommand(input.command);
	} else if ((toolName === "write" || toolName === "edit") && typeof input.path === "string" && isGitDirectory(input.path)) {
		rule = "remove-git";
	}
	if (!rule) return undefined;
	return { rule, reason: prompts.render(PROMPTS[rule], {}).text };
}

/** A Pi extension registering the guard on `tool_call`. */
export function createGitHistoryGuard(
	prompts: PromptSnapshot,
	record?: (eventType: string, payload: Record<string, unknown>) => void,
): InlineExtension {
	return {
		name: "git-history-guard",
		factory(pi) {
			pi.on("tool_call", (event) => {
				const block = gitHistoryBlock(event.toolName, event.input as Record<string, unknown>, prompts);
				if (!block) return undefined;
				record?.("git_history_blocked", {
					tool_call_id: event.toolCallId, tool: event.toolName, rule: block.rule,
					prompt_id: PROMPTS[block.rule],
				});
				return { block: true, reason: block.reason };
			});
		},
	};
}
