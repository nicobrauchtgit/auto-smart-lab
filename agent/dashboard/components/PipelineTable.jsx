import Link from "next/link";
import { countDescendants } from "../lib/runTree";

const statusStyles = {
	running: "bg-amber-50 text-amber-700 ring-amber-200",
	settled: "bg-emerald-50 text-emerald-700 ring-emerald-200",
	failed: "bg-red-50 text-red-700 ring-red-200",
};

function Badge({ children, className = "bg-zinc-100 text-zinc-600 ring-zinc-200" }) {
	return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${className}`}>{children}</span>;
}

export default function PipelineTable({ roots }) {
	return (
		<div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
			<table className="w-full min-w-[52rem] border-collapse text-sm">
				<thead>
					<tr className="border-b border-zinc-200 bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
						<th className="px-4 py-3">Run</th>
						<th className="px-4 py-3">Status</th>
						<th className="px-4 py-3">Stage</th>
						<th className="px-4 py-3">Started</th>
						<th className="px-4 py-3">Events</th>
						<th className="px-4 py-3">Sessions</th>
					</tr>
				</thead>
				<tbody>
					{roots.map(run => (
						<tr key={run.agent_run_id} className="border-b border-zinc-100 last:border-0 hover:bg-zinc-50">
							<td className="px-4 py-3">
								<Link className="block" href={`/runs/${run.agent_run_id}`}>
									<strong className="block text-sm font-medium text-zinc-900">
										{run.kind === "pipeline" ? `Pipeline · ${run.task_id ?? "task"}` : run.model || "Agent run"}
									</strong>
									<span className="mt-0.5 block font-mono text-[10px] text-zinc-400">{run.agent_run_id}</span>
								</Link>
							</td>
							<td className="px-4 py-3"><Badge className={statusStyles[run.status]}>{run.status}</Badge></td>
							<td className="px-4 py-3 text-zinc-600">{run.stage ?? "—"}</td>
							<td className="px-4 py-3 text-zinc-600">{new Date(run.started_at).toLocaleString()}</td>
							<td className="px-4 py-3 text-zinc-600">{run.event_count}</td>
							<td className="px-4 py-3 text-zinc-600">{countDescendants(run) || "—"}</td>
						</tr>
					))}
					{roots.length === 0 && (
						<tr><td className="px-4 py-10 text-center text-sm text-zinc-500" colSpan={6}>No runs recorded yet.</td></tr>
					)}
				</tbody>
			</table>
		</div>
	);
}
