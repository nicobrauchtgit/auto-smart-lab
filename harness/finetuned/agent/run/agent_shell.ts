/**
 * Every agent shell call runs under process supervision.
 *
 * One factory makes every agent `bash` tool: the host shell of a scoped session,
 * subagent children, and the sandboxed tools of the solve session and every
 * expert role (`isolatedSolveTools`). Each call is a process held by an
 * `ExperimentSupervisor`, with the sampler, findings and process-wide machine
 * protection that harness trials have, so protection chooses among shell calls
 * and trials by size. In a sandbox the supervised process is the sandbox
 * launcher itself: the call runs inside the same boundary as before.
 *
 * A tool is made before its session exists, so its owner is bound later:
 * `runSession` and the subagent factory call `bindAgentShells` for the final
 * tool set they hand to a session (after replacement by name), and
 * `assertSupervisedBash` refuses a `bash` tool from anywhere else. A future
 * role that gets bash is supervised, or does not start.
 *
 * A supervised tool carries its binding under an enumerable symbol, which
 * object spread copies: a wrapper made with `{ ...tool, execute }` or
 * `wrapAgentTool` is still recognised, and binding the wrapper binds the
 * supervisor the original reports through. Only bindings made here count, so
 * the brand cannot be forged onto a raw shell.
 */

import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

import { createSupervisedBashTool } from "../experiments/bash.js";
import { wake, type Wakeable } from "../experiments/index.js";
import type { MachineProtection } from "../experiments/protection.js";
import type { SupervisorLimits, Update } from "../experiments/types.js";
import type { PromptSnapshot } from "../prompts/loader.js";
import { STATE_ROOT } from "../paths.js";
import { sandboxPolicy, type SolveSandbox } from "./solve_sandbox.js";

/** Where an unsandboxed session's shell calls keep their full output. */
export const HOST_SHELL_LOG_ROOT = join(STATE_ROOT, "shell-calls");

/** How one agent's shell calls run. */
export interface AgentShell {
	/** Host path the command runs in (the same path inside a sandbox). */
	cwd: string;
	/** Host directory for each call's full output; the owner's read tool must reach it. */
	logRoot: string;
	/** Environment of the supervised process. A sandbox sets its own inside. */
	env: Record<string, string>;
	/** The supervised process for one command. */
	argv(command: string): string[];
	/** Test seams. Production uses the process-wide arbiter and harness.config.json. */
	protection?: MachineProtection;
	limits?: Partial<SupervisorLimits>;
}

/** The session a shell tool reports to, once one exists. */
export interface ShellOwner {
	session: Wakeable;
	/** The session's observability record, shared run and invocation IDs included. */
	record?: (eventType: string, payload: Record<string, unknown>) => void;
	/** The run's prompt snapshot; notes are rendered from it. */
	prompts?: PromptSnapshot;
}

interface Binding {
	owner?: ShellOwner;
	/** Findings before a session was bound; they join its next turn. */
	pending: { text: string; update: Update }[];
	/** Stops what the tool's calls left running. */
	close(): Promise<void>;
}

/** Enumerable, so `{ ...tool }` copies it; module-private, so only this module brands. */
const AGENT_SHELL: unique symbol = Symbol("agent-shell");
const bindings = new WeakSet<Binding>();

function bindingOf(tool: object): Binding | undefined {
	const value = (tool as { [AGENT_SHELL]?: unknown })[AGENT_SHELL];
	return value && typeof value === "object" && bindings.has(value as Binding) ? value as Binding : undefined;
}

function bashOn(path: string | undefined): string {
	for (const directory of (path ?? "").split(delimiter).filter(Boolean)) {
		const candidate = join(directory, "bash");
		try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next */ }
	}
	return "bash";
}

/** A shell on the host, as an unsandboxed session or a subagent child had before. */
export function hostShell(cwd: string, env: Readonly<Record<string, string | undefined>>, logRoot = HOST_SHELL_LOG_ROOT): AgentShell {
	const frozen = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
	const bash = bashOn(frozen.PATH);
	return { cwd, logRoot, env: frozen, argv: (command) => [bash, "-c", command] };
}

/** First writable directory of a sandbox: the agent's own workspace, which its read tool reaches. */
function sandboxLogRoot(policy: SolveSandbox): string {
	const writable = policy.mounts.find((mount) => mount.writable);
	if (!writable) throw new Error("A sandboxed shell needs a writable workspace for its output");
	return join(writable.source, ".shell-calls");
}

/**
 * A shell inside the sandbox. The supervised process is the sandbox launcher
 * with the command inside it, so sampling, stops and machine protection act on
 * the sandboxed processes and the mount, PID and user boundary is unchanged.
 */
