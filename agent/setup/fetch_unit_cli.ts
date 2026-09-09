#!/usr/bin/env bun

import { fetchUnit } from "./fetch_unit.ts";


function usage(): never {
	console.error("Usage: bun agent/setup/fetch_unit_cli.ts <unit> [--refresh-metadata] [--refresh-data] [--secure-tls]");
	console.error("Example: bun agent/setup/fetch_unit_cli.ts 01-spam --refresh-metadata");
	process.exit(1);
}

const args = process.argv.slice(2);
const knownFlags = new Set(["--refresh-metadata", "--refresh-data", "--secure-tls"]);
const unknownFlag = args.find((arg) => arg.startsWith("-") && !knownFlags.has(arg));
if (unknownFlag) {
	console.error(`Unknown option: ${unknownFlag}`);
	usage();
}
const units = args.filter((arg) => !arg.startsWith("-"));
if (units.length !== 1) usage();

const result = await fetchUnit(units[0], {
	insecure: !args.includes("--secure-tls"),
	refreshMetadata: args.includes("--refresh-metadata"),
	refreshData: args.includes("--refresh-data"),
});
console.log(`[fetch_unit] Ready: ${result.unitSlug} (${result.taskPaths.length} tasks)`);
