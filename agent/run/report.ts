#!/usr/bin/env npx tsx
/**
 * Collect results from every batch run into one table.
 *
 *   npm run report                     all runs: local logs/solve-units/ and VM logs pulled to logs/vm/
 *   npm run report -- --md             Markdown table (for docs/EXPERIMENT_LOG.md)
 *   npm run report -- --task spam2     only this task (comma-separated list allowed)
 *   npm run report -- --model gemini   only models containing this string
 *   npm run report -- --since 2026-10-01
 *   npm run report -- --lab            also print the lab's current attempts and scores per task
 *   npm run report -- --skipped        include tasks the batch skipped
 *
 * Sources: logs/solve-units/<stamp>/summary.json (written by solve_units.ts) and the same under
 * logs/vm/<host>/ (scripts/vm/remote.sh pull). Runs made before conditions were recorded show "?"
 * for the commit; their model is taken from the task log when the summary lacks it.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchTaskStatus, SimpleClient } from "./submit_session.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const LOGS = join(PROJECT_ROOT, "logs");

type Json = Record<string, any>;

interface Row {
	source: string; stamp: string; task: string; model: string; commit: string; evalMode: string;
	outcome: string; attempts: string; best: number | null; submissions: string; minutes: number; costUsd: number; reason: string;
}

const args = process.argv.slice(2);
const flag = (f: string) => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
const opt = (f: string) => { const i = args.indexOf(f); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const md = flag("--md");
const lab = flag("--lab");
const withSkipped = flag("--skipped");
const taskFilter = (opt("--task") ?? "").split(",").map(s => s.trim()).filter(Boolean);
const modelFilter = opt("--model");
const since = opt("--since");
if (args.length) {
	console.error("Usage: npm run report -- [--md] [--lab] [--skipped] [--task a,b] [--model <substr>] [--since YYYY-MM-DD]");
	process.exit(1);
}

/** Every summary.json, with the directory its relative log paths resolve against. */
function findSummaries(): { file: string; source: string; logRoot: string }[] {
	const out: { file: string; source: string; logRoot: string }[] = [];
	const scan = (dir: string, source: string, logRoot: string) => {
		if (!existsSync(dir)) return;
		for (const stamp of readdirSync(dir)) {
			const f = join(dir, stamp, "summary.json");
			if (existsSync(f)) out.push({ file: f, source, logRoot });
		}
	};
	scan(join(LOGS, "solve-units"), "local", PROJECT_ROOT);
	const vmDir = join(LOGS, "vm");
	if (existsSync(vmDir)) {
		for (const host of readdirSync(vmDir)) {
			const root = join(vmDir, host);
			if (!statSync(root).isDirectory()) continue;
			// Pulled copies mirror the VM's logs/ dir, so "logs/x" in the summary is "<root>/x" here.
			scan(join(root, "solve-units"), host.replace(/^.*@/, "").split(".")[0], root);
		}
	}
	return out;
}

