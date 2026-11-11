/** Read-only course inputs supplied by the experiment controller, without modeling guidance. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface CourseResource {
	path: string;
	title: string;
	media_type: "application/pdf" | "text/plain";
	pages: number;
	bytes: number;
	sha256: string;
}

export function courseResources(unit?: string, projectRoot = PROJECT_ROOT): CourseResource[] {
	const root = join(projectRoot, "resources");
	if (!existsSync(root)) return [];
	const units = unit ? [unit] : readdirSync(root);
	return units.flatMap(name => {
		if (!/^[\w-]+$/.test(name)) throw new Error("Invalid course resource unit");
		const directory = join(root, name);
		if (!existsSync(directory)) return [];
		if (!lstatSync(directory).isDirectory()) throw new Error("Invalid course resource directory");
		const manifestPath = join(directory, "manifest.json");
		if (!lstatSync(manifestPath).isFile() || lstatSync(manifestPath).size > 65536) throw new Error("Invalid course resource manifest");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 32) throw new Error("Invalid course resource manifest");
		const seen = new Set<string>();
		return manifest.files.map((entry: Record<string, unknown>) => {
			if (!entry || typeof entry.file !== "string" || !/^[\w-]+\.(pdf|txt)$/.test(entry.file) || seen.has(entry.file)
				|| typeof entry.title !== "string" || !entry.title.trim() || !Number.isSafeInteger(entry.pages) || Number(entry.pages) < 1
				|| typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)
				|| entry.media_type !== (entry.file.endsWith(".pdf") ? "application/pdf" : "text/plain")) throw new Error("Invalid course resource entry");
			seen.add(entry.file);
			const path = join(directory, entry.file), stat = lstatSync(path);
			if (!stat.isFile() || !stat.size || stat.size > 32 * 1024 * 1024
				|| createHash("sha256").update(readFileSync(path)).digest("hex") !== entry.sha256) throw new Error(`Invalid course resource: ${entry.file}`);
			return { path: `resources/${name}/${entry.file}`, title: entry.title, media_type: entry.media_type,
				pages: Number(entry.pages), bytes: stat.size, sha256: entry.sha256 };
		});
	});
}
