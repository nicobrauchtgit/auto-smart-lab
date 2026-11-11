/** A stage artifact with the content hash and size of the file at `path`. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { StageArtifact } from "./types.js";

export function artifact(kind: string, path: string): StageArtifact {
	const bytes = readFileSync(path);
	return { kind, path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
}
