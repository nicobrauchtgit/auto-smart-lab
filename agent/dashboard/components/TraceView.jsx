import { useMemo, useState } from "react";

function messageText(message) {
	if (!Array.isArray(message?.content)) return message?.content ?? "";
	return message.content.filter(part => part.type === "text").map(part => part.text).join("");
}

function formatDuration(milliseconds) {
	const total = Math.max(0, Math.round(milliseconds));
	return `${Math.floor(total / 1000)}s ${String(total % 1000).padStart(3, "0")}ms`;
}

function buildTrace(rows) {
	const trace = [];
	let turn;
	for (const row of rows) {
		const event = row.payload;
		const type = row.event_type;
		if (type === "agent_run_start") trace.push({ kind: "run", row, event });
		if (type === "agent_start" || type === "agent_end" || type === "agent_settled" || /retry|compaction|error/.test(type)) {
			trace.push({ kind: "system", row, event });
		}
		if (type === "message_end" && event.message?.role === "user") trace.push({ kind: "user", row, event });
		if (type === "turn_start") {
			turn = { kind: "turn", row, output: "", tools: [], visible: false };
		}
		if (type === "message_start" && event.message?.role === "assistant" && turn && !turn.visible) {
			turn.visible = true;
			trace.push(turn);
		}
		if (type === "message_update" && turn && event.assistantMessageEvent?.type === "text_delta") {
			if (!turn.visible) { turn.visible = true; trace.push(turn); }
			turn.output += event.assistantMessageEvent.delta ?? "";
		}
		if (type === "tool_execution_start" && turn) {
			if (!turn.visible) { turn.visible = true; trace.push(turn); }
			turn.tools.push({ id: event.toolCallId, name: event.toolName, input: event.args });
		}
		if (type === "tool_execution_end" && turn) {
			const tool = turn.tools.find(item => item.id === event.toolCallId);
			if (tool) Object.assign(tool, { output: event.result, error: event.isError });
		}
		if (type === "turn_end" && turn) {
			if (!turn.visible) { turn.visible = true; trace.push(turn); }
			Object.assign(turn, {
				end: row,
				output: messageText(event.message) || turn.output,
				usage: event.message?.usage,
				stopReason: event.message?.stopReason,
			});
		}
	}
	return trace;
}

function Pill({ children, tone = "zinc" }) {
	const tones = { zinc: "bg-zinc-100 text-zinc-600", amber: "bg-amber-50 text-amber-700", red: "bg-red-50 text-red-700" };
	return <span className={`rounded-md px-2 py-1 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

function ToolCall({ tool }) {
	return (
		<div className={`mt-3 rounded-lg border-l-2 p-3 ${tool.error ? "border-red-400 bg-red-50/50" : "border-violet-300 bg-zinc-50"}`}>
			<div className="mb-2 flex items-center gap-2 text-xs font-semibold"><span className="uppercase tracking-wide text-zinc-400">Tool</span>{tool.name}</div>
			<pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs leading-5 text-zinc-700">{JSON.stringify({ input: tool.input, output: tool.output }, null, 2)}</pre>
		</div>
	);
}

function TraceCard({ item }) {
	const [isOpen, setIsOpen] = useState(item.kind === "turn");
	const title = item.kind === "turn" ? "Model turn" : item.kind === "user" ? "User message" : item.row.event_type.replaceAll("_", " ");
	const body = item.kind === "user" ? messageText(item.event.message) : item.event;
	return (
		<details className="group relative rounded-xl border border-zinc-200 bg-white shadow-sm open:shadow-md" open={isOpen} onToggle={event => setIsOpen(event.currentTarget.open)}>
			<span className="absolute -left-[25px] top-4 h-2.5 w-2.5 rounded-full border-2 border-white bg-violet-500 ring-1 ring-violet-300" />
			<summary className="flex list-none items-center gap-3 px-4 py-3 marker:hidden">
				<span className="text-zinc-400 transition group-open:rotate-90">›</span>
				<strong className="text-xs font-semibold uppercase tracking-wide text-zinc-700">{title}</strong>
				<time className="ml-auto text-[11px] text-zinc-400">{new Date((item.end || item.row).observed_at).toLocaleString()}</time>
			</summary>
			<div className="border-t border-zinc-100 px-4 py-4">
				{item.kind === "turn" ? (
					<><pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-zinc-800">{item.output || "Waiting for output…"}</pre>{item.tools.map(tool => <ToolCall key={tool.id} tool={tool} />)}{item.usage && <div className="mt-4 flex flex-wrap gap-2"><Pill tone="amber">stop: {item.stopReason}</Pill><Pill>input: {item.usage.input || 0}</Pill><Pill>output: {item.usage.output || 0}</Pill><Pill>total: {item.usage.totalTokens || 0}</Pill></div>}</>
				) : <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-zinc-700">{typeof body === "string" ? body : JSON.stringify(body, null, 2)}</pre>}
			</div>
		</details>
	);
}

export default function TraceView({ run, events }) {
	const trace = useMemo(() => buildTrace(events), [events]);
	const totalTokens = useMemo(
		() => events.reduce((total, row) => total + (row.event_type === "turn_end" ? row.payload.message?.usage?.totalTokens ?? 0 : 0), 0),
		[events],
	);
	const duration = events.length > 1
		? formatDuration(new Date(events.at(-1).observed_at) - new Date(events[0].observed_at))
		: "0s 000ms";
	return (
		<section className="min-w-0 overflow-y-auto p-6 lg:p-8">
			<div className="mb-6 flex items-start justify-between gap-4">
				<div className="min-w-0"><p className="mb-1 text-xs font-semibold uppercase tracking-wider text-violet-600">Agent run</p><h1 className="truncate text-xl font-semibold text-zinc-950">{run?.model || "Select a run"}</h1><p className="mt-1 truncate font-mono text-[11px] text-zinc-400">{run?.agent_run_id}</p></div>
				<div className="flex flex-wrap justify-end gap-2"><Pill>{events.length} events</Pill><Pill>{totalTokens.toLocaleString()} tokens</Pill><Pill>{duration}</Pill></div>
			</div>
			<div className="ml-2 space-y-3 border-l border-zinc-200 pl-5">{trace.map(item => <TraceCard key={`${item.kind}-${item.row.sequence}`} item={item} />)}{!run && <p className="py-16 text-center text-sm text-zinc-500">Select a run to inspect its trace.</p>}</div>
		</section>
	);
}
