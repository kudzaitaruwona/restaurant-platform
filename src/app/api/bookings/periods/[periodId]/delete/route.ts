import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";
import { deleteServicePeriod, periodIdFrom } from "@/lib/booking-settings";
import { formSaved } from "@/lib/form-response";
import { getTenantContext, requireOwner } from "@/lib/tenant";

/**
 * Deletes a service period, from /dashboard/bookings/settings. Owner only
 * (S-26). Deleting the last one switches online booking off.
 */
export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/bookings/periods/[periodId]/delete">,
) {
  const tenant = await getTenantContext();
  requireOwner(tenant);
  const periodId = await periodIdFrom(context.params);

  if ((await deleteServicePeriod(tenant, periodId)) === "not_found") notFound();
  return formSaved(request, "/dashboard/bookings/settings");
}
