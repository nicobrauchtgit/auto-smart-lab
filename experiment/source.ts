/** Explicit source-only continuation of this arm's own earlier run. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface RetainedSource {
	sourceRun: string;
	files: { path: string; sha256: string; content: Buffer }[];
}

/** Read and validate before creating a workspace or starting any agent. */
export function minimalSource(projectRoot: string, sourceFrom: string): RetainedSource {
	const parent = realpathSync(join(projectRoot, "runs/minimal"));
	const requested = resolve(projectRoot, sourceFrom);
	if (lstatSync(requested).isSymbolicLink() || dirname(realpathSync(requested)) !== parent) {
		throw new Error("--source-from must name a real run directly under runs/minimal; other arms and symlinks are refused");
	}
	const source = join(requested, "agent/smartlab");
	for (const path of [join(requested, "agent"), source]) {
		if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) throw new Error("Retained source directories must be regular directories");
	}
	const files: RetainedSource["files"] = [];
	const walk = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name === "__pycache__" || entry.name === "checkpoints") continue;
			const path = join(directory, entry.name);
			if (entry.isSymbolicLink()) throw new Error("Retained source may not contain symlinks");
			if (entry.isDirectory()) { walk(path); continue; }
			if (!entry.isFile() || !entry.name.endsWith(".py")) continue;
			const name = relative(source, path);
			const content = readFileSync(path);
			const framework = join(projectRoot, "harness/minimal/agent/smartlab", name);
			if (!name.startsWith("tasks/") && existsSync(framework)) {
				if (!content.equals(readFileSync(framework))) throw new Error(`Retained source would replace current framework code: ${name}`);
				continue;
			}
			files.push({ path: join("agent/smartlab", name), sha256: createHash("sha256").update(content).digest("hex"), content });
		}
	};
	walk(source);
	if (!files.some(file => file.path.endsWith(".py") && !file.path.endsWith("/__init__.py"))) throw new Error("The selected minimal run contains no reusable Python source");
	return { sourceRun: relative(projectRoot, requested), files };
}
