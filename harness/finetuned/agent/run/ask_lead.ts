/**
 * Ask the running lead of a task a question; it answers in its own context.
 *
 *   ./dev bun harness/finetuned/agent/run/ask_lead.ts spam1 "Why no scouts so far?" [--wait <minutes>]
 *
 * Prints the question ID, and with --wait the answer once the lead gives it.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { statePath, REPO_ROOT } from "../paths.js";
import { askLead, readAnswer } from "./operator_questions.js";

const args = process.argv.slice(2);
const waitAt = args.indexOf("--wait");
const minutes = waitAt >= 0 ? Number(args.splice(waitAt, 2)[1]) : 0;
const [taskId, ...words] = args;
if (!taskId || !/^[a-z0-9_-]+$/i.test(taskId) || !words.length || !(minutes >= 0)) {
	console.error('usage: ask_lead.ts <task> "<question>" [--wait <minutes>]');
	process.exit(2);
}
const directory = statePath(REPO_ROOT, taskId, "lead", "operator");
const id = askLead(directory, words.join(" "));
console.log(`question ${id} queued in ${directory}/questions`);
for (const end = Date.now() + minutes * 60_000; Date.now() < end; await sleep(2_000)) {
	const answer = readAnswer(directory, id);
	if (answer !== undefined) { console.log(`\n${answer}`); process.exit(0); }
}
if (minutes) { console.error(`no answer within ${minutes} min; it will appear in ${directory}/answers/${id}.md`); process.exit(1); }
