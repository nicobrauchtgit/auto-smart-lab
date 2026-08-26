import { getRunEvents, listRuns } from "../../../lib/db";

export const runtime = "nodejs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request) {
	try {
		const params = new URL(request.url).searchParams;
		const runId = params.get("runId");
		const after = Number(params.get("after") ?? -1);
		if (runId && !UUID.test(runId)) {
			return Response.json({ error: "Invalid run ID" }, { status: 400 });
		}
		if (!Number.isInteger(after) || after < -1) {
			return Response.json({ error: "Invalid event cursor" }, { status: 400 });
		}
		return Response.json(runId ? await getRunEvents(runId, after) : await listRuns(), {
			headers: { "Cache-Control": "no-store" },
		});
	} catch (error) {
		console.error("Trace query failed", error);
		return Response.json({ error: "Trace query failed" }, { status: 500 });
	}
}
