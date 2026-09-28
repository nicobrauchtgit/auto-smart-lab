/**
 * Describe the Python runtime the agent's shell commands will actually use, as a plain fact for the
 * solver's first message. Detected, not hard-coded, because hosts differ: the lab's student VM has a
 * venv with the usual scientific stack, a bare dev machine may have only the standard library.
 *
 * No curation or advice: every installed distribution is listed by name, in alphabetical order.
 */

import { spawnSync } from "node:child_process";

export interface PythonRuntime {
	executable: string;
	version: string;
	inVirtualenv: boolean;
	pipAvailable: boolean;
	packages: string[]; // distribution names, sorted, pip/setuptools/wheel excluded
}

const PROBE = `
import importlib.metadata as md, importlib.util as iu, json, sys
names = sorted({(d.metadata["Name"] or "").strip() for d in md.distributions()} - {"", "pip", "setuptools", "wheel"}, key=str.lower)
print(json.dumps({
    "executable": sys.executable,
    "version": "%d.%d.%d" % sys.version_info[:3],
    "inVirtualenv": sys.prefix != sys.base_prefix,
    "pipAvailable": iu.find_spec("pip") is not None,
    "packages": names,
}))
`;

let cached: PythonRuntime | null | undefined;

export function detectPythonRuntime(): PythonRuntime | null {
	if (cached !== undefined) return cached;
	const r = spawnSync("python3", ["-c", PROBE], { encoding: "utf8", timeout: 30_000 });
	try {
		cached = r.status === 0 ? (JSON.parse(r.stdout.trim()) as PythonRuntime) : null;
	} catch {
		cached = null;
	}
	return cached;
}

/** One paragraph for the solver's first message. */
export function describePythonRuntime(): string {
	const rt = detectPythonRuntime();
	if (!rt) return " Python runtime: `python3` could not be probed on this host.";
	const pkgs = rt.packages.length ? `${rt.packages.length} third-party distributions installed: ${rt.packages.join(", ")}` : "no third-party packages installed (standard library only)";
	const pip = rt.inVirtualenv && rt.pipAvailable
		? "It is a virtualenv; installing more packages with `python3 -m pip install` is allowed."
		: "It is not a virtualenv; do not install packages into it.";
	return ` Python runtime for your commands: \`python3\` = ${rt.executable} (Python ${rt.version}). ${pip} ${pkgs}.`;
}
