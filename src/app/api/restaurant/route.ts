import type { NextRequest } from "next/server";
import { FORM_FETCH_HEADER, formSaved } from "@/lib/form-response";
import {
  invalidTimezoneMessage,
  parseRestaurantSettings,
  updateRestaurantSettings,
} from "@/lib/restaurant-settings";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Saves the settings form on /dashboard/settings. Owner only (S-26). */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const settings = parseRestaurantSettings(
    await request.formData().catch(() => new FormData()),
  );
  if (!settings.success) {
    return Response.json({ error: settings.message, field: settings.field }, { status: 400 });
  }

  const outcome = await updateRestaurantSettings(tenant, settings.data);
  if (outcome === "invalid_timezone") {
    return Response.json({ error: invalidTimezoneMessage, field: "timezone" }, { status: 400 });
  }
  // The form says what the save did, so it must be told.
  if (outcome === "saved_booking_off" && request.headers.has(FORM_FETCH_HEADER)) {
    return Response.json({ bookingSwitchedOff: true });
  }

  return formSaved(request, "/dashboard/settings");
}
