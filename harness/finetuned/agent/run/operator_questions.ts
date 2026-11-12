/**
 * Questions from the person running the experiment, put to the live lead so it
 * answers in its own context. The folder is harness-owned (next to
 * PROGRESS.json, outside every agent mount):
 *
 *   questions/<id>.md   written by `ask_lead.ts`, picked up while the lead runs
 *   delivered/<id>.md   moved here once steered into the session
 *   answers/<id>.md     the lead's next assistant text after it saw the question
 *
 * A question changes the lead's context from then on; that is the point.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export interface OperatorQuestion { id: string; text: string }
const ID = /^[0-9TZ-]+-[0-9a-f]{6}$/;

/** Writes a question atomically and returns its ID. */
export function askLead(directory: string, question: string): string {
	const text = question.trim();
	if (!text) throw new Error("Empty question");
	const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
	mkdirSync(join(directory, "questions"), { recursive: true });
	const temporary = join(directory, "questions", `.${id}.tmp`);
	writeFileSync(temporary, `${text}\n`, { mode: 0o600 });
	renameSync(temporary, join(directory, "questions", `${id}.md`));
	return id;
}

export function readAnswer(directory: string, id: string): string | undefined {
	const path = join(directory, "answers", `${id}.md`);
	return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** The lead side: new questions to steer, and capture of the answer that follows each. */
export class OperatorQuestions {
	/** Delivered to the session, waiting for the session to show them. */
	private sent = new Set<string>();
	/** Seen by the lead; its next assistant text answers them. */
	private seen: string[] = [];
	constructor(private directory: string) {}

	/** Questions not yet delivered, oldest first; each is moved to delivered/ so it is sent once. */
	take(): OperatorQuestion[] {
		const folder = join(this.directory, "questions");
		if (!existsSync(folder)) return [];
		mkdirSync(join(this.directory, "delivered"), { recursive: true });
		return readdirSync(folder).filter(name => name.endsWith(".md") && ID.test(name.slice(0, -3))).sort().map(name => {
			const id = name.slice(0, -3), source = join(folder, name), target = join(this.directory, "delivered", name);
			const text = readFileSync(source, "utf8").trim();
			renameSync(source, target);
			this.sent.add(id);
			return { id, text };
		});
	}

	/** A message reached the session: questions it carries are now awaiting an answer. */
	delivered(text: string): string[] {
		const ids = [...this.sent].filter(id => text.includes(id));
		for (const id of ids) { this.sent.delete(id); this.seen.push(id); }
		return ids;
	}

	/** An assistant message ended: its text answers every question the lead has seen. */
	answered(text: string): string[] {
		if (!text.trim() || !this.seen.length) return [];
		const ids = this.seen.splice(0);
		mkdirSync(join(this.directory, "answers"), { recursive: true });
		for (const id of ids) writeFileSync(join(this.directory, "answers", `${id}.md`), `${text.trim()}\n`, { mode: 0o600 });
		return ids;
	}
}

/** Plain text of a pi message's content, whatever its shape. */
export function messageText(message: unknown): string {
	const content = (message as { content?: unknown })?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
}
