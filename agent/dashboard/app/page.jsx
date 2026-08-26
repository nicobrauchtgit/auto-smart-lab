"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import RunList from "../components/RunList";
import TraceView from "../components/TraceView";

async function fetchJson(url) {
	const response = await fetch(url, { cache: "no-store" });
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || "Request failed");
	return data;
}

export default function TraceDashboard() {
	const [runs, setRuns] = useState([]);
	const [selectedId, setSelectedId] = useState();
	const [events, setEvents] = useState([]);
	const [error, setError] = useState("");
	const [connected, setConnected] = useState(false);
	const lastSequence = useRef(-1);

	const refreshRuns = useCallback(async () => {
		try {
			const nextRuns = await fetchJson("/api/traces");
			setRuns(nextRuns);
			setSelectedId(current => current ?? nextRuns[0]?.agent_run_id);
			setError("");
		} catch (reason) {
			setError(reason.message);
		}
	}, []);

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
			setError("");
		} catch (reason) {
			setError(reason.message);
		}
	}, [selectedId]);

	useEffect(() => {
		refreshRuns();
	}, [refreshRuns]);

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
				refreshRuns();
				if (selectedRunChanged) refreshEvents();
				selectedRunChanged = false;
			}, 200);
		};
		source.addEventListener("ready", () => {
			setConnected(true);
			refreshRuns();
			refreshEvents();
		});
		source.addEventListener("agent_event", event => {
			const notification = JSON.parse(event.data);
			scheduleSync(notification.runId === selectedId);
		});
		source.onerror = () => setConnected(false);
		return () => { clearTimeout(syncTimer); source.close(); };
	}, [refreshEvents, refreshRuns, selectedId]);

	const selectedRun = runs.find(run => run.agent_run_id === selectedId);
	return (
		<div className="h-screen overflow-hidden bg-zinc-50">
			<header className="flex h-14 items-center justify-between border-b border-zinc-200 bg-white px-5 shadow-sm">
				<div className="flex items-center gap-3"><span className="grid h-8 w-8 place-items-center rounded-lg bg-zinc-950 font-serif text-lg text-white">π</span><div><strong className="block text-sm">Agent traces</strong><span className="block text-[10px] uppercase tracking-wider text-zinc-400">PI observability</span></div></div>
				<span className={`flex items-center gap-2 text-xs font-medium ${error || !connected ? "text-amber-600" : "text-emerald-600"}`}><span className={`h-2 w-2 rounded-full ${error || !connected ? "bg-amber-500" : "bg-emerald-500"}`} />{error || (connected ? "Live" : "Connecting")}</span>
			</header>
			<main className="grid h-[calc(100vh-3.5rem)] grid-cols-[22rem_minmax(0,1fr)] max-lg:grid-cols-1 max-lg:grid-rows-[auto_minmax(0,1fr)]">
				<RunList runs={runs} selectedId={selectedId} onSelect={setSelectedId} />
				<TraceView run={selectedRun} events={events} />
			</main>
		</div>
	);
}
