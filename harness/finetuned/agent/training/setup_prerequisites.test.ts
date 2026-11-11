import { test, expect } from "bun:test";
import { setupChecks, SetupSession } from "../pipeline/setup.js";
import { loadPromptSnapshot } from "../prompts/loader.js";
test("missing trial-services Python prerequisites prevent execution", async () => {
 const checks = setupChecks(["training"], { taskId: "fixture", prompts: loadPromptSnapshot(), executables: { python: "/missing-trial-python" } });
 const check = checks.find(item => item.id === "training-trial-services")!;
 expect(check).toBeDefined();
 let executed = false;
 await expect((async () => { await new SetupSession().check([check], new AbortController().signal, () => {}); executed = true; })()).rejects.toThrow("joblib");
 expect(executed).toBe(false);
});
