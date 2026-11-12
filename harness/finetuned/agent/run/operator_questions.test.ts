import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askLead, messageText, OperatorQuestions, readAnswer } from "./operator_questions.js";
import { runLeadSession } from "./lead_session.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
import { spamConfiguration } from "../pipeline/task_configuration.testing.js";

test("a question is delivered once and answered by the next assistant text after the lead saw it", () => {
	const directory = mkdtempSync(join(tmpdir(), "operator-questions-"));
	try {
		const operator = new OperatorQuestions(directory);
		const id = askLead(directory, "Why no scouts?");
		const [question] = operator.take();
		expect(question).toEqual({ id, text: "Why no scouts?" });
		expect(operator.take()).toEqual([]);
		expect(readdirSync(join(directory, "questions"))).toEqual([]);
		// Text produced before the lead saw the question is not its answer.
		expect(operator.answered("unrelated earlier text")).toEqual([]);
		expect(operator.delivered(`Operator question ${id} ...`)).toEqual([id]);
		expect(operator.answered("")).toEqual([]);
		expect(operator.answered("Because I judged the baseline sufficient.")).toEqual([id]);
		expect(readAnswer(directory, id)).toBe("Because I judged the baseline sufficient.\n");
		expect(operator.answered("later text")).toEqual([]);
		expect(messageText({ content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
		expect(() => askLead(directory, "  ")).toThrow("Empty question");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the live lead receives a queued question in its running session and its answer is saved", async () => {
	const root = mkdtempSync(join(tmpdir(), "operator-lead-"));
	try {
		const solutionsRoot = join(root, "solutions"); mkdirSync(solutionsRoot);
		const git = (...args: string[]) => execFileSync("git", ["-C", solutionsRoot, ...args], { encoding: "utf8" }).trim();
		git("init"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
		writeFileSync(join(solutionsRoot, "INDEX.md"), "fixture"); git("add", "."); git("-c", "commit.gpgsign=false", "commit", "-m", "fixture");
		const commit = git("rev-parse", "HEAD");
		const taskPath = join(root, "task.md"), devZip = join(root, "dev.zip"), manifest = join(root, "manifest");
		writeFileSync(taskPath, "task"); writeFileSync(devZip, "fixture"); writeFileSync(manifest, "{}");
		const data: any = { root, solutionsRoot, taskPath, devZip, sampleManifestPath: manifest, configuration: spamConfiguration(), datasetSha256: "d".repeat(64),
			datasetPaths: [devZip], targets: manifest, rowCount: 4, targetSummary: "balanced", recommendation: { folds: 2, repeats: 1, scheme: "stratified_kfold" }, split: { scheme: "none", sealedIds: [] } };
		const progressPath = join(root, "lead/PROGRESS.json"), directory = join(root, "lead/operator");
		const id = askLead(directory, "What do you think is going wrong?");
		const steered: string[] = [];
		const controller = new AbortController();
		await runLeadSession("spam1", { taskConfiguration: spamConfiguration(), progressPath, signal: controller.signal, prompts: loadPromptSnapshot(), dependencies: {
			prepareData: () => data, readPython: () => ({ prefix: root, executable: "/bin/false", fingerprint: "f" } as any),
			sandbox: () => ({ executable: "/bin/false", cwd: root, mounts: [], env: {}, agentRoot: join(root, "agent") } as any),
			prepareRepository: () => ({ initialized: false, head: commit, branch: "master" }), environmentTool: () => ({ name: "python_environment" } as any),
			createTraining: () => ({ ready: async () => {}, close: async () => {}, tools: [], toolPrompts: [], service: { describe: () => ({}) }, supervisor: { list: () => [] }, bindSession: () => {} } as any),
			scouts: () => ({ tool: { name: "scout" } as any, report: async () => ({ text: "", roles: [] }) }),
			refit: async () => { throw new Error("no refit"); }, collectResults: async () => ({ valid: false, trials: [], artifacts: [], errors: [] }) as any,
			runAgentSession: async (options: any) => {
				const handlers: any = {};
				for (const extension of options.extensionFactories) extension.factory({ on: (name: string, fn: any) => { (handlers[name] ??= []).push(fn); } });
				options.wakeTarget({ isStreaming: true, steer: async (text: string) => { steered.push(text); }, sendCustomMessage: async () => {} });
				for (const end = Date.now() + 5_000; !steered.length && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 50));
				const emit = async (message: unknown) => { for (const fn of handlers.message_end ?? []) await fn({ message }); };
				await emit({ role: "user", content: steered[0] });
				await emit({ role: "assistant", content: [{ type: "text", text: "The baseline looked strong, so I skipped scouts." }] });
				controller.abort();
				return { output: "cancelled", agentRunId: "fixture" };
			},
		} });
		expect(steered).toHaveLength(1);
		expect(steered[0]).toContain(id);
		expect(steered[0]).toContain("What do you think is going wrong?");
		expect(readAnswer(directory, id)).toBe("The baseline looked strong, so I skipped scouts.\n");
		expect(existsSync(join(directory, "delivered", `${id}.md`))).toBe(true);
	} finally { rmSync(root, { recursive: true, force: true }); }
});
