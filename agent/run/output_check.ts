/**
 * Deterministic check of a solver's declared output before it is submitted. A submission spends one
 * of three attempts, so output that cannot be what the task asks for is not uploaded; the solver gets
 * the defects back as facts and another session.
 *
 * Checks only what is unambiguous from the task material, no judgement of quality:
 *  - CSV: exists, non-empty, every line `<id>;<label>` with an integer label, no duplicate ids;
 *    when the task's data has a `*-test.zip`, the ids must be exactly that archive's file names
 *    (the test archives' member paths are the ids the platform expects, e.g. data/spam1-test/x.x).
 *    Tasks without a test archive (network-intrusion: pcap) get the line checks only.
 *  - Token: a single non-empty string without whitespace.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface OutputCheck {
	ok: boolean;
	/** Facts for the solver when not ok, and a one-line summary for logs when ok. */
	message: string;
}

const MAX_EXAMPLES = 3;

/** File members of the task's test archive, or null when there is none (or it cannot be read). */
function testArchiveMembers(dataDir: string | null): { name: string; members: Set<string> } | null {
	if (!dataDir || !existsSync(dataDir)) return null;
	const zip = readdirSync(dataDir).find(f => /-test\.zip$/i.test(f));
	if (!zip) return null;
	const r = spawnSync("python3", ["-c", "import sys,zipfile,json;print(json.dumps([i.filename for i in zipfile.ZipFile(sys.argv[1]).infolist() if not i.is_dir()]))", join(dataDir, zip)],
		{ encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
	if (r.status !== 0) return null;
	try { return { name: zip, members: new Set(JSON.parse(r.stdout) as string[]) }; } catch { return null; }
}

export function checkCsv(csvPath: string, dataDir: string | null): OutputCheck {
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

	const test = testArchiveMembers(dataDir);
	if (test) {
		const unknown = [...seen].filter(id => !test.members.has(id));
		const missing = [...test.members].filter(id => !seen.has(id));
		if (unknown.length) problems.push(`${unknown.length} id(s) are not file names in ${test.name} (e.g. ${unknown.slice(0, MAX_EXAMPLES).join(", ")}; its files are named like ${[...test.members].slice(0, 2).join(", ")})`);
		if (missing.length) problems.push(`${missing.length} of the ${test.members.size} files in ${test.name} have no prediction`);
	}
	const summary = `${lines.length} lines${test ? `, ids match the ${test.members.size} files in ${test.name}` : ""}`;
	return problems.length
		? { ok: false, message: `The declared CSV ${csvPath} was not submitted: ${problems.join("; ")}.` }
		: { ok: true, message: summary };
}

export function checkToken(token: string | undefined): OutputCheck {
	if (!token || !/^\S+$/.test(token)) return { ok: false, message: "The declared token is empty or contains whitespace; nothing was submitted." };
	return { ok: true, message: `token of ${token.length} chars` };
}
