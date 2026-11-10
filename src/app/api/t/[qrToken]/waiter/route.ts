import { callWaiter } from "@/lib/ordering";

/**
 * "Call a waiter" (spec 06, step 4, proposed), from the table page's script. Like
 * the scan, the page itself is cached, so the write lives here, uncached, and the
 * token is the only input: the body, query and headers are never read.
 */
export async function POST(_request: Request, { params }: RouteContext<"/api/t/[qrToken]/waiter">) {
  const called = await callWaiter((await params).qrToken);
  const headers = { "cache-control": "no-store" };
  if (!called) return Response.json({ error: "This code is out of date." }, { status: 404, headers });
  return Response.json(
    { session: called.sessionId, requestedAt: called.requestedAt.toISOString() },
    { headers },
  );
}
