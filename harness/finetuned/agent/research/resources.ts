import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../paths.js";
import type { StageReporter } from "../pipeline/types.js";

export interface CourseResource {
	title: string;
	path: string;
	media_type: "application/pdf" | "text/plain";
	pages: number;
	bytes: number;
	sha256: string;
}
export interface CourseResourceInput { source: string; resource: CourseResource }

/** Optional per-unit course material. An existing directory must have a valid manifest. */
export function readCourseResources(unit: string, root = join(REPO_ROOT, "resources")): CourseResourceInput[] {
	if (!/^[\w-]+$/.test(unit)) throw new Error("Invalid course resource unit");
	const directory = join(root, unit);
	if (!existsSync(directory)) return [];
	if (!lstatSync(directory).isDirectory()) throw new Error("Course resources must be a directory, not a symlink");
	const manifestPath = join(directory, "manifest.json");
	if (!lstatSync(manifestPath).isFile() || lstatSync(manifestPath).size > 64 * 1024) throw new Error("Invalid course resource manifest");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 32) throw new Error("Invalid course resource manifest");
	const seen = new Set<string>();
	return manifest.files.map((entry: Record<string, unknown>) => {
		if (!entry || typeof entry.file !== "string" || !/^[\w-]+\.(pdf|txt)$/.test(entry.file)
			|| seen.has(entry.file) || typeof entry.title !== "string" || !entry.title.trim()
			|| !Number.isSafeInteger(entry.pages) || (entry.pages as number) < 1
			|| typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)
			|| entry.media_type !== (entry.file.endsWith(".pdf") ? "application/pdf" : "text/plain")) throw new Error("Invalid course resource entry");
		seen.add(entry.file);
		const source = join(directory, entry.file);
		const stat = lstatSync(source);
		if (!stat.isFile() || stat.size === 0 || stat.size > 32 * 1024 * 1024) throw new Error(`Invalid course resource: ${entry.file}`);
		const sha256 = createHash("sha256").update(readFileSync(source)).digest("hex");
		if (sha256 !== entry.sha256) throw new Error(`Course resource checksum mismatch: ${entry.file}`);
		return { source, resource: { title: entry.title, path: `resources/${entry.file}`, media_type: entry.media_type,
			pages: entry.pages as number, bytes: stat.size, sha256 } };
	});
}

/** Snapshot the supplied files before a session; the sandbox mounts this directory read-only. */
export function stageCourseResources(workspace: string, inputs: CourseResourceInput[]): void {
	const directory = join(workspace, "resources");
	rmSync(directory, { recursive: true, force: true });
	if (!inputs.length) return;
	mkdirSync(directory, { recursive: true });
	for (const { source, resource } of inputs) {
		const destination = resolve(workspace, resource.path);
		copyFileSync(source, destination);
		if (createHash("sha256").update(readFileSync(destination)).digest("hex") !== resource.sha256) throw new Error("Course resource changed while staging");
	}
}

export function reportCourseResources(report: Pick<StageReporter, "input"> | undefined, workspace: string, resources: CourseResource[]): void {
	for (const resource of resources) report?.input({ kind: "course_resource", version: 1, delivery: "workspace_file", status: "available",
		artifact: resolve(workspace, resource.path), content_sha256: resource.sha256, bytes: resource.bytes,
		title: resource.title, media_type: resource.media_type, pages: resource.pages });
}
