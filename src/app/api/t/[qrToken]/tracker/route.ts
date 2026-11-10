import { getTableTracker } from "@/lib/ordering";

/**
 * The order tracker's feed (spec 06, step 3), polled by the table page's script
 * every 5 seconds *(proposed)*. The menu at /t/{qrToken} is cached and the same
 * for everyone; this is what changes, so it is never cached. The token is the
 * only input: the query and headers are never read, and the session the page
 * holds isn't asked for, so there is no way to name another one. A read.
 */
export async function GET(_request: Request, { params }: RouteContext<"/api/t/[qrToken]/tracker">) {
  const tracker = await getTableTracker((await params).qrToken);
  const headers = { "cache-control": "no-store" };
  if (!tracker) return Response.json({ error: "This code is out of date." }, { status: 404, headers });
  return Response.json(tracker, { headers });
}
