import { expect, test } from "bun:test";

import { sessionToolAllowlist } from "./session_runner.js";

test("a scoped session exposes its custom tools alongside its allowed built-ins", () => {
	expect(sessionToolAllowlist(["read", "bash"], [
		{ name: "experiment_start" }, { name: "experiment_status" },
	])).toEqual(["read", "bash", "experiment_start", "experiment_status"]);
	expect(sessionToolAllowlist([], [{ name: "experiment_start" }])).toEqual(["experiment_start"]);
	expect(sessionToolAllowlist(undefined, [{ name: "experiment_start" }])).toBeUndefined();
});
