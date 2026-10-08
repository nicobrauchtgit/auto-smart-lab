import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureTaskData, type Downloader } from "./task_data.js";

const ZIP = Buffer.from("504b0304000000", "hex");

function task(dataFiles?: { name: string; url: string }[]) {
	const taskDir = mkdtempSync(join(tmpdir(), "task-data-"));
	writeFileSync(join(taskDir, "meta.json"), JSON.stringify({ short_id: "code1", ...(dataFiles ? { data_files: dataFiles } : {}) }));
	return taskDir;
}

function downloader(bodies: Record<string, Buffer>) {
	const requested: string[] = [];
	const client: Downloader = { async get(url) { requested.push(url); return { body: bodies[url], headers: { "content-length": String(bodies[url].length) } }; } };
	return { requested, create: () => client };
}

test("only missing files of the run's task are downloaded, kept as archives and recorded", async () => {
	const taskDir = task([{ name: "code1-train.zip", url: "https://download.example/code1-train.zip" },
		{ name: "code1-train.labels", url: "https://download.example/code1-train.labels" }]);
	const fake = downloader({ "https://download.example/code1-train.zip": ZIP, "https://download.example/code1-train.labels": Buffer.from("a;f1\n") });
	const events: string[] = [];
	const first = await ensureTaskData("code1", { taskDir, downloader: fake.create, record: event => events.push(event) });
	expect(first).toMatchObject({ downloaded: ["code1-train.zip", "code1-train.labels"], present: [], legacy: false });
	expect(readdirSync(join(taskDir, "data")).sort()).toEqual(["code1-train.labels", "code1-train.zip"]);
	const recorded = JSON.parse(readFileSync(join(taskDir, "meta.json"), "utf8")).data_files;
	expect(recorded[0]).toMatchObject({ bytes: ZIP.length, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
	expect(events).toContain("task_data_downloaded");
	// A second run reuses the files and never contacts the lab.
	const second = await ensureTaskData("code1", { taskDir, downloader: () => { throw new Error("no download expected"); } });
	expect(second).toMatchObject({ downloaded: [], present: ["code1-train.zip", "code1-train.labels"] });
	expect(fake.requested).toHaveLength(2);
});

test("changed local data, non-archive responses and unusable links are refused", async () => {
	const taskDir = task([{ name: "code1-train.zip", url: "https://download.example/code1-train.zip" }]);
	await expect(ensureTaskData("code1", { taskDir, downloader: downloader({ "https://download.example/code1-train.zip": Buffer.from("<html>login</html>") }).create }))
		.rejects.toThrow("not a ZIP archive");
	expect(existsSync(join(taskDir, "data", "code1-train.zip"))).toBe(false);
	await ensureTaskData("code1", { taskDir, downloader: downloader({ "https://download.example/code1-train.zip": ZIP }).create });
	writeFileSync(join(taskDir, "data", "code1-train.zip"), Buffer.concat([ZIP, Buffer.from("x")]));
	await expect(ensureTaskData("code1", { taskDir })).rejects.toThrow("differs from its recorded download");
	const renamed = task([{ name: "other.zip", url: "https://download.example/code1-train.zip" }]);
	await expect(ensureTaskData("code1", { taskDir: renamed })).rejects.toThrow("does not match its link");
});

test("tasks fetched before links were recorded use their local files; without any data they need fresh metadata", async () => {
	const legacy = task();
	mkdirSync(join(legacy, "data"));
	writeFileSync(join(legacy, "data", "spam1-train.zip"), ZIP);
	expect(await ensureTaskData("spam1", { taskDir: legacy })).toMatchObject({ legacy: true, present: ["spam1-train.zip"] });
	await expect(ensureTaskData("code1", { taskDir: task() })).rejects.toThrow("records no download links");
});
