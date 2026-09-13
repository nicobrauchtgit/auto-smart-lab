"use client";

import PipelineTable from "../components/PipelineTable";
import useLiveRuns from "../lib/useLiveRuns";
import { buildTree } from "../lib/runTree";

export default function PipelineList() {
	const { runs, error, connected } = useLiveRuns();
	const roots = buildTree(runs);
	return (
		<div className="min-h-screen bg-zinc-50">
			<header className="flex h-14 items-center justify-between border-b border-zinc-200 bg-white px-5 shadow-sm">
				<div className="flex items-center gap-3"><span className="grid h-8 w-8 place-items-center rounded-lg bg-zinc-950 font-serif text-lg text-white">π</span><div><strong className="block text-sm">Agent traces</strong><span className="block text-[10px] uppercase tracking-wider text-zinc-400">PI observability</span></div></div>
				<span className={`flex items-center gap-2 text-xs font-medium ${error || !connected ? "text-amber-600" : "text-emerald-600"}`}><span className={`h-2 w-2 rounded-full ${error || !connected ? "bg-amber-500" : "bg-emerald-500"}`} />{error || (connected ? "Live" : "Connecting")}</span>
			</header>
			<main className="mx-auto max-w-6xl p-6 lg:p-8">
				<div className="mb-4 flex items-center justify-between">
					<h1 className="text-lg font-semibold text-zinc-950">Pipeline runs</h1>
					<span className="text-xs text-zinc-400">{roots.length} runs</span>
				</div>
				<PipelineTable roots={roots} />
			</main>
		</div>
	);
}
