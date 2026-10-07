/** Local acceptance service; killed by the test to model an abrupt restart. */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarnessTraining } from "../index.js";
import { loadPromptSnapshot } from "../../prompts/loader.js";
const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
const training = createHarnessTraining({ ...config.options, prompts: loadPromptSnapshot() });
await training.ready();
const started = await training.service.start(config.request);
writeFileSync(join(config.options.root, "fixture-start.json"), JSON.stringify({ id: started.id, directory: started.directory }));
setInterval(() => {}, 1000);
