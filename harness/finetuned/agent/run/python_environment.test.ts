import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPromptSnapshot } from "../prompts/loader.js";
import {
	preparePythonEnvironment, pythonChangeCursor, readPythonChanges,
	recordPythonEnvironmentEnd, validatePythonEnvironment, type PythonEnvironment,
} from "./python_environment.js";

function inventory(overrides: Partial<PythonEnvironment> = {}): PythonEnvironment {
	return {
		schema_version: 1, python_version: "3.13.5", executable: "/project/.venv/bin/python",
		prefix: "/project/.venv", packages: [{ name: "demo", version: "2.0" }],
		declared_dependencies: ["demo>=1,<3", "optional; python_version < '3'"],
		project_sha256: "a".repeat(64), lock_sha256: "b".repeat(64), fingerprint: "c".repeat(64),
		healthy: true, lock_current: true, environment_matches_lock: true, dependency_errors: "",
		...overrides,
	};
}

test("inventory validation rejects malformed or contradictory health signals", () => {
	assert.deepEqual(validatePythonEnvironment(inventory()), inventory());
	for (const overrides of [
		{ lock_current: undefined }, { environment_matches_lock: "true" },
		{ healthy: true, lock_current: false }, { healthy: false },
		{ declared_dependencies: [123] }, { dependency_errors: null },
		{ project_sha256: "invalid" }, { lock_sha256: null }, { packages: [null] },
	]) {
		assert.throws(() => validatePythonEnvironment({ ...inventory(), ...overrides }), /Invalid Python/);
	}
});

test("startup rejects each kind of drift while final observation retains unhealthy inventories", () => {
	for (const overrides of [{ lock_current: false }, { environment_matches_lock: false }]) {
		const drift = inventory({ ...overrides, healthy: false, dependency_errors: "uv check failed" });
		assert.throws(() => validatePythonEnvironment(drift), /not ready.*uv/s);
		assert.deepEqual(validatePythonEnvironment(drift, false), drift);
	}
	assert.equal(validatePythonEnvironment(inventory({
		healthy: false, lock_current: false, environment_matches_lock: false, lock_sha256: null,
	}), false).lock_sha256, null);
});

test("runtime prompt supplies declared constraints, file identity, and compatible update guidance", () => {
	const prepared = preparePythonEnvironment(loadPromptSnapshot(), inventory());
	assert.match(prepared.prompt.text, /demo>=1,<3/);
	assert.doesNotMatch(prepared.prompt.text, /demo==2.0/);
	assert.match(prepared.prompt.text, /update PACKAGE --reason/);
	assert.match(prepared.prompt.text, /Installation failures can leave partial changes/);
	assert.match(prepared.prompt.text, /Do not copy package inventories/);
	assert.equal(prepared.prompt.reference.id, "shared.python-environment");
	assert.deepEqual(prepared.input.declared_dependencies, inventory().declared_dependencies);
	assert.equal(prepared.input.project_sha256, inventory().project_sha256);
	assert.equal(prepared.input.lock_sha256, inventory().lock_sha256);
	assert.equal(prepared.env.VENV_DIR, inventory().prefix);
	assert.equal(prepared.env.UV_PROJECT_ENVIRONMENT, inventory().prefix);
	assert.equal(prepared.env.UV_PYTHON, inventory().executable);
	assert.equal(prepared.env.UV_PYTHON_DOWNLOADS, "never");
});

test("change cursors use bytes and preserve history from prior runs", () => {
	const root = mkdtempSync(join(tmpdir(), "python-changes-"));
	const path = join(root, "changes.jsonl");
	try {
		assert.equal(pythonChangeCursor(path), 0);
		assert.deepEqual(readPythonChanges(0, path), []);
		const previous = JSON.stringify({ schema_version: 1, action: "add", reason: "Earlier résumé analysis", outcome: "success" }) + "\n";
		writeFileSync(path, previous);
		const cursor = pythonChangeCursor(path);
		assert.equal(cursor, Buffer.byteLength(previous));
		const next = { schema_version: 1, action: "update", reason: "Compatible fix", outcome: "started", operation_id: "operation-1" };
		appendFileSync(path, JSON.stringify(next) + "\n");
		assert.deepEqual(readPythonChanges(cursor, path), [next]);
		writeFileSync(path, "");
		assert.throws(() => readPythonChanges(cursor, path), /truncated/);
		writeFileSync(path, "{broken\n");
		assert.throws(() => readPythonChanges(0, path));
		writeFileSync(path, '{}\n');
		assert.throws(() => readPythonChanges(0, path), /Invalid Python dependency/);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test("session observation records reasons and distinguishes changes requested by another run", () => {
	const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
	const changes = [
		{ schema_version: 1, session_id: "this-session", pipeline_run_id: "run-1", action: "update", reason: "Need a fix", outcome: "success" },
		{ schema_version: 1, session_id: "another-session", pipeline_run_id: "run-2", action: "add", reason: "Need a library", outcome: "failure" },
	];
	recordPythonEnvironmentEnd({
		initial: inventory(), cursor: 12, sessionId: "this-session",
		record: (type, payload) => events.push({ type, payload }),
	}, {
		readEnvironment: requireHealthy => {
			assert.equal(requireHealthy, false);
			return inventory({ healthy: false, environment_matches_lock: false, fingerprint: "d".repeat(64) });
		},
		readChanges: cursor => { assert.equal(cursor, 12); return changes; },
	});
	assert.equal(events[0].type, "runtime_environment_end");
	assert.equal(events[0].payload.changed, true);
	assert.equal(events[0].payload.healthy, false);
	assert.deepEqual(events[1].payload.change, changes[0]);
	assert.equal(events[1].payload.requested_by_session, true);
	assert.deepEqual(events[2].payload.change, changes[1]);
	assert.equal(events[2].payload.requested_by_session, false);
});

test("declaration-only changes remain visible when the installed inventory stays the same", () => {
	const events: Record<string, unknown>[] = [];
	recordPythonEnvironmentEnd({ initial: inventory(), cursor: 0, sessionId: "s", record: (_, payload) => events.push(payload) }, {
		readEnvironment: () => inventory({ project_sha256: "d".repeat(64), declared_dependencies: ["demo>=2,<3"] }),
		readChanges: () => [],
	});
	assert.equal(events[0].changed, false);
	assert.equal(events[0].project_changed, true);
});

test("audit and environment inspection failures are independently observable", () => {
	for (const failAudit of [true, false]) {
		const events: Record<string, unknown>[] = [];
		recordPythonEnvironmentEnd({ initial: inventory(), cursor: 0, sessionId: "s", record: (_, payload) => events.push(payload) }, {
			readEnvironment: () => { throw new Error("Python disappeared"); },
			readChanges: () => {
				if (failAudit) throw new Error("History truncated");
				return [{ reason: "Requested before interruption", outcome: "started", session_id: "s" }];
			},
		});
		assert.equal(events[0].status, "unavailable");
		assert.equal(events[0].message, "Python disappeared");
		assert.equal(events[1].type, "runtime_dependency_change");
		if (failAudit) assert.equal(events[1].message, "History truncated");
		else assert.deepEqual(events[1].change, { reason: "Requested before interruption", outcome: "started", session_id: "s" });
	}
});
