import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { parseWalkIn, seatWalkIn } from "@/lib/walk-in";
import { walkInResponse } from "@/lib/walk-in-responses";

/**
 * Seat walk-in, from the day view at /dashboard/bookings. Owners and staff both
 * (S-26). The restaurant comes from the session; the table is looked up inside it,
 * so a table of another restaurant is a 404.
 */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  const { party, tableId } = parseWalkIn(await request.formData().catch(() => new FormData()));
  if (!tableId.success) notFound();
  if (!party.success) {
    return Response.json({ error: party.error.issues[0].message }, { status: 400 });
  }

  return walkInResponse(await seatWalkIn(tenant, tableId.data, party.data), request);
}
