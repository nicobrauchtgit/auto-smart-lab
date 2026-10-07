import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { artifact, digest } from "./evidence.js";
import type { StageArtifact, StageReporter } from "../pipeline/types.js";

/** Read only Python source within solutions; retain the exact reviewed bytes. */
export function codeReader(projectRoot: string, directory: string, report: StageReporter) {
 const snapshots = new Map<string, { text: string; sha256: string; artifact: StageArtifact }>();
 return {
  read(path: string, startLine = 1, delivery: "tool" | "initial_prompt" = "tool") {
   if (!Number.isInteger(startLine) || startLine < 1) throw new Error("startLine must be positive");
   const root = realpathSync(join(projectRoot, "solutions"));
   const absolute = realpathSync(resolve(projectRoot, path));
   const within = relative(root, absolute);
   if (!within || within.startsWith('..') || isAbsolute(within) || !absolute.endsWith('.py')) throw new Error("Only Python source under solutions is available");
   let source = snapshots.get(absolute);
   if (!source) {
    if (statSync(absolute).size > 1_000_000) throw new Error("Source file exceeds review size limit");
    const text = readFileSync(absolute, 'utf8');
    const sha256 = digest(text);
    const snapshotPath = join(directory, `source-${sha256}.py`);
    writeFileSync(snapshotPath, text);
    const entry = artifact('evaluation_source', snapshotPath);
    source = { text, sha256, artifact: entry };
    snapshots.set(absolute, source);
    report.input({ kind: 'evaluation_source', version: 1, delivery, status: 'available',
     artifact: snapshotPath, source_path: absolute, content_sha256: sha256 });
   }
   const lines = source.text.split('\n');
   const text = lines.slice(startLine - 1, startLine + 199).map((line, i) => `${startLine + i}: ${line}`).join('\n').slice(0, 24_000);
   return { path, sha256: source.sha256, startLine, totalLines: lines.length, text,
    limitation: 'Source captured at review time; the training harness does not yet bind a frozen source hash to this trial. This cannot prove these exact bytes were fitted.' };
  },
  artifacts: () => [...snapshots.values()].map(s => s.artifact),
 };
}
