/** Run identity, evidence snapshots and chain budgets for minimal continuation. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
export function chainVersion(projectRoot: string) {
 const commit = spawnSync("git", ["log", "-1", "--format=%H", "--", "harness/minimal"], { cwd: projectRoot, encoding: "utf8" }).stdout.trim();
 const prompt = join(projectRoot, "harness/minimal/agent/instructions/solver.md");
 return { commit, promptHash: createHash("sha256").update(existsSync(prompt) ? readFileSync(prompt) : "").digest("hex") };
}
export function continuedRun(projectRoot: string, path: string): string {
 const root = resolve(projectRoot, path), parent = resolve(projectRoot, "runs/minimal");
 if (dirname(root) !== parent || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory() || dirname(realpathSync(root)) !== realpathSync(parent)) throw new Error("--continue requires a real direct runs/minimal child; symlinks refused");
 if (JSON.stringify(JSON.parse(readFileSync(join(root, "chain-version.json"), "utf8"))) !== JSON.stringify(chainVersion(projectRoot))) throw new Error("Continuation harness commit or solver prompt hash differs");
 return root;
}
export function snapshotRun(root: string): string {
 const destination = join(dirname(root), `${root.split("/").at(-1)}-snapshot-${Date.now()}`);
 cpSync(root, destination, { recursive: true, filter: path => !["node_modules", ".venv"].includes(path.split("/").at(-1)!) });
 const python = join(root, ".venv/bin/python");
 const result = spawnSync(python, ["-m", "pip", "freeze"], { encoding: "utf8" });
 writeFileSync(join(destination, "venv-packages.txt"), result.stdout ?? "");
 if (result.status !== 0) throw new Error(`Snapshot saved at ${destination}, but venv package listing failed`);
 return destination;
}
export function invocationArgs(root: string, original: readonly string[]): string[] {
 const args = [...original], file = join(root, "chain-budget.json");
 const index = args.indexOf("--max-cost"), requested = index < 0 ? undefined : Number(args[index + 1]);
 const previous = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as { cap: number } : undefined;
 if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) throw new Error("Invalid --max-cost");
 if (previous && requested !== undefined && requested !== previous.cap) throw new Error("Chain --max-cost must remain unchanged");
 const cap = previous?.cap ?? requested;
 let spent = 0;
 const logs = join(root, "logs/solve-units");
 if (cap !== undefined && existsSync(logs)) for (const name of readdirSync(logs)) {
  const summary = join(logs, name, "summary.json");
  if (existsSync(summary)) { const value = JSON.parse(readFileSync(summary, "utf8")).spentUsd; if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid recorded spend"); spent += value; }
 }
 if (cap !== undefined) {
  if (spent >= cap) throw new Error("Chain cost budget exhausted");
  writeFileSync(file, JSON.stringify({ cap }));
  if (index >= 0) args.splice(index, 2);
  args.push("--max-cost", String(cap - spent));
 }
 appendFileSync(join(root, "chain.jsonl"), JSON.stringify({ time: new Date().toISOString(), args, version: JSON.parse(readFileSync(join(root, "chain-version.json"), "utf8")), spent, cap }) + "\n");
 return args;
}
