import assert from "node:assert/strict";
import { test } from "node:test";
import { assessSmokeContext, type SmokeEvent } from "./smoke_validation.js";

const marker = "CHILD_BASH_ONLY_SMOKE_MARKER";
function fixture(output = `Implemented metrics.py; tests passed. ${marker}`): SmokeEvent[] {
	return [
		{ agent_run_id: "parent", event_type: "message_end", payload: {
			message: { role: "toolResult", toolCallId: "parent-read", content: [{ type: "text", text: `TASK.md: print ${marker}` }] } } },
		{ agent_run_id: "child", event_type: "tool_execution_end", payload: {
			toolName: "bash", toolCallId: "child-bash", result: { content: [{ type: "text", text: marker }] } } },
		{ agent_run_id: "child", event_type: "message_end", payload: {
			message: { role: "assistant", content: [{ type: "text", text: output }] } } },
		{ agent_run_id: "parent", event_type: "tool_execution_end", payload: {
			toolName: "subagent_wait", toolCallId: "parent-wait", result: { content: [{ type: "text", text: JSON.stringify({
				parentAgentRunId: "parent", agentRunId: "child", status: "idle", output, truncated: false,
			}) }] } } },
	];
}

test("task marker and a deliberately repeated reply do not imply transcript forwarding", () => {
	const result = assessSmokeContext(fixture(), "parent", "child");
	assert.ok(Object.values(result.checks).every(Boolean));
	assert.equal(result.replyQuality.markerInParentMessages, true);
	assert.equal(result.replyQuality.replies[0].markerRepeated, true);
});

test("forwarded child tool events or tool messages fail the transport check", () => {
	for (const forwarded of [fixture()[1], { agent_run_id: "child", event_type: "message_end",
		payload: { message: { role: "toolResult", toolCallId: "child-bash" } } }]) {
		const events = [...fixture(), { ...forwarded, agent_run_id: "parent" }];
		assert.equal(assessSmokeContext(events, "parent", "child").checks.childToolEventsStayInChild, false);
	}
});

test("wait rejects added transcript fields, malformed JSON, and output beyond the final reply", () => {
	for (const text of ["{", JSON.stringify({ parentAgentRunId: "parent", agentRunId: "child", status: "idle",
		output: "Done", truncated: false, transcript: [marker] }), JSON.stringify({
		parentAgentRunId: "parent", agentRunId: "child", status: "idle", output: `Done\n${marker}`, truncated: false })]) {
		const events = fixture("Done");
		events[3].payload.result!.content![0].text = text;
		assert.equal(assessSmokeContext(events, "parent", "child").checks.waitReturnsBoundedFinalReply, false);
	}
});

test("wait verifies the UTF-8 byte bound and truncation flag", () => {
	const events = fixture("ééé");
	events[3].payload.result!.content![0].text = JSON.stringify({ parentAgentRunId: "parent", agentRunId: "child",
		status: "idle", output: "éé", truncated: true });
	const result = assessSmokeContext(events, "parent", "child", 5);
	assert.equal(result.checks.waitReturnsBoundedFinalReply, true);
	assert.equal(result.replyQuality.replies[0].bytes, 4);
	assert.equal(assessSmokeContext(fixture("ééé"), "parent", "child", 5).checks.waitReturnsBoundedFinalReply, false);
});

test("reply extraction matches Pi text blocks and trims outer whitespace", () => {
	const events = fixture("Done checking.");
	events[2].payload.message!.content = [
		{ type: "text", text: "  Done" }, { type: "thinking", text: "private reasoning" },
		{ type: "text", text: " checking.\n" },
	];
	assert.equal(assessSmokeContext(events, "parent", "child").checks.waitReturnsBoundedFinalReply, true);
});

test("missing identities, tool evidence, or a completed wait cannot pass", () => {
	assert.equal(assessSmokeContext(fixture()).checks.childToolEventsStayInChild, false);
	assert.equal(assessSmokeContext([], "parent", "child").checks.childToolEventsStayInChild, false);
	assert.equal(assessSmokeContext([], "parent", "child").checks.waitReturnsBoundedFinalReply, false);
	const events = fixture();
	events[3].payload.result!.content![0].text = JSON.stringify({ parentAgentRunId: "parent", status: "running" });
	assert.equal(assessSmokeContext(events, "parent", "child").checks.waitReturnsBoundedFinalReply, false);
});
