/**
 * Offline delivery (since 2026-11): the lab no longer accepts uploads, so the declared result is
 * stored for the course instructor instead of being submitted. Deterministic, no LLM.
 *
 *   logs/deliveries/<stamp>/<task>/
 *     output.csv | token.txt    the solver's declared result, byte-for-byte
 *     source.zip                the same source archive the platform upload carried
 *     manifest.json             task, model, commit, local score, approach, hashes
 *
 * <stamp> comes from SMARTLAB_DELIVERY_DIR (set by solve_units for the whole batch) or is the time
 * of delivery. logs/ is gitignored, survives `npm run reset` and is what `remote.sh pull` copies.
 */

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildZip } from "./submit_session.js";
import type { RunConditions } from "./conditions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");

export interface Delivery {
	dir: string;
	files: string[];
	sha256: string;
	lines: number | null;
}

export function deliver(taskId: string, artifact: { csvPath: string } | { token: string }, info: {
	localScore: number | null; approach: string; iteration: number; conditions: RunConditions;
}): Delivery {
	const base = process.env.SMARTLAB_DELIVERY_DIR
		? resolve(PROJECT_ROOT, process.env.SMARTLAB_DELIVERY_DIR)
		: join(PROJECT_ROOT, "logs", "deliveries", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19));
	const dir = join(base, taskId);
	mkdirSync(dir, { recursive: true });
	const files: string[] = [];
	let data: Buffer;
	if ("token" in artifact) {
		data = Buffer.from(artifact.token + "\n", "utf8");
		writeFileSync(join(dir, "token.txt"), data);
		files.push("token.txt");
	} else {
		data = readFileSync(artifact.csvPath);
		copyFileSync(artifact.csvPath, join(dir, "output.csv"));
		files.push("output.csv");
	}
	writeFileSync(join(dir, "source.zip"), buildZip(PROJECT_ROOT));
	files.push("source.zip");
	const sha256 = createHash("sha256").update(data).digest("hex");
	const lines = "token" in artifact ? null : data.toString("utf8").split("\n").filter(l => l.trim()).length;
	const c = info.conditions;
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({
		task: taskId,
		deliveredAt: new Date().toISOString(),
		model: c.model,
		commit: c.git.commit,
		dirty: c.git.dirty,
		prompts: c.prompts,
		host: c.host,
		python: c.python?.version ?? null,
		localScore: info.localScore,
		approach: info.approach,
		solverSession: info.iteration,
		...("token" in artifact ? {} : { source: artifact.csvPath.replace(PROJECT_ROOT + "/", ""), lines }),
		sha256,
		files,
	}, null, 2) + "\n");
	files.push("manifest.json");
	return { dir: dir.replace(PROJECT_ROOT + "/", ""), files, sha256, lines };
}
