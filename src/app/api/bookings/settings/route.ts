import type { NextRequest } from "next/server";
import { formSaved } from "@/lib/form-response";
import { parseBookingSettings, updateBookingSettings } from "@/lib/booking-settings";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Saves the booking rules, from /dashboard/bookings/settings. Owner only (S-26). */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const settings = parseBookingSettings(await request.formData().catch(() => new FormData()));
  if (!settings.success) {
    return Response.json({ error: settings.message }, { status: 400 });
  }

  await updateBookingSettings(tenant, settings.data);
  return formSaved(request, "/dashboard/bookings/settings");
}