export function sandboxShell(policy: SolveSandbox, logRoot?: string): AgentShell {
	// Resolved at the first call, so building a session's tools never touches the filesystem.
	let inside: SolveSandbox | undefined;
	const bash = bashOn(policy.env.PATH);
	return {
		cwd: policy.cwd, env: {},
		get logRoot() { return logRoot ??= sandboxLogRoot(policy); },
		argv: (command) => {
			// Unbuffered Python inside, so output timing reaches the supervisor as it happens.
			inside ??= sandboxPolicy({ mounts: policy.mounts, cwd: policy.cwd, env: { ...policy.env, PYTHONUNBUFFERED: "1" }, bwrap: policy.executable });
			return [inside.executable, ...inside.args([bash, "-c", command])];
		},
	};
}

/** The `bash` tool every agent gets: blocking, supervised, reporting to its owner session. */
export function agentBashTool(shell: AgentShell): ToolDefinition {
	const binding: Binding = { pending: [], close: async () => undefined };
	const options = {
		// Read when each call starts, like the owner below.
		get root() { return shell.logRoot; },
		env: shell.env, argv: shell.argv,
		...(shell.protection ? { protection: shell.protection } : {}),
		...(shell.limits ? { limits: shell.limits } : {}),
		get prompts() { return binding.owner?.prompts; },
		record: (eventType: string, payload: Record<string, unknown>) => binding.owner?.record?.(eventType, payload),
		deliver: async (text: string, update: Update) => {
			if (binding.owner) return await wake(binding.owner.session, text, update);
			binding.pending.push({ text, update });
			if (binding.pending.length > 100) binding.pending.shift();
		},
	};
	const supervised = createSupervisedBashTool(shell.cwd, options);
	binding.close = () => supervised.close();
	const tool = defineTool(supervised as never) as ToolDefinition;
	bindings.add(binding);
	Object.defineProperty(tool, AGENT_SHELL, { value: binding, enumerable: true });
	return tool;
}

export function isAgentShellTool(tool: object): boolean {
	return bindingOf(tool) !== undefined;
}

/**
 * Wrap a tool's `execute` and keep everything else, the supervision brand
 * included. `wrap` receives the original `execute` (bound to the original
 * tool) and returns the replacement, which must delegate to it.
 */
export function wrapAgentTool<T extends ToolDefinition>(tool: T, wrap: (execute: T["execute"]) => T["execute"]): T {
	const execute = tool.execute.bind(tool) as T["execute"];
	const wrapped = { ...tool, execute: wrap(execute) } as T;
	const binding = bindingOf(tool);
	if (binding) Object.defineProperty(wrapped, AGENT_SHELL, { value: binding, enumerable: true });
	return wrapped;
}

/**
 * The tool set a session gets: `defaults`, each replaced by a tool of the same
 * name from `replacements`, plus the remaining replacements. This is the set
 * to validate and bind, never the originals.
 */
export function replaceToolsByName<T extends Pick<ToolDefinition, "name">>(defaults: readonly T[], replacements: readonly T[] = []): T[] {
	return [...new Map([...defaults, ...replacements].map((tool) => [tool.name, tool])).values()];
}

/** Stop what the agent shell tools in `tools` left running. Called when their session ends. */
export async function closeAgentShells(tools: readonly object[]): Promise<void> {
	const unique = new Set(tools.map(bindingOf).filter((binding): binding is Binding => binding !== undefined));
	await Promise.all([...unique].map((binding) => binding.close().catch(() => undefined)));
}

/**
 * Bind every agent shell tool in `tools` to the session that runs it. Called
 * again for a replacement session, which then receives later findings.
 */
export function bindAgentShells(tools: readonly object[], owner: ShellOwner): number {
	let bound = 0;
	for (const tool of tools) {
		const binding = bindingOf(tool);
		if (!binding) continue;
		binding.owner = owner;
		bound++;
		for (const item of binding.pending.splice(0)) {
			void owner.session.sendCustomMessage(
				{ customType: "experiment_update", content: item.text, display: true, details: { id: item.update.id, kind: item.update.kind } },
				{ triggerTurn: false, deliverAs: "nextTurn" }).catch(() => undefined);
		}
	}
	return bound;
}

/** Refuse an agent `bash` tool that would run outside supervision. */
export function assertSupervisedBash(tools: readonly Pick<ToolDefinition, "name">[]): void {
	for (const tool of tools) {
		if (tool.name === "bash" && !isAgentShellTool(tool)) {
			throw new Error("Agent bash tools must come from agentBashTool (run/agent_shell.ts), so every shell call is supervised");
		}
	}
}
