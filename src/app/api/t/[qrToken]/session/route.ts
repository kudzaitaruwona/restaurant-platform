import { joinTableSession } from "@/lib/ordering";

/**
 * A scan of a table's QR code (spec 06), from the table page's script. The menu
 * at /t/{qrToken} is cached and the proxy keeps everything but GET and HEAD off
 * it (S-32), so the page's writes live here, uncached. The token is the only
 * input: the body, query and headers are never read.
 */
export async function POST(_request: Request, { params }: RouteContext<"/api/t/[qrToken]/session">) {
  const joined = await joinTableSession((await params).qrToken);
  const headers = { "cache-control": "no-store" };
  if (!joined) return Response.json({ error: "This code is out of date." }, { status: 404, headers });
  return Response.json({ session: joined.sessionId }, { headers });
}
