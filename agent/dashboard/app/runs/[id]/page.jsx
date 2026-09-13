"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import RunTree from "../../../components/RunTree";
import TraceView from "../../../components/TraceView";
import useLiveRuns from "../../../lib/useLiveRuns";
import { buildTree, findNode } from "../../../lib/runTree";

async function fetchJson(url) {
	const response = await fetch(url, { cache: "no-store" });
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || "Request failed");
	return data;
}

export default function RunDetail() {
	const { id: rootId } = useParams();
	const { runs, error, connected } = useLiveRuns();
	const [selectedId, setSelectedId] = useState(rootId);
	const [events, setEvents] = useState([]);
	const [eventsError, setEventsError] = useState("");
	const lastSequence = useRef(-1);

	useEffect(() => setSelectedId(rootId), [rootId]);

	const refreshEvents = useCallback(async (reset = false) => {
		if (!selectedId) return;
		try {
			const after = reset ? -1 : lastSequence.current;
			const nextEvents = await fetchJson(`/api/traces?runId=${encodeURIComponent(selectedId)}&after=${after}`);
			if (reset) setEvents(nextEvents);
			else setEvents(current => {
				const merged = new Map(current.map(event => [event.sequence, event]));
				for (const event of nextEvents) merged.set(event.sequence, event);
				return [...merged.values()].sort((left, right) => left.sequence - right.sequence);
			});
			lastSequence.current = nextEvents.at(-1)?.sequence ?? after;
			setEventsError("");
		} catch (reason) {
			setEventsError(reason.message);
		}
	}, [selectedId]);

	useEffect(() => {
		lastSequence.current = -1;
		setEvents([]);
		refreshEvents(true);
	}, [refreshEvents]);

	useEffect(() => {
		const source = new EventSource("/api/traces/stream");
		let syncTimer;
		let selectedRunChanged = false;
		const scheduleSync = includeSelectedRun => {
			selectedRunChanged ||= includeSelectedRun;
			if (syncTimer) return;
			syncTimer = setTimeout(() => {
				syncTimer = undefined;
				if (selectedRunChanged) refreshEvents();
				selectedRunChanged = false;
			}, 200);
		};
		source.addEventListener("agent_event", event => {
			const notification = JSON.parse(event.data);
			scheduleSync(notification.runId === selectedId);
		});
		return () => { clearTimeout(syncTimer); source.close(); };
	}, [refreshEvents, selectedId]);

	const tree = buildTree(runs);
	const root = findNode(tree, rootId);
	const selectedRun = root && findNode([root], selectedId);

	return (
		<div className="h-screen overflow-hidden bg-zinc-50">
			<header className="flex h-14 items-center justify-between border-b border-zinc-200 bg-white px-5 shadow-sm">
				<div className="flex items-center gap-3">
					<Link className="grid h-8 w-8 place-items-center rounded-lg bg-zinc-950 font-serif text-lg text-white" href="/">π</Link>
					<div>
						<Link className="text-[11px] font-medium text-violet-600 hover:underline" href="/">← All pipeline runs</Link>
						<strong className="block text-sm">{root ? (root.kind === "pipeline" ? `Pipeline · ${root.task_id ?? "task"}` : root.model || "Agent run") : "Loading…"}</strong>
					</div>
				</div>
				<span className={`flex items-center gap-2 text-xs font-medium ${error || eventsError || !connected ? "text-amber-600" : "text-emerald-600"}`}><span className={`h-2 w-2 rounded-full ${error || eventsError || !connected ? "bg-amber-500" : "bg-emerald-500"}`} />{error || eventsError || (connected ? "Live" : "Connecting")}</span>
			</header>
			<main className="grid h-[calc(100vh-3.5rem)] grid-cols-[22rem_minmax(0,1fr)] max-lg:grid-cols-1 max-lg:grid-rows-[auto_minmax(0,1fr)]">
				<aside className="overflow-y-auto border-r border-zinc-200 bg-white p-4 max-lg:max-h-64 max-lg:border-b max-lg:border-r-0">
					<h2 className="mb-3 px-1 text-xs font-semibold uppercase tracking-wider text-zinc-500">Run tree</h2>
					<RunTree root={root} selectedId={selectedId} onSelect={setSelectedId} />
				</aside>
				<TraceView run={selectedRun} events={events} />
			</main>
		</div>
	);
}
