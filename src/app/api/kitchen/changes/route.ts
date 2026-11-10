import type { NextRequest } from "next/server";
import { getBoard, getChanges, isCursor } from "@/lib/kitchen";
import { getTenantContext } from "@/lib/tenant";

const headers = { "cache-control": "no-store" };

/**
 * The kitchen board's poll (spec 07, live updates, proposed): every 5 seconds,
 * the lines of the session's restaurant written since `since`, the cursor the
 * last answer gave. With no `since`, the whole board. Owner and staff (S-26).
 * The restaurant comes from the session, never from the request.
 */
export async function GET(request: NextRequest) {
  const tenant = await getTenantContext();
  const since = request.nextUrl.searchParams.get("since");
  if (since !== null && !isCursor(since)) {
    return Response.json({ error: "That request wasn't valid." }, { status: 400, headers });
  }
  const body = since === null ? await getBoard(tenant) : await getChanges(tenant, since);
  return Response.json(body, { headers });
}