function modelFromLog(logRoot: string, log: string | null): string | null {
	if (!log) return null;
	const p = logRoot === PROJECT_ROOT ? join(PROJECT_ROOT, log) : join(logRoot, log.replace(/^logs\//, ""));
	try {
		const m = readFileSync(p, "utf8").slice(0, 20000).match(/\[orchestrate\] Using model: (\S+)/);
		return m ? m[1] : "default";
	} catch { return null; }
}

const fmt = (x: number | null | undefined, d = 4) => x === null || x === undefined ? "-" : x.toFixed(d);

function rows(): Row[] {
	const out: Row[] = [];
	for (const { file, source, logRoot } of findSummaries()) {
		let sum: Json;
		try { sum = JSON.parse(readFileSync(file, "utf8")); } catch { continue; }
		const stamp = String(sum.stamp ?? file.split("/").at(-2));
		if (since && stamp.slice(0, 10) < since) continue;
		for (const r of (sum.results ?? []) as Json[]) {
			if (!withSkipped && r.exitCode === null && r.outcome === "skipped") continue;
			if (taskFilter.length && !taskFilter.includes(r.id)) continue;
			const c = r.conditions as Json | undefined;
			const model = c?.model ?? sum.model ?? modelFromLog(logRoot, r.log) ?? "?";
			if (modelFilter && !String(model).includes(modelFilter)) continue;
			const a = r.after as Json | null;
			const subs = (r.submissions ?? []) as Json[];
			out.push({
				source, stamp, task: r.id, model: String(model).replace(/^(gwdg|google-vertex)\//, ""),
				commit: c?.git?.commit ? `${c.git.commit}${c.git.dirty?.length ? "+" : ""}` : "?",
				evalMode: c?.caps ? (c.caps.eval === false ? "off" : "on") : "?",
				outcome: r.outcome, attempts: a ? `${a.attemptsUsed ?? "?"}/${a.attemptsMax}` : "?",
				best: a?.bestScore ?? null,
				submissions: subs.map(s => `${fmt(s.local, 3)}→${fmt(s.platform, 3)}`).join(" "),
				minutes: Number(r.minutes) || 0, costUsd: Number(r.costUsd) || 0, reason: String(r.reason ?? ""),
			});
		}
	}
	return out.sort((x, y) => x.stamp.localeCompare(y.stamp) || x.task.localeCompare(y.task));
}

function printRows(rs: Row[]) {
	const head = ["run", "where", "task", "model", "commit", "eval", "outcome", "attempts", "best", "local→platform", "min", "$"];
	const cells = rs.map(r => [r.stamp.slice(0, 16).replace("T", " "), r.source, r.task, r.model, r.commit, r.evalMode, r.outcome, r.attempts, fmt(r.best), r.submissions || "-", r.minutes ? String(r.minutes) : "-", r.costUsd ? r.costUsd.toFixed(2) : "-"]);
	if (md) {
		console.log(`| ${head.join(" | ")} |`);
		console.log(`|${head.map(() => "---").join("|")}|`);
		for (const c of cells) console.log(`| ${c.join(" | ")} |`);
	} else {
		const w = head.map((h, i) => Math.min(40, Math.max(h.length, ...cells.map(c => c[i].length))));
		const line = (c: string[]) => "  " + c.map((x, i) => x.slice(0, w[i]).padEnd(w[i])).join("  ");
		console.log(line(head));
		console.log("  " + w.map(n => "-".repeat(n)).join("  "));
		for (const c of cells) console.log(line(c));
	}
	const cost = rs.reduce((a, r) => a + r.costUsd, 0);
	console.log(`\n${rs.length} task run(s)${cost ? `, $${cost.toFixed(2)} model spend` : ""}. local→platform: the solver's local score before each submission and the platform's result.`);
}

async function printLab() {
	const indexPath = join(PROJECT_ROOT, "units", "index.json");
	if (!existsSync(indexPath)) { console.log("(no units/index.json; run fetch first)"); return; }
	const index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, string>;
	const insecure = !/^(0|false|no|off)$/i.test(process.env.LAB_INSECURE_TLS ?? "1");
	const client = new SimpleClient(insecure);
	console.log(`\nLab state now:\n`);
	console.log(`  ${"task".padEnd(11)} ${"attempts".padEnd(9)} ${"best".padEnd(7)} scores`);
	for (const [id, url] of Object.entries(index)) {
		if (taskFilter.length && !taskFilter.includes(id)) continue;
		try {
			const st = await fetchTaskStatus(url, insecure, client);
			console.log(`  ${id.padEnd(11)} ${`${st.attemptsUsed ?? "?"}/${st.attemptsMax}`.padEnd(9)} ${fmt(st.bestScore).padEnd(7)} ${st.scores.map(x => fmt(x)).join(", ") || "-"}`);
		} catch (err) {
			console.log(`  ${id.padEnd(11)} (could not read: ${err instanceof Error ? err.message : err})`);
		}
	}
}

const rs = rows();
if (rs.length) printRows(rs); else console.log("No batch results found under logs/solve-units/ or logs/vm/*/solve-units/.");
if (lab) await printLab();
