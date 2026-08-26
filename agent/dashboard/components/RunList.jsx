const statusStyles = {
	running: "bg-amber-50 text-amber-700 ring-amber-200",
	settled: "bg-emerald-50 text-emerald-700 ring-emerald-200",
	failed: "bg-red-50 text-red-700 ring-red-200",
};

function Badge({ children, className = "bg-zinc-100 text-zinc-600 ring-zinc-200" }) {
	return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${className}`}>{children}</span>;
}

export default function RunList({ runs, selectedId, onSelect }) {
	return (
		<aside className="overflow-y-auto border-r border-zinc-200 bg-white p-4 max-lg:max-h-64 max-lg:border-b max-lg:border-r-0">
			<div className="mb-3 flex items-center justify-between px-1">
				<h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Runs</h2>
				<span className="text-xs text-zinc-400">{runs.length}</span>
			</div>
			<div className="space-y-2">
				{runs.map(run => (
					<button
						className={`w-full rounded-xl border p-3 text-left transition ${run.agent_run_id === selectedId ? "border-violet-400 bg-violet-50/60 shadow-sm" : "border-zinc-200 bg-white hover:border-zinc-300 hover:bg-zinc-50"}`}
						key={run.agent_run_id}
						onClick={() => onSelect(run.agent_run_id)}
					>
						<strong className="block truncate text-sm font-medium text-zinc-900">{run.model || "Agent run"}</strong>
						<span className="mt-1 block truncate font-mono text-[10px] text-zinc-400">{run.agent_run_id}</span>
						<span className="mt-1 block text-[11px] text-zinc-500">{new Date(run.started_at).toLocaleString()}</span>
						<span className="mt-2 flex flex-wrap gap-1.5">
							<Badge className={statusStyles[run.status]}>{run.status}</Badge>
							<Badge>{run.event_count} events</Badge>
							{run.step_type && <Badge>{run.step_type}</Badge>}
						</span>
					</button>
				))}
				{runs.length === 0 && <p className="rounded-xl border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500">No runs recorded yet.</p>}
			</div>
		</aside>
	);
}
