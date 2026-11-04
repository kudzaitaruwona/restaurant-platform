import type { NextRequest } from "next/server";
import { addStaffBooking, parseStaffRequest } from "@/lib/booking-staff";
import { addBookingResponse } from "@/lib/booking-staff-responses";
import { getTenantContext } from "@/lib/tenant";

/**
 * Add booking, from /dashboard/bookings/new. Owners and staff both (S-26). The
 * restaurant comes from the session; a table id from another restaurant is a 404.
 * The overrides are the engine's staff rules and apply here only: the guest's
 * route has no way to reach them.
 */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  const parsed = parseStaffRequest(await request.formData().catch(() => new FormData()));
  if (!parsed.success) return Response.json({ error: parsed.message }, { status: 400 });

  return addBookingResponse(await addStaffBooking(tenant, parsed.data), request);
}
