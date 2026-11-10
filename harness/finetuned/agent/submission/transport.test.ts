import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTaskPage } from "./transport.js";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", `${name}-attempts.html`), "utf8");

test("official spam1 page: scored FAILURE rows do not consume attempts", () => {
 const status = parseTaskPage("https://example.test/task/", fixture("spam1"));
 expect(status).toMatchObject({ triesUsed: 0, triesRemaining: 3 });
 expect(status.attempts).toEqual([
  { id: "2", comment: "fixture-comment", state: "rejected", score: null },
  { id: "1", comment: "fixture-comment", state: "rejected", score: null },
 ]);
});

test("official task 4.1 page: SUCCESS with score zero consumes one attempt; failures do not", () => {
 const status = parseTaskPage("https://example.test/task/", fixture("network"));
 expect(status).toMatchObject({ triesUsed: 1, triesRemaining: 2 });
 expect(status.attempts).toEqual([
  { id: "3", comment: "fixture-comment", state: "rejected", score: null },
  { id: "2", comment: "fixture-comment", state: "rejected", score: null },
  { id: "1", comment: "fixture-comment", state: "scored", score: 0 },
 ]);
});
