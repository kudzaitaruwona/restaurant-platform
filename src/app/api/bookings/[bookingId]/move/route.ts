import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { bookingIdFrom } from "@/lib/booking-day";
import { moveBooking } from "@/lib/booking-staff";
import { moveBookingResponse } from "@/lib/booking-staff-responses";
import { getTenantContext } from "@/lib/tenant";
import { z } from "zod";

/**
 * Move table, from the day view at /dashboard/bookings. Owners and staff both
 * (S-26). The restaurant comes from the session, the booking from the URL and the
 * table from the form: either of another restaurant is a 404. The guest isn't told.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/bookings/[bookingId]/move">,
) {
  const tenant = await getTenantContext();
  const bookingId = await bookingIdFrom(context.params);
  const form = await request.formData().catch(() => new FormData());
  const chosen = form.get("tableId");
  if (typeof chosen !== "string" || chosen === "") {
    return Response.json({ error: "Choose a table to move the booking to." }, { status: 400 });
  }
  // Not a table id at all: the same answer as a table that isn't this restaurant's.
  const tableId = z.uuid().safeParse(chosen);
  if (!tableId.success) notFound();

  return moveBookingResponse(await moveBooking(tenant, bookingId, tableId.data), request);
}
