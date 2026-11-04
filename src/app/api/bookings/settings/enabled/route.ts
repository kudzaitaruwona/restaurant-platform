import type { NextRequest } from "next/server";
import { z } from "zod";
import { enableBlockedMessage, setBookingEnabled } from "@/lib/booking-settings";
import { formSaved } from "@/lib/form-response";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/**
 * Turns online booking on or off, from /dashboard/bookings/settings. Owner only
 * (S-26). Turning it on is refused with a 409 until the restaurant has a service
 * period, a bookable table and a contact phone: Postgres decides.
 */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const form = await request.formData().catch(() => new FormData());
  const enabled = z.enum(["true", "false"]).safeParse(form.get("enabled"));
  if (!enabled.success) {
    return Response.json({ error: "Choose whether online booking is on." }, { status: 400 });
  }

  const result = await setBookingEnabled(tenant, enabled.data === "true");
  if (result.outcome === "blocked") {
    return Response.json({ error: enableBlockedMessage(result.missing) }, { status: 409 });
  }
  return formSaved(request, "/dashboard/bookings/settings");
}
