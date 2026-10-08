/**
 * Download one task's data when a run needs it.
 *
 * `fetch-unit` records each task's download links in its meta.json without
 * downloading anything. A run calls `ensureTaskData` for its own task only:
 * missing files are downloaded, kept as the archives the lab serves (never
 * extracted), and their sizes and hashes are recorded beside the links. Files
 * already present are reused, so storage grows only with the tasks actually run.
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { resolveTask } from "../pipeline/resolve_task.js";
import { LabClient } from "./lab_client.ts";

export interface TaskDataFile {
	name: string;
	url: string;
	bytes?: number;
	sha256?: string;
}

/** The part of the lab client a download needs; tests supply a fake. */
export interface Downloader {
	get(url: string): Promise<{ body: Buffer; headers: Record<string, string | string[] | undefined> }>;
}

export interface TaskDataResult {
	taskId: string;
	downloaded: string[];
	present: string[];
	/** Tasks fetched before links were recorded: their local files are used as they are. */
	legacy: boolean;
}

const ZIP_SIGNATURES = ["504b0304", "504b0506", "504b0708"];

/** A link's file name, as the fetcher records it. Never a path. */
export function dataFileName(url: string): string {
	const name = decodeURIComponent(basename(new URL(url).pathname));
	if (!name || name.startsWith(".") || name !== basename(name)) throw new Error(`Download link has no usable file name: ${url}`);
	return name;
}

async function sha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

export async function ensureTaskData(taskId: string, options: {
	/** Created lazily, so present data never needs lab credentials. */
	downloader?: () => Downloader;
	taskDir?: string;
	record?: (event: string, payload: Record<string, unknown>) => void;
	signal?: AbortSignal;
} = {}): Promise<TaskDataResult> {
	const taskDir = options.taskDir ?? resolveTask({ taskId }).taskDir;
	const metaPath = join(taskDir, "meta.json");
	const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { data_files?: TaskDataFile[] };
	const dataDir = join(taskDir, "data");
	if (!meta.data_files) {
		const local = existsSync(dataDir) ? readdirSync(dataDir).filter(name => statSync(join(dataDir, name)).isFile()) : [];
		if (!local.length) throw new Error(`Task ${taskId} records no download links; fetch its unit metadata again (./dev bun run fetch-unit -- <unit>)`);
		return { taskId, downloaded: [], present: local.sort(), legacy: true };
	}
	mkdirSync(dataDir, { recursive: true });
	let client: Downloader | undefined;
	const downloaded: string[] = [], present: string[] = [];
	for (const file of meta.data_files) {
		options.signal?.throwIfAborted();
		if (file.name !== dataFileName(file.url)) throw new Error(`Recorded data file ${file.name} does not match its link`);
		const path = join(dataDir, file.name);
		if (existsSync(path)) {
			// A recorded hash binds the bytes the lab served; a changed file is never silently reused.
			if (file.sha256 && await sha256(path) !== file.sha256) throw new Error(`Task data ${file.name} differs from its recorded download; remove it to fetch it again`);
			present.push(file.name);
			continue;
		}
		client ??= (options.downloader ?? defaultDownloader)();
		options.record?.("task_data_download_started", { task_id: taskId, file: file.name });
		const response = await client.get(file.url);
		const header = response.headers["content-length"];
		const expected = Number(Array.isArray(header) ? header[0] : header ?? 0);
		if (expected > 0 && response.body.length !== expected) throw new Error(`Incomplete download of ${file.name}: expected ${expected} bytes, got ${response.body.length}`);
		if (file.name.toLowerCase().endsWith(".zip") && !ZIP_SIGNATURES.includes(response.body.subarray(0, 4).toString("hex"))) {
			throw new Error(`Downloaded ${file.name} is not a ZIP archive`);
		}
		const temporary = `${path}.tmp`;
		writeFileSync(temporary, response.body);
		renameSync(temporary, path);
		file.bytes = response.body.length;
		file.sha256 = createHash("sha256").update(response.body).digest("hex");
		downloaded.push(file.name);
		options.record?.("task_data_downloaded", { task_id: taskId, file: file.name, bytes: file.bytes, sha256: file.sha256 });
	}
	if (downloaded.length) writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
	return { taskId, downloaded, present, legacy: false };
}

function defaultDownloader(): Downloader {
	// SmartLab uses a permanently self-signed certificate on its lab/download hosts.
	return new LabClient({ insecure: true });
}
