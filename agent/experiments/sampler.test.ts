import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";

import { cpuPercent, cpuSecondsFromTicks, libproc, sampleGroup } from "./sampler.js";

/** Apple Silicon: 125/3, so 41.666... ns a tick. */
const APPLE_SILICON = 125 / 3;

describe("the mach tick conversion", () => {
	test("a fully pegged core reads near 100%, not 2.4%", () => {
		// One wall second of a pegged core is 1e9 ns of CPU, which is 24,000,000
		// ticks at this timebase. Reading those ticks as nanoseconds is the 41x
		// underread that makes every healthy fit look deadlocked.
		const ticks = 24_000_000;
		const converted = cpuSecondsFromTicks(ticks, APPLE_SILICON);
		const asNanoseconds = cpuSecondsFromTicks(ticks, 1);
		const percent = (seconds: number) => cpuPercent({ at: 0, cpuSeconds: 0 }, { at: 1_000, cpuSeconds: seconds })!;
		expect(percent(converted)).toBeCloseTo(100, 0);
		expect(percent(asNanoseconds)).toBeCloseTo(2.4, 1);
	});

	test("four workers read above 100 rather than saturating there", () => {
		// gridsearch_parallel measured 310%.
		expect(cpuPercent({ at: 0, cpuSeconds: 0 }, { at: 1_000, cpuSeconds: 3.1 })).toBeCloseTo(310, 0);
	});

	test("two readings at the same instant give no rate at all", () => {
		expect(cpuPercent({ at: 5, cpuSeconds: 1 }, { at: 5, cpuSeconds: 2 })).toBeUndefined();
	});
});

describe("libproc", () => {
	test.skipIf(process.platform !== "darwin")("reports this machine's real timebase", () => {
		expect(libproc()?.tickNanoseconds).toBeGreaterThan(0);
	});

	test.skipIf(process.platform !== "darwin")("samples a live process group without shelling out", () => {
		const pgid = Number(execSync(`ps -o pgid= -p ${process.pid}`).toString().trim());
		const sample = sampleGroup(pgid);
		expect(sample?.processes).toBeGreaterThanOrEqual(1);
		expect(sample?.rssBytes).toBeGreaterThan(1024 * 1024);
		expect(sample?.cpuSeconds).toBeGreaterThan(0);
	});

	test("an empty or dead group samples nothing rather than throwing", () => {
		expect(sampleGroup(999_999)).toBeNull();
	});
});
