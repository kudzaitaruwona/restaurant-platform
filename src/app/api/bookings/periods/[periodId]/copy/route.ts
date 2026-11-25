import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import {
  copyOverlapMessage,
  copyServicePeriod,
  parseCopyDays,
  periodIdFrom,
} from "@/lib/booking-settings";
import { formSaved } from "@/lib/form-response";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/**
 * Copies a service period to other weekdays, from /dashboard/bookings/settings.
 * Owner only (S-26). All or none: a day with an overlapping period refuses the
 * whole copy with a 409 that names the days.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/bookings/periods/[periodId]/copy">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const periodId = await periodIdFrom(context.params);

  const days = parseCopyDays(await request.formData().catch(() => new FormData()));
  if (!days.success) {
    return Response.json({ error: days.message }, { status: 400 });
  }

  const result = await copyServicePeriod(tenant, periodId, days.data);
  if (result.outcome === "not_found") notFound();
  if (result.outcome === "no_days") {
    return Response.json({ error: "Choose a day other than this period's own." }, { status: 400 });
  }
  if (result.outcome === "overlaps") {
    return Response.json({ error: copyOverlapMessage(result) }, { status: 409 });
  }
  return formSaved(request, "/dashboard/bookings/settings");
}
