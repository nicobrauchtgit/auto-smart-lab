import { useState } from "react";

const statusStyles = {
	running: "bg-amber-50 text-amber-700 ring-amber-200",
	settled: "bg-emerald-50 text-emerald-700 ring-emerald-200",
	failed: "bg-red-50 text-red-700 ring-red-200",
};

function Badge({ children, className = "bg-zinc-100 text-zinc-600 ring-zinc-200" }) {
	return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${className}`}>{children}</span>;
}

function RunNode({ run, depth, selectedId, onSelect, collapsed, onToggle }) {
	const isCollapsed = collapsed.has(run.agent_run_id);
	const hasChildren = run.children.length > 0;
	return (
		<div>
			<div
				className={`flex w-full items-stretch gap-1 rounded-xl border text-left transition ${run.agent_run_id === selectedId ? "border-violet-400 bg-violet-50/60 shadow-sm" : "border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50"}`}
				style={{ marginLeft: depth * 14 }}
			>
				{hasChildren ? (
					<button
						aria-label={isCollapsed ? "Expand" : "Collapse"}
						className="w-7 shrink-0 text-xs text-zinc-400 hover:text-zinc-700"
						onClick={() => onToggle(run.agent_run_id)}
					>
						{isCollapsed ? "›" : "⌄"}
					</button>
				) : <span className="w-7 shrink-0" />}
				<button className="min-w-0 flex-1 p-3 text-left" onClick={() => onSelect(run.agent_run_id)}>
					<strong className="block truncate text-sm font-medium text-zinc-900">
						{run.kind === "pipeline" ? `Pipeline · ${run.task_id ?? "task"}` : run.model || "Agent run"}
					</strong>
					<span className="mt-1 block truncate font-mono text-[10px] text-zinc-400">{run.agent_run_id}</span>
					<span className="mt-2 flex flex-wrap gap-1.5">
						<Badge className={statusStyles[run.status]}>{run.status}</Badge>
						<Badge>{run.event_count} events</Badge>
						{run.stage && <Badge>{run.stage}</Badge>}
						{run.attempt != null && <Badge>attempt {run.attempt}</Badge>}
						{run.parent_agent_run_id && <Badge className="bg-violet-50 text-violet-600 ring-violet-200">subagent</Badge>}
					</span>
				</button>
			</div>
			{hasChildren && !isCollapsed && (
				<div className="mt-2 space-y-2">
					{run.children.map(child => (
						<RunNode key={child.agent_run_id} run={child} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} collapsed={collapsed} onToggle={onToggle} />
					))}
				</div>
			)}
		</div>
	);
}

export default function RunTree({ root, selectedId, onSelect }) {
	const [collapsed, setCollapsed] = useState(() => new Set());
	const toggle = id => setCollapsed(current => {
		const next = new Set(current);
		if (next.has(id)) next.delete(id); else next.add(id);
		return next;
	});
	if (!root) return <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500">Run not found.</p>;
	return (
		<div className="space-y-2">
			<RunNode run={root} depth={0} selectedId={selectedId} onSelect={onSelect} collapsed={collapsed} onToggle={toggle} />
		</div>
	);
}
