/** Test-only controller used to exercise loss of service ownership. */
import { readFileSync } from "node:fs";
import { runRefit } from "./service.js";
await runRefit(JSON.parse(readFileSync(process.argv[2], "utf8")));
