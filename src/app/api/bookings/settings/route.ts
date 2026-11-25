import type { NextRequest } from "next/server";
import { confirmationNeeded } from "@/lib/confirm-response";
import { formSaved } from "@/lib/form-response";
import { parseBookingSettings, ruleWarnings, updateBookingSettings } from "@/lib/booking-settings";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Saves the booking rules, from /dashboard/bookings/settings. Owner only (S-26). */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const form = await request.formData().catch(() => new FormData());
  const settings = parseBookingSettings(form);
  if (!settings.success) {
    return Response.json({ error: settings.message }, { status: 400 });
  }
  // A large party's sitting shorter than the normal one: asked about, then saved.
  const ask = await confirmationNeeded(request, form, "/dashboard/bookings/settings", () =>
    ruleWarnings(settings.data),
  );
  if (ask) return ask;

  await updateBookingSettings(tenant, settings.data);
  return formSaved(request, "/dashboard/bookings/settings");
}
