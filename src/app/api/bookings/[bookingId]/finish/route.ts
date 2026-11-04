import type { NextRequest } from "next/server";
import { finishBooking, bookingIdFrom } from "@/lib/booking-day";
import { bookingActionResponse } from "@/lib/booking-day-responses";
import { getTenantContext } from "@/lib/tenant";

/**
 * Finish, from the day view at /dashboard/bookings. Owners and staff both
 * (S-26). The restaurant comes from the session, the booking from the URL, and a
 * booking of another restaurant is a 404.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/bookings/[bookingId]/finish">,
) {
  const tenant = await getTenantContext();
  const bookingId = await bookingIdFrom(context.params);

  return bookingActionResponse(await finishBooking(tenant, bookingId), request, "Finish");
}
