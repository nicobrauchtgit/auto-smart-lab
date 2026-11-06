/**
 * Deterministic check of a solver's declared output before it is submitted. A submission spends one
 * of three attempts, so output that cannot be what the task asks for is not uploaded; the solver gets
 * the defects back as facts and another session.
 *
 * Checks only the structure every task's format shares, no judgement of quality and no guess at the
 * ids: the platform checks those itself and refuses wrong ones without counting an attempt (the
 * orchestrator passes its message to the solver). An earlier version required the ids to equal the
 * test archive's member paths; that held for unit 2 but the platform refused exactly those ids for
 * attacks2 ("2990 superfluous IDs", 2026-10-03), so it was removed.
 *  - CSV: exists, non-empty, every line `<id>;<integer label>`, no duplicate ids.
 *  - Token: a single non-empty string without whitespace.
 */

import { existsSync, readFileSync } from "node:fs";

export interface OutputCheck {
	ok: boolean;
	/** Facts for the solver when not ok, and a one-line summary for logs when ok. */
	message: string;
}

const MAX_EXAMPLES = 3;

export function checkCsv(csvPath: string): OutputCheck {
	if (!csvPath || !existsSync(csvPath)) return { ok: false, message: `The declared CSV ${csvPath || "(none)"} does not exist.` };
	const lines = readFileSync(csvPath, "utf8").split(/\r?\n/).filter(l => l.trim() !== "");
	if (!lines.length) return { ok: false, message: `The declared CSV ${csvPath} is empty.` };

	const problems: string[] = [];
	const malformed: string[] = [];
	const seen = new Set<string>();
	const dupes: string[] = [];
	for (const [i, line] of lines.entries()) {
		const m = line.match(/^([^;]+);(-?\d+)$/);
		if (!m) { malformed.push(`line ${i + 1}: ${JSON.stringify(line.slice(0, 80))}`); continue; }
		if (seen.has(m[1])) dupes.push(m[1]);
		seen.add(m[1]);
	}
	if (malformed.length) problems.push(`${malformed.length} line(s) are not \`<id>;<integer label>\` (${malformed.slice(0, MAX_EXAMPLES).join("; ")})`);
	if (dupes.length) problems.push(`${dupes.length} duplicate id(s) (e.g. ${dupes.slice(0, MAX_EXAMPLES).join(", ")})`);

	const summary = `${lines.length} lines`;
	return problems.length
		? { ok: false, message: `The declared CSV ${csvPath} was not submitted: ${problems.join("; ")}.` }
		: { ok: true, message: summary };
}

export function checkToken(token: string | undefined): OutputCheck {
	if (!token || !/^\S+$/.test(token)) return { ok: false, message: "The declared token is empty or contains whitespace; nothing was submitted." };
	return { ok: true, message: `token of ${token.length} chars` };
}
