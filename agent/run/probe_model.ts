#!/usr/bin/env npx tsx
/**
 * Check that a model works through the real harness: one tiny session, one bash tool call.
 *
 *   npm run probe-model -- google-vertex/gemini-3.7-flash
 *
 * Exits 0 when the model called the tool and returned the right answer, 1 otherwise.
 * Costs a fraction of a cent on paid providers.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProcessUsage, runSession } from "./session_runner.js";

const model = process.argv[2];
if (!model) {
	console.error("usage: npm run probe-model -- <provider/model-id>");
	process.exit(2);
}
process.env.PI_MODEL = model;
process.env.PI_SESSION_TIMEOUT_MS ??= "180000";

const dir = mkdtempSync(join(tmpdir(), "probe-"));
const instructions = join(dir, "probe.md");
writeFileSync(instructions, "You are a connectivity probe. Use the bash tool exactly once to run `echo probe-$((6*7))`, then reply with the number it printed and nothing else.");

try {
	const { output } = await runSession({ instructionsPath: instructions, prompt: "Run the probe.", label: "probe" });
	const u = getProcessUsage();
	const ok = /\b42\b/.test(output);
	console.log(`PROBE ${ok ? "OK" : "FAILED"} ${model}: answer=${JSON.stringify(output.trim().slice(-30))} calls=${u.requests} tokens=${u.input}/${u.output} cost=$${u.costUsd.toFixed(4)}`);
	process.exit(ok ? 0 : 1);
} catch (err) {
	console.log(`PROBE FAILED ${model}: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`);
	process.exit(1);
}
