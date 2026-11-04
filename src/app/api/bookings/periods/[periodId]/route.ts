import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import {
  parsePeriodEdit,
  periodIdFrom,
  periodOrderMessage,
  periodOverlapMessage,
  updateServicePeriod,
} from "@/lib/booking-settings";
import { formSaved } from "@/lib/form-response";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/** Edits a service period's name and times, from /dashboard/bookings/settings. Owner only (S-26). */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/bookings/periods/[periodId]">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const periodId = await periodIdFrom(context.params);

  const edit = parsePeriodEdit(await request.formData().catch(() => new FormData()));
  if (!edit.success) {
    return Response.json({ error: edit.message }, { status: 400 });
  }

  const outcome = await updateServicePeriod(tenant, periodId, edit.data);
  if (outcome === "not_found") notFound();
  if (outcome === "overlaps") {
    return Response.json({ error: periodOverlapMessage }, { status: 409 });
  }
  if (outcome === "invalid_times") {
    return Response.json({ error: periodOrderMessage }, { status: 400 });
  }
  return formSaved(request, "/dashboard/bookings/settings");
}
