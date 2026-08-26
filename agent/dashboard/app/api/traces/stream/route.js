import { ensureEventNotifications, EVENT_CHANNEL, sql } from "../../../../lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
	await ensureEventNotifications();
	const encoder = new TextEncoder();
	let controller;
	let closed = false;
	const send = (event, data) => {
		if (!closed) controller?.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
	};
	const listener = await sql.listen(EVENT_CHANNEL, payload => send("agent_event", payload));
	const heartbeat = setInterval(() => send("heartbeat", Date.now()), 15000);
	const close = () => {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		void listener.unlisten();
		try { controller?.close(); } catch {}
	};
	request.signal.addEventListener("abort", close, { once: true });
	const stream = new ReadableStream({
		start(streamController) {
			controller = streamController;
			send("ready", JSON.stringify({ connected: true }));
		},
		cancel: close,
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		},
	});
}
