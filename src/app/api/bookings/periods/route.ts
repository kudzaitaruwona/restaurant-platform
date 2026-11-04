import type { NextRequest } from "next/server";
import {
  addServicePeriod,
  parseNewPeriod,
  periodOrderMessage,
  periodOverlapMessage,
} from "@/lib/booking-settings";
import { formSaved } from "@/lib/form-response";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Adds a service period, from /dashboard/bookings/settings. Owner only (S-26). */
export async function POST(request: NextRequest) {
  const tenant = await getTenantContext();
  requireOwner(tenant);

  const period = parseNewPeriod(await request.formData().catch(() => new FormData()));
  if (!period.success) {
    return Response.json({ error: period.message }, { status: 400 });
  }

  const outcome = await addServicePeriod(tenant, period.data);
  if (outcome === "overlaps") {
    return Response.json({ error: periodOverlapMessage }, { status: 409 });
  }
  if (outcome === "invalid_times") {
    return Response.json({ error: periodOrderMessage }, { status: 400 });
  }
  return formSaved(request, "/dashboard/bookings/settings");
}
