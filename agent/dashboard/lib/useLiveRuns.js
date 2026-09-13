import { useCallback, useEffect, useState } from "react";

async function fetchJson(url) {
	const response = await fetch(url, { cache: "no-store" });
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || "Request failed");
	return data;
}

// Fetches the full run list and keeps it live via the SSE insert-notification
// stream, so the list/detail pages update without a manual refresh.
export default function useLiveRuns() {
	const [runs, setRuns] = useState([]);
	const [error, setError] = useState("");
	const [connected, setConnected] = useState(false);

	const refreshRuns = useCallback(async () => {
		try {
			setRuns(await fetchJson("/api/traces"));
			setError("");
		} catch (reason) {
			setError(reason.message);
		}
	}, []);

	useEffect(() => {
		refreshRuns();
	}, [refreshRuns]);

	useEffect(() => {
		const source = new EventSource("/api/traces/stream");
		let syncTimer;
		const scheduleSync = () => {
			if (syncTimer) return;
			syncTimer = setTimeout(() => {
				syncTimer = undefined;
				refreshRuns();
			}, 200);
		};
		source.addEventListener("ready", () => {
			setConnected(true);
			refreshRuns();
		});
		source.addEventListener("agent_event", scheduleSync);
		source.onerror = () => setConnected(false);
		return () => { clearTimeout(syncTimer); source.close(); };
	}, [refreshRuns]);

	return { runs, error, connected, refreshRuns };
}
